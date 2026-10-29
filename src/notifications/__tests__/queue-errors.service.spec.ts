import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import { QueueErrorsService } from '../queue-errors.service';

/**
 * The shape ioredis gives a refused login: the failed command rides along on
 * the error, and the command is AUTH with the password as its argument.
 */
function refusedLogin() {
  return Object.assign(
    new Error('ERR This database has reached current Fixed plan limits'),
    { command: { name: 'auth', args: ['default', 'the-redis-password'] } },
  );
}

describe('QueueErrorsService', () => {
  let emitters: EventEmitter[];
  let logged: jest.SpyInstance;

  beforeEach(() => {
    emitters = [0, 1, 2, 3].map(() => new EventEmitter());
    const [emailQueue, pushQueue, emailWorker, pushWorker] = emitters;
    logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    new QueueErrorsService(
      emailQueue as any,
      pushQueue as any,
      { worker: emailWorker } as any,
      { worker: pushWorker } as any,
    ).onApplicationBootstrap();
  });

  afterEach(() => logged.mockRestore());

  it('listens on both queues and both workers', () => {
    // Without a listener, emitting 'error' throws — and BullMQ's fallback for
    // that is console.error on the whole error object.
    for (const e of emitters) {
      expect(() => e.emit('error', refusedLogin())).not.toThrow();
    }
    expect(logged).toHaveBeenCalledTimes(4);
  });

  it('logs the message and never the command carrying the password', () => {
    emitters[0].emit('error', refusedLogin());

    expect(logged).toHaveBeenCalledWith(
      'email-queue: ERR This database has reached current Fixed plan limits',
    );
    expect(JSON.stringify(logged.mock.calls)).not.toContain(
      'the-redis-password',
    );
  });
});
