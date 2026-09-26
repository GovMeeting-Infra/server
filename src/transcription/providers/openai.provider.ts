import { Logger } from '@nestjs/common';
import WebSocket from 'ws';
import { OpusToPcm } from './opus-to-pcm';
import {
  StreamContext,
  StreamHandlers,
  TranscriptionProvider,
  TranscriptionStream,
} from './transcription-provider';

/**
 * OpenAI's live transcription model wants raw PCM at 24 kHz, mono.
 * Its own guide calls for `audio/pcm` at this rate; anything else is refused.
 */
const SAMPLE_RATE = 24_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;

/**
 * How much speech makes one segment.
 *
 * This model has no voice-activity detection, so nothing finalises a piece of
 * text until we commit the audio buffer. Eight seconds is short enough that
 * the transcript keeps up with the room and long enough that sentences are
 * rarely cut in half.
 */
const COMMIT_MS = 8_000;
/** OpenAI rejects a commit with almost nothing in the buffer. */
const MIN_COMMIT_BYTES = Math.round(BYTES_PER_SECOND * 0.2);
/**
 * A realtime session is capped (30 minutes at the time of writing), so the
 * upstream connection is replaced well before that. The browser never notices:
 * it is sending compressed audio into a converter, and PCM has no header to
 * restart, so the swap costs nothing but the commit that precedes it.
 */
const ROTATE_MS = 20 * 60 * 1000;
/** How long finish() waits for the last transcript before giving up. */
const FINISH_TIMEOUT_MS = 10_000;

/**
 * Read per connection rather than at import, so the endpoint can be pointed
 * elsewhere without a redeploy — OpenAI moved this path once already.
 */
export function realtimeUrl(): string {
  return (
    process.env.OPENAI_REALTIME_URL ||
    'wss://api.openai.com/v1/realtime?intent=transcription'
  );
}

/**
 * The opening message of a transcription session.
 *
 * turn_detection is null because this model does not do voice-activity
 * detection — the commits below mark the turns instead.
 */
export function sessionUpdate(model: string, keyterms: string[]) {
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: SAMPLE_RATE },
          transcription: {
            model,
            language: 'en',
            // Names and Krio words the model would otherwise mangle. It has no
            // Krio of its own, so this is the only lever, as with Deepgram.
            ...(keyterms.length ? { prompt: keyterms.join(', ') } : {}),
          },
          turn_detection: null,
        },
      },
    },
  };
}

interface Window {
  start: number;
  end: number;
}

/** What the stream needs of the converter, so a test can stand in for it. */
export interface AudioConverter {
  write(chunk: Buffer): void;
  flush(): Promise<void>;
  destroy(): void;
}

class OpenAiStream implements TranscriptionStream {
  private logger = new Logger('OpenAiProvider');
  private socket: WebSocket | null = null;
  private transcoder: AudioConverter;
  /** PCM waiting for a socket that is still connecting or being replaced. */
  private pending: Buffer[] = [];
  /** Total audio handed to OpenAI, which is this stream's clock. */
  private sentBytes = 0;
  /** Where the audio not yet committed begins, in seconds. */
  private windowStart = 0;
  private uncommittedBytes = 0;
  /** Committed windows awaiting their transcript, oldest first. */
  private windows: Window[] = [];
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private apiKey: string,
    private model: string,
    private keyterms: string[],
    private handlers: StreamHandlers,
    private context: StreamContext,
    makeConverter?: (
      onPcm: (pcm: Buffer) => void,
      onError: (err: Error) => void,
    ) => AudioConverter,
  ) {
    const onPcm = (pcm: Buffer) => this.sendPcm(pcm);
    const onError = (err: Error) => this.handlers.onError(err);
    this.transcoder = makeConverter
      ? makeConverter(onPcm, onError)
      : new OpusToPcm(SAMPLE_RATE, onPcm, onError);
    this.open();
  }

  private open() {
    const socket = new WebSocket(realtimeUrl(), {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        // A stable pseudonym for the organizer, which OpenAI asks for on every
        // realtime request. Hashed by the caller: their user id never leaves.
        'OpenAI-Safety-Identifier': this.context.userRef,
      },
    });
    this.socket = socket;

    socket.on('open', () => {
      socket.send(JSON.stringify(sessionUpdate(this.model, this.keyterms)));
      const queued = this.pending;
      this.pending = [];
      for (const chunk of queued) this.sendPcm(chunk);
    });

    socket.on('message', (data) => this.onMessage(data.toString()));

    socket.on('error', (err) => {
      this.logger.warn(`OpenAI stream error: ${err.message}`);
      this.handlers.onError(err);
    });

    socket.on('close', (code, reason) => {
      if (this.socket !== socket) return; // replaced by a rotation
      if (this.closed) return;
      this.logger.warn(`OpenAI closed ${code} ${reason.toString()}`);
      this.closed = true;
      this.handlers.onClose();
    });
  }

  private onMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'conversation.item.input_audio_transcription.delta': {
        const text = String(msg.delta ?? '').trim();
        if (text) {
          this.handlers.onInterim({
            text,
            speaker: null,
            start: this.windowStart,
            end: this.seconds(),
          });
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = String(msg.transcript ?? '').trim();
        // Completions arrive in the order their audio was committed.
        const window = this.windows.shift();
        if (!text) break;
        this.handlers.onFinal({
          text,
          // This model does not say who spoke. The record shows the words
          // without attributing them rather than guessing.
          speaker: null,
          start: window?.start ?? this.windowStart,
          end: window?.end ?? this.seconds(),
        });
        break;
      }
      case 'error': {
        const message = String(msg.error?.message ?? 'Transcription error');
        this.logger.warn(`OpenAI: ${message}`);
        this.handlers.onError(new Error(message));
        break;
      }
    }
  }

  private seconds() {
    return this.sentBytes / BYTES_PER_SECOND;
  }

  /** Raw audio out of the converter, on its way to OpenAI. */
  private sendPcm(pcm: Buffer) {
    const socket = this.socket;
    if (this.closed) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      // Only while a socket is opening or being swapped. Bounded so a stalled
      // connection cannot grow this without limit.
      if (this.pending.length < 200) this.pending.push(pcm);
      return;
    }
    socket.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: pcm.toString('base64'),
      }),
    );
    this.sentBytes += pcm.length;
    this.uncommittedBytes += pcm.length;
    if (this.uncommittedBytes >= (COMMIT_MS / 1000) * BYTES_PER_SECOND) {
      this.commit();
    }
  }

  /** Close off the audio gathered so far, which is what produces a segment. */
  private commit() {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (this.uncommittedBytes < MIN_COMMIT_BYTES) return;
    const end = this.seconds();
    this.windows.push({ start: this.windowStart, end });
    this.windowStart = end;
    this.uncommittedBytes = 0;
    socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  }

  private scheduleRotation() {
    this.rotateTimer = setTimeout(() => {
      if (this.closed) return;
      this.commit();
      const old = this.socket;
      this.socket = null;
      // Give the last commit a moment to come back before dropping the socket.
      setTimeout(() => old?.close(1000), 2_000);
      this.open();
      this.scheduleRotation();
    }, ROTATE_MS);
  }

  send(chunk: Buffer) {
    if (this.closed) return;
    if (!this.rotateTimer) this.scheduleRotation();
    this.transcoder.write(chunk);
  }

  async finish() {
    if (this.closed) return;
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    // Let the converter hand over the tail of the audio, then commit it, so
    // the last thing said still reaches the transcript.
    await this.transcoder.flush();
    this.commit();

    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN && this.windows.length) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FINISH_TIMEOUT_MS);
        const check = setInterval(() => {
          if (!this.windows.length) {
            clearTimeout(timer);
            clearInterval(check);
            resolve();
          }
        }, 100);
        socket.once('close', () => {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        });
      });
    }
    this.abort();
  }

  abort() {
    this.closed = true;
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    this.rotateTimer = null;
    this.pending = [];
    this.transcoder.destroy();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000);
  }
}

/**
 * OpenAI's realtime speech-to-text.
 *
 * Two things to know against Deepgram: it returns no speaker labels, and
 * OpenAI keeps request data for up to 30 days for abuse monitoring unless the
 * organization has been approved for zero data retention. The audio still
 * exists nowhere on this platform either way.
 */
export class OpenAiProvider implements TranscriptionProvider {
  readonly name = 'openai';

  constructor(
    private apiKey: string,
    private model: string,
    private keyterms: string[],
    /** Tests pass a stand-in so the protocol can be exercised without ffmpeg. */
    private makeConverter?: (
      onPcm: (pcm: Buffer) => void,
      onError: (err: Error) => void,
    ) => AudioConverter,
  ) {}

  openStream(
    handlers: StreamHandlers,
    context: StreamContext,
  ): TranscriptionStream {
    return new OpenAiStream(
      this.apiKey,
      this.model,
      this.keyterms,
      handlers,
      context,
      this.makeConverter,
    );
  }
}
