import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MinutesDrafter } from './minutes-drafter';
import { TranscriptionService } from './transcription.service';

/**
 * Turns a finished transcript into suggested minutes.
 *
 * One at a time and with a long lock: a three-hour meeting is a single large
 * request that can take minutes, and a second worker picking the same job up
 * as "stalled" would pay for it twice. Idle polling is kept as slow as the
 * email queue's, for the same Redis-command budget.
 */
@Processor('ai-queue', {
  concurrency: 1,
  lockDuration: 10 * 60 * 1000,
  drainDelay: 30,
  stalledInterval: 300_000,
})
export class MinutesDraftProcessor extends WorkerHost {
  private logger = new Logger('MinutesDraftProcessor');

  constructor(
    private transcripts: TranscriptionService,
    private drafter: MinutesDrafter,
  ) {
    super();
  }

  async process(job: Job<{ transcriptId: string }>) {
    if (job.name !== 'draft-minutes') return;
    const { transcriptId } = job.data;

    const input = await this.transcripts.loadForDraft(transcriptId);
    if (!input) return; // deleted while queued

    try {
      const draft = await this.drafter.draft(input);
      await this.transcripts.saveDraft(transcriptId, draft);
    } catch (err: any) {
      this.logger.error(`Draft failed for ${transcriptId}: ${err.message}`);
      // Recorded rather than retried: the organizer sees it and can ask again,
      // which is better than a silent second bill for the same failure.
      await this.transcripts.failDraft(
        transcriptId,
        'The AI could not draft minutes from this transcript. Try again, or write them by hand.',
      );
    }
  }
}
