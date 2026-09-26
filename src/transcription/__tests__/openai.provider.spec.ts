import { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import {
  AudioConverter,
  OpenAiProvider,
  sessionUpdate,
} from '../providers/openai.provider';
import {
  StreamHandlers,
  StreamSegment,
  TranscriptionStream,
} from '../providers/transcription-provider';

/** 24 kHz mono 16-bit: one second of audio is this many bytes. */
const SECOND = 24_000 * 2;

describe('sessionUpdate', () => {
  it('asks for PCM at the rate the model requires, with no turn detection', () => {
    const input = sessionUpdate('gpt-live-transcribe', []).session.audio.input;
    expect(input.format).toEqual({ type: 'audio/pcm', rate: 24_000 });
    expect(input.transcription.model).toBe('gpt-live-transcribe');
    // Null, not absent: this model has no voice-activity detection, and the
    // provider commits the buffer itself to close each turn.
    expect(input.turn_detection).toBeNull();
  });

  it('passes key terms as a prompt, and omits it when there are none', () => {
    expect(
      (
        sessionUpdate('m', ['Ministry of Health', 'kushe']).session.audio.input
          .transcription as any
      ).prompt,
    ).toBe('Ministry of Health, kushe');
    expect(
      (sessionUpdate('m', []).session.audio.input.transcription as any).prompt,
    ).toBeUndefined();
  });
});

describe('OpenAiProvider stream', () => {
  let server: WebSocketServer;
  let client: WebSocket | null;
  let received: any[];
  let headers: Record<string, string | undefined>;
  /** Stands in for ffmpeg: the bytes written are the "PCM" that goes out. */
  let converter: AudioConverter & { flushed: boolean };
  let handlers: StreamHandlers;
  let finals: StreamSegment[];
  let interims: StreamSegment[];
  let errors: Error[];
  /** Torn down after each test so the fake server can actually close. */
  let opened: TranscriptionStream[];

  beforeEach(async () => {
    received = [];
    finals = [];
    interims = [];
    errors = [];
    client = null;
    opened = [];
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => server.once('listening', r));
    process.env.OPENAI_REALTIME_URL = `ws://localhost:${(server.address() as AddressInfo).port}`;
    server.on('connection', (ws, req) => {
      client = ws;
      headers = req.headers as Record<string, string | undefined>;
      ws.on('message', (d) => received.push(JSON.parse(d.toString())));
    });
    converter = {
      flushed: false,
      write: (chunk: Buffer) => onPcm(chunk),
      flush: async () => {
        converter.flushed = true;
      },
      destroy: () => {},
    };
    handlers = {
      onFinal: (s) => finals.push(s),
      onInterim: (s) => interims.push(s),
      onError: (e) => errors.push(e),
      onClose: () => {},
    };
  });

  afterEach(async () => {
    delete process.env.OPENAI_REALTIME_URL;
    for (const stream of opened) stream.abort();
    // close() alone waits on live sockets, which is what hung this suite.
    for (const socket of server.clients) socket.terminate();
    await new Promise((r) => server.close(r));
  });

  let onPcm: (chunk: Buffer) => void = () => {};

  const openStream = async () => {
    const provider = new OpenAiProvider(
      'sk-test',
      'gpt-live-transcribe',
      ['kushe'],
      (pcm) => {
        onPcm = pcm;
        return converter;
      },
    );
    const stream = provider.openStream(handlers, { userRef: 'hashed-user' });
    opened.push(stream);
    await waitFor(() => received.length >= 1);
    return stream;
  };

  const waitFor = async (done: () => boolean, ms = 2_000) => {
    const until = Date.now() + ms;
    while (!done()) {
      if (Date.now() > until) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  const reply = (msg: object) => client!.send(JSON.stringify(msg));

  it('identifies the caller without sending the API key to the browser', async () => {
    await openStream();
    expect(headers.authorization).toBe('Bearer sk-test');
    // OpenAI requires a stable end-user identifier on realtime requests.
    expect(headers['openai-safety-identifier']).toBe('hashed-user');
    expect(received[0].type).toBe('session.update');
  });

  it('sends audio as base64 and commits once a turn is long enough', async () => {
    const stream = await openStream();

    // Four seconds: below the commit threshold, so nothing is closed off yet.
    stream.send(Buffer.alloc(4 * SECOND));
    await waitFor(() => received.length >= 2);
    expect(received[1]).toEqual({
      type: 'input_audio_buffer.append',
      audio: Buffer.alloc(4 * SECOND).toString('base64'),
    });
    expect(received.some((m) => m.type === 'input_audio_buffer.commit')).toBe(
      false,
    );

    // Past eight seconds the turn is committed.
    stream.send(Buffer.alloc(5 * SECOND));
    await waitFor(() =>
      received.some((m) => m.type === 'input_audio_buffer.commit'),
    );
  });

  it('times each segment from the audio actually sent', async () => {
    const stream = await openStream();
    stream.send(Buffer.alloc(9 * SECOND));
    await waitFor(() =>
      received.some((m) => m.type === 'input_audio_buffer.commit'),
    );

    reply({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'We agreed the budget.',
    });
    await waitFor(() => finals.length === 1);
    expect(finals[0]).toEqual({
      text: 'We agreed the budget.',
      // This model does not tell us who spoke.
      speaker: null,
      start: 0,
      end: 9,
    });

    // The next turn starts where the last one ended.
    stream.send(Buffer.alloc(9 * SECOND));
    await waitFor(
      () =>
        received.filter((m) => m.type === 'input_audio_buffer.commit')
          .length === 2,
    );
    reply({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Next item.',
    });
    await waitFor(() => finals.length === 2);
    expect(finals[1].start).toBe(9);
    expect(finals[1].end).toBe(18);
  });

  it('shows deltas as live captions without saving them', async () => {
    await openStream();
    reply({
      type: 'conversation.item.input_audio_transcription.delta',
      delta: 'We agreed',
    });
    await waitFor(() => interims.length === 1);
    expect(interims[0].text).toBe('We agreed');
    expect(finals).toHaveLength(0);
  });

  it('reports an upstream error to the caller', async () => {
    await openStream();
    reply({ type: 'error', error: { message: 'Invalid API key' } });
    await waitFor(() => errors.length === 1);
    expect(errors[0].message).toBe('Invalid API key');
  });

  it('flushes the converter and commits the tail on finish', async () => {
    const stream = await openStream();
    stream.send(Buffer.alloc(2 * SECOND));
    await waitFor(() => received.length >= 2);

    const finished = stream.finish();
    await waitFor(() =>
      received.some((m) => m.type === 'input_audio_buffer.commit'),
    );
    reply({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Meeting closed.',
    });
    await finished;

    expect(converter.flushed).toBe(true);
    expect(finals.at(-1)?.text).toBe('Meeting closed.');
  });
});
