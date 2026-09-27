import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
// The real AuthService pulls in better-auth's ESM build, which Jest cannot
// load; the gateway only needs getSession, which each test supplies.
jest.mock('../../auth/auth.service', () => ({ AuthService: class {} }));

import { TranscriptionGateway } from '../transcription.gateway';
import { StreamHandlers } from '../providers/transcription-provider';

/**
 * Drives the gateway over a real socket, with the database, auth and provider
 * replaced. What matters here is the plumbing: who gets in, that audio goes
 * straight to the provider, and that stopping flushes before it closes.
 */
describe('TranscriptionGateway', () => {
  const ORIGIN = 'https://calendar.example';
  const USER = { id: 'u1', systemRole: 'STAFF', ministryId: 'm1' };

  let server: Server;
  let gateway: TranscriptionGateway;
  let port: number;
  let auth: any;
  let transcripts: any;
  let handlers: StreamHandlers;
  let stream: any;

  beforeEach(async () => {
    process.env.CORS_ORIGIN = ORIGIN;
    server = createServer();
    auth = { getSession: jest.fn().mockResolvedValue(USER) };
    transcripts = {
      beginSession: jest.fn().mockResolvedValue({
        transcriptId: 't1',
        eventTitle: 'x',
        ministryId: 'm1',
        offsetMs: 0,
        nextOrder: 0,
        audioSeconds: 0,
      }),
      appendSegment: jest
        .fn()
        .mockImplementation(async (_s, seg) => ({ ...seg, order: 0 })),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    stream = {
      send: jest.fn(),
      finish: jest.fn().mockResolvedValue(undefined),
      abort: jest.fn(),
    };
    const provider = {
      name: 'fake',
      openStream: (h: StreamHandlers) => {
        handlers = h;
        return stream;
      },
    };
    gateway = new TranscriptionGateway(
      { httpAdapter: { getHttpServer: () => server } } as any,
      auth,
      transcripts,
      provider,
    );
    gateway.onApplicationBootstrap();
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await gateway.onApplicationShutdown();
    await new Promise((r) => server.close(r));
  });

  const connect = (origin = ORIGIN) =>
    new WebSocket(`ws://localhost:${port}/api/v1/transcription?eventId=e1`, {
      headers: { origin, cookie: 'authToken=tok' },
    });

  const nextMessage = (ws: WebSocket) =>
    new Promise<any>((r) =>
      ws.once('message', (d) => r(JSON.parse(d.toString()))),
    );

  it('refuses a handshake from another site', async () => {
    const ws = connect('https://evil.example');
    const status = await new Promise((r) =>
      ws.on('unexpected-response', (_req, res) => r(res.statusCode)),
    );
    expect(status).toBe(403);
    expect(transcripts.beginSession).not.toHaveBeenCalled();
  });

  it('refuses without a session', async () => {
    auth.getSession.mockResolvedValue(null);
    const ws = connect();
    const status = await new Promise((r) =>
      ws.on('unexpected-response', (_req, res) => r(res.statusCode)),
    );
    expect(status).toBe(401);
  });

  it('tells the organizer why a recording could not start', async () => {
    transcripts.beginSession.mockRejectedValue(
      Object.assign(new Error('Only organizers can record a meeting'), {
        status: 403,
      }),
    );
    const ws = connect();
    const msg = await nextMessage(ws);
    expect(msg).toEqual({
      type: 'error',
      message: 'Only organizers can record a meeting',
      fatal: true,
    });
  });

  it('forwards audio, relays text, and flushes before closing on stop', async () => {
    const ws = connect();
    expect(await nextMessage(ws)).toEqual({
      type: 'ready',
      transcriptId: 't1',
    });

    ws.send(Buffer.from([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 50));
    expect(stream.send).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));

    const finalMsg = nextMessage(ws);
    handlers.onFinal({ text: 'Agreed.', speaker: 0, start: 1, end: 2 });
    expect((await finalMsg).type).toBe('final');

    const stopped = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'stop' }));
    expect(await stopped).toEqual({ type: 'stopped', failed: false });
    expect(stream.finish).toHaveBeenCalled();
    expect(transcripts.endSession).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      { draft: true },
    );
  });

  it('keeps the transcript but does not draft when the browser drops', async () => {
    const ws = connect();
    await nextMessage(ws);
    ws.terminate();
    await new Promise((r) => setTimeout(r, 50));
    expect(transcripts.endSession).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      { draft: false },
    );
  });

  it('allows only one recording per meeting', async () => {
    const first = connect();
    await nextMessage(first);
    const second = connect();
    const msg = await nextMessage(second);
    expect(msg.message).toBe('This meeting is already being recorded');
    first.close();
  });
});
