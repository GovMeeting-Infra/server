import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PushService } from './push.service';

interface PushJob {
  userId: string;
  title: string;
  body: string;
  link: string | null;
  tag: string;
}

/**
 * Delivers the pushes NotificationsService queued.
 *
 * Separate from the email queue so one channel's backlog cannot hold up the
 * other: a push service that has gone slow should not delay an invitation
 * email, and vice versa.
 */
@Processor('push-queue')
export class PushProcessor extends WorkerHost {
  private readonly logger = new Logger(PushProcessor.name);

  constructor(private readonly pushService: PushService) {
    super();
  }

  async process(job: Job<PushJob>): Promise<void> {
    const { userId, title, body, link, tag } = job.data;

    // sendToUser handles its own failures, including deleting endpoints the
    // push service says are gone. It returns how many devices took it, and
    // zero is an ordinary outcome — somebody who turned the preference on and
    // then cleared their browser data has a preference and no devices.
    const delivered = await this.pushService.sendToUser(userId, {
      title,
      body,
      link: link ?? undefined,
      tag,
    });

    if (delivered === 0) {
      this.logger.debug(`No device took push ${tag} for ${userId}`);
    }
  }
}
