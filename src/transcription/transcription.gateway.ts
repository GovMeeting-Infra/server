import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import WebSocket, { WebSocketServer } from 'ws';
import { AuthService } from '../auth/auth.service';
import { extractToken } from '../auth/extract-token';
import {
  TRANSCRIPTION_PROVIDER,
  TranscriptionProvider,
  TranscriptionStream,
} from './providers/transcription-provider';
import {
  ActiveSession,
  Recorder,
  TranscriptionService,
} from './transcription.service';

export const TRANSCRIPTION_PATH = '/api/v1/transcription';

/** A meeting that runs longer than this is cut off and can be resumed. */
const MAX_SESSION_MS = 4 * 60 * 60 * 1000;
/** No audio for this long means the tab was left open by mistake. */
const IDLE_MS = 10 * 60 * 1000;
/** Keeps nginx and any NAT between here and the browser from dropping us. */
const PING_MS = 30_000;
/** MediaRecorder chunks at 250ms are a few KB; this is generous. */
const MAX_FRAME_BYTES = 256 * 1024;

/**
 * Where the browser's microphone audio passes through on its way to the
 * speech-to-text provider.
 *
 * Audio lives here only as the frame currently being forwarded. It is not
 * buffered, not written to disk, not logged. The provider stream is opened
 * server-side so the API key never reaches the browser and the no-retention
 * flag cannot be dropped by a modified client.
 *
 * Attached straight to the HTTP server's upgrade event rather than through
 * @nestjs/websockets: this is one endpoint with a binary protocol, and the
 * adapter machinery would be more code than the endpoint.
 *
 * Browser → server: binary audio frames; JSON {type:'stop'}.
 * Server → browser: {type:'ready'|'interim'|'final'|'error'|'stopped', ...}.
 */
@Injectable()
export class TranscriptionGateway
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private logger = new Logger('TranscriptionGateway');
  private wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
  });
  /** One live recording per event; this process is the only one (PM2 fork). */
  private live = new Map<string, () => Promise<void>>();

  constructor(
    private adapterHost: HttpAdapterHost,
    private auth: AuthService,
    private transcripts: TranscriptionService,
    @Inject(TRANSCRIPTION_PROVIDER) private provider: TranscriptionProvider,
  ) {}

  onApplicationBootstrap() {
    const server = this.adapterHost.httpAdapter.getHttpServer();
    server.on(
      'upgrade',
      (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== TRANSCRIPTION_PATH) return;
        this.handleUpgrade(req, socket, head, url).catch((err) => {
          this.logger.error(`Upgrade failed: ${err.message}`);
          reject(socket, 500);
        });
      },
    );
  }

  async onApplicationShutdown() {
    await Promise.all([...this.live.values()].map((end) => end()));
    this.wss.close();
  }

  private async handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
  ) {
    // Browsers send cookies on a cross-site WebSocket handshake and CORS does
    // not apply to it, so without this any page could open a recording in the
    // organizer's name.
    if (!isAllowedOrigin(req.headers.origin)) return reject(socket, 403);

    const token = extractToken(req as any);
    const user = token ? await this.auth.getSession(token) : null;
    if (!user) return reject(socket, 401);

    const eventId = url.searchParams.get('eventId');
    if (!eventId) return reject(socket, 400);

    // Past authentication, refusals are sent as a message over an accepted
    // socket: a browser cannot read the status of a failed handshake, and the
    // organizer needs to be told why nothing is recording.
    let session: ActiveSession;
    let claimed = false;
    try {
      if (this.live.has(eventId)) {
        throw Object.assign(
          new Error('This meeting is already being recorded'),
          { status: 409 },
        );
      }
      // Claimed before the await, so two tabs connecting at once cannot both
      // get past the check above. run() replaces it with the real stopper.
      this.live.set(eventId, () => Promise.resolve());
      claimed = true;
      session = await this.transcripts.beginSession(eventId, user as Recorder);
    } catch (err: any) {
      if (claimed) this.live.delete(eventId);
      const status = err?.status ?? 500;
      const message =
        status === 500 ? 'Could not start the recording' : err.message;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ type: 'error', message, fatal: true }));
        ws.close(4000 + status, message.slice(0, 100));
      });
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) =>
      this.run(ws, eventId, session, user as Recorder),
    );
  }

  private run(
    ws: WebSocket,
    eventId: string,
    session: ActiveSession,
    user: Recorder,
  ) {
    const send = (msg: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    let ended = false;
    let lastAudioAt = Date.now();
    // Segments are written in arrival order; chain the writes so a slow
    // insert can never let a later segment land first.
    let writes = Promise.resolve();

    const stream: TranscriptionStream = this.provider.openStream({
      onFinal: (segment) => {
        writes = writes
          .then(() => this.transcripts.appendSegment(session, segment))
          .then((row) => send({ type: 'final', segment: row }))
          .catch((err) =>
            this.logger.error(`Could not save a segment: ${err.message}`),
          );
      },
      onInterim: (segment) => send({ type: 'interim', segment }),
      onError: () =>
        send({ type: 'error', message: 'Transcription service error' }),
      onClose: () => {
        // The provider hung up on its own; nothing more will be heard.
        if (!ended) void end({ draft: false, failed: true });
      },
    });

    const end = async (opts: { draft: boolean; failed?: boolean }) => {
      if (ended) return;
      ended = true;
      clearInterval(timers);
      clearTimeout(cap);
      this.live.delete(eventId);
      await stream.finish();
      await writes;
      try {
        await this.transcripts.endSession(session, user, opts);
      } catch (err: any) {
        this.logger.error(`Could not close transcript: ${err.message}`);
      }
      send({ type: 'stopped', failed: !!opts.failed });
      ws.close(1000);
    };

    this.live.set(eventId, () => end({ draft: false }));

    const timers = setInterval(() => {
      if (Date.now() - lastAudioAt > IDLE_MS) void end({ draft: false });
      else if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, PING_MS);
    const cap = setTimeout(() => void end({ draft: true }), MAX_SESSION_MS);

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        lastAudioAt = Date.now();
        stream.send(data as Buffer);
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      // Paused in the browser: no audio flows, the provider is kept alive by
      // its own KeepAlive, and this resets the idle clock.
      if (msg?.type === 'heartbeat') lastAudioAt = Date.now();
      if (msg?.type === 'stop') void end({ draft: true });
    });

    // Tab closed or network dropped. Keep what was said; the organizer can
    // reconnect and carry on, and drafting waits for a deliberate stop.
    ws.on('close', () => void end({ draft: false }));
    ws.on('error', () => void end({ draft: false }));

    send({ type: 'ready', transcriptId: session.transcriptId });
  }
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  const allowed = [
    ...(process.env.CORS_ORIGIN || '').split(','),
    process.env.WEB_URL || '',
  ]
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return allowed.includes(origin.replace(/\/$/, ''));
}

function reject(socket: Duplex, status: number) {
  const text: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    500: 'Internal Server Error',
  };
  socket.write(
    `HTTP/1.1 ${status} ${text[status] ?? 'Error'}\r\nConnection: close\r\n\r\n`,
  );
  socket.destroy();
}
