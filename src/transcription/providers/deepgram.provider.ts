import { Logger } from '@nestjs/common';
import WebSocket from 'ws';
import {
  StreamHandlers,
  StreamSegment,
  TranscriptionProvider,
  TranscriptionStream,
} from './transcription-provider';

const LISTEN_URL = 'wss://api.deepgram.com/v1/listen';

/**
 * Deepgram closes a stream that has had no audio for about ten seconds, and a
 * paused recording sends none. A KeepAlive this often holds it open.
 */
const KEEPALIVE_MS = 5_000;

/** How long finish() waits for Deepgram to flush before giving up on it. */
const FINISH_TIMEOUT_MS = 15_000;

/**
 * The query string for every stream this server opens.
 *
 * mip_opt_out is the whole reason this is built here and not in the browser.
 * Deepgram's list price enrols the request in its Model Improvement Program,
 * under which it keeps part of the audio to train on. Opted out, it keeps
 * nothing beyond the life of the request — which is the promise the product
 * makes to everyone in the room. It is not configurable on purpose.
 *
 * No encoding or sample_rate: the browser sends a webm container, and Deepgram
 * reads those from the header.
 */
export function buildListenUrl(keyterms: string[]): string {
  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'en',
    mip_opt_out: 'true',
    diarize: 'true',
    smart_format: 'true',
    punctuate: 'true',
    interim_results: 'true',
    // Long enough that a speaker drawing breath mid-sentence is not split.
    endpointing: '300',
  });
  // Names of ministries and officials, and common Krio words. Nova-3 has no
  // Krio model; this is what nudges it toward the right spelling.
  for (const term of keyterms) params.append('keyterm', term);
  return `${LISTEN_URL}?${params.toString()}`;
}

interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  speaker?: number;
}

interface DeepgramResults {
  type: 'Results';
  is_final: boolean;
  start: number;
  duration: number;
  channel: {
    alternatives: { transcript: string; words?: DeepgramWord[] }[];
  };
}

/**
 * One Results message can hold several speakers; the diarized words say who
 * said which. Split on speaker changes so each segment has a single voice.
 */
export function splitBySpeaker(msg: DeepgramResults): StreamSegment[] {
  const alt = msg.channel?.alternatives?.[0];
  if (!alt || !alt.transcript?.trim()) return [];

  const words = alt.words ?? [];
  if (words.length === 0) {
    return [
      {
        text: alt.transcript.trim(),
        speaker: null,
        start: msg.start,
        end: msg.start + msg.duration,
      },
    ];
  }

  const segments: StreamSegment[] = [];
  for (const w of words) {
    const speaker = w.speaker ?? null;
    const token = w.punctuated_word ?? w.word;
    const last = segments[segments.length - 1];
    if (last && last.speaker === speaker) {
      last.text += ` ${token}`;
      last.end = w.end;
    } else {
      segments.push({ text: token, speaker, start: w.start, end: w.end });
    }
  }
  return segments;
}

export class DeepgramProvider implements TranscriptionProvider {
  readonly name = 'deepgram';
  private logger = new Logger('DeepgramProvider');

  constructor(
    private apiKey: string,
    private keyterms: string[],
  ) {}

  // Takes no StreamContext: Deepgram asks for no end-user identifier.
  openStream(handlers: StreamHandlers): TranscriptionStream {
    const socket = new WebSocket(buildListenUrl(this.keyterms), {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    // Audio that arrives before the socket opens. Memory only, and small: the
    // handshake takes well under a second of 32 kbps audio.
    const pending: Buffer[] = [];
    let lastAudioAt = Date.now();
    let closed = false;
    let resolveFinish: (() => void) | null = null;

    const keepalive = setInterval(() => {
      if (
        socket.readyState === WebSocket.OPEN &&
        Date.now() - lastAudioAt >= KEEPALIVE_MS
      ) {
        socket.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, KEEPALIVE_MS);

    socket.on('open', () => {
      for (const chunk of pending) socket.send(chunk);
      pending.length = 0;
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type !== 'Results') return;
      for (const segment of splitBySpeaker(msg)) {
        if (msg.is_final) handlers.onFinal(segment);
        else handlers.onInterim(segment);
      }
    });

    socket.on('error', (err) => {
      this.logger.warn(`Deepgram stream error: ${err.message}`);
      handlers.onError(err);
    });

    socket.on('close', (code, reason) => {
      closed = true;
      clearInterval(keepalive);
      pending.length = 0;
      if (code !== 1000) {
        this.logger.warn(`Deepgram closed ${code} ${reason.toString()}`);
      }
      resolveFinish?.();
      handlers.onClose();
    });

    return {
      send(chunk: Buffer) {
        if (closed) return;
        lastAudioAt = Date.now();
        if (socket.readyState === WebSocket.OPEN) socket.send(chunk);
        else if (socket.readyState === WebSocket.CONNECTING)
          pending.push(chunk);
      },
      finish() {
        if (closed) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            socket.terminate();
            resolve();
          }, FINISH_TIMEOUT_MS);
          resolveFinish = () => {
            clearTimeout(timer);
            resolve();
          };
          if (socket.readyState === WebSocket.OPEN) {
            // Deepgram answers by sending its remaining finals, then closing.
            socket.send(JSON.stringify({ type: 'CloseStream' }));
          } else {
            socket.terminate();
          }
        });
      },
      abort() {
        pending.length = 0;
        socket.terminate();
      },
    };
  }
}
