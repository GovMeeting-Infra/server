import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { Logger } from '@nestjs/common';

/**
 * Turns the browser's webm/opus frames into the raw PCM some providers
 * require, without the audio ever touching disk.
 *
 * The browser keeps sending compressed audio — about 32 kbps against roughly
 * 384 kbps for raw 24 kHz PCM. On a phone on a Sierra Leone mobile network
 * that difference decides whether a meeting can be recorded at all, so the
 * conversion happens here, on a wired server, rather than on the handset.
 *
 * ffmpeg reads from a pipe and writes to a pipe: nothing is buffered to a
 * file, and killing the process is the end of it.
 */
export class OpusToPcm {
  private logger = new Logger('OpusToPcm');
  private proc: ChildProcessWithoutNullStreams | null = null;
  private failed = false;

  constructor(
    private sampleRate: number,
    private onPcm: (chunk: Buffer) => void,
    private onError: (err: Error) => void,
  ) {}

  private start() {
    const proc = spawn(
      process.env.FFMPEG_PATH || 'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        // Decode as it arrives rather than waiting to fill a buffer, which is
        // what makes live captions live.
        '-fflags',
        'nobuffer',
        '-flags',
        'low_delay',
        '-i',
        'pipe:0',
        '-f',
        's16le',
        '-acodec',
        'pcm_s16le',
        '-ar',
        String(this.sampleRate),
        '-ac',
        '1',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    proc.stdout.on('data', (chunk: Buffer) => this.onPcm(chunk));
    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) this.logger.warn(`ffmpeg: ${text}`);
    });
    proc.on('error', (err) => {
      this.failed = true;
      this.onError(
        new Error(
          err.message.includes('ENOENT')
            ? 'ffmpeg is not installed on the server, so audio cannot be converted for this provider'
            : `Audio conversion failed: ${err.message}`,
        ),
      );
    });
    // EPIPE when the process is gone; the close handler already reported it.
    proc.stdin.on('error', () => {});
    this.proc = proc;
    return proc;
  }

  write(chunk: Buffer) {
    if (this.failed) return;
    const proc = this.proc ?? this.start();
    if (proc.stdin.writable) proc.stdin.write(chunk);
  }

  /** Close the input and resolve once the last decoded audio has come out. */
  flush(): Promise<void> {
    const proc = this.proc;
    if (!proc) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => resolve();
      proc.once('close', done);
      if (proc.stdin.writable) proc.stdin.end();
      // ffmpeg normally exits as soon as its input ends; this is the backstop.
      setTimeout(() => {
        proc.kill('SIGKILL');
        done();
      }, 3_000);
    });
  }

  destroy() {
    this.proc?.kill('SIGKILL');
    this.proc = null;
  }
}
