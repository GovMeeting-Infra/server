import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EmailProcessor } from './email.processor';
import { PushProcessor } from './push.processor';

/** Queue and Worker overload on() differently; this is the one both share. */
interface ErrorEmitter {
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/**
 * Logs the email and push queues' connection errors as one line each.
 *
 * Nothing listened for their 'error' events. With no listener, BullMQ falls
 * back to console.error on the raw ioredis error, which includes the command
 * that failed — and when Redis refuses the login, that command is AUTH with
 * the Redis password in it. During the 2026-10-24 Upstash outage that printed
 * the password into the error log on every reconnect, for four days.
 */
@Injectable()
export class QueueErrorsService implements OnApplicationBootstrap {
  private logger = new Logger('QueueErrorsService');

  constructor(
    @InjectQueue('email-queue') private emailQueue: Queue,
    @InjectQueue('push-queue') private pushQueue: Queue,
    private emailProcessor: EmailProcessor,
    private pushProcessor: PushProcessor,
  ) {}

  onApplicationBootstrap() {
    const emitters: [string, ErrorEmitter][] = [
      ['email-queue', this.emailQueue],
      ['push-queue', this.pushQueue],
      ['email worker', this.emailProcessor.worker],
      ['push worker', this.pushProcessor.worker],
    ];

    for (const [label, emitter] of emitters) {
      emitter.on('error', (err: Error) =>
        // The message only: the error object carries the command it failed on.
        this.logger.error(`${label}: ${err.message}`),
      );
    }
  }
}
