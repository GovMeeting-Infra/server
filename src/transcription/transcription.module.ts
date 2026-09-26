import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { DeepgramProvider } from './providers/deepgram.provider';
import { OpenAiProvider } from './providers/openai.provider';
import {
  TRANSCRIPTION_PROVIDER,
  TranscriptionProvider,
} from './providers/transcription-provider';
import { TranscriptionService } from './transcription.service';
import { TranscriptionGateway } from './transcription.gateway';
import { TranscriptionController } from './transcription.controller';
import { MinutesDraftProcessor } from './minutes-draft.processor';
import { MinutesDrafter } from './minutes-drafter';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    AuthModule,
    BullModule.registerQueue({ name: 'ai-queue' }),
  ],
  providers: [
    TranscriptionService,
    TranscriptionGateway,
    MinutesDraftProcessor,
    {
      provide: TRANSCRIPTION_PROVIDER,
      useFactory: (): TranscriptionProvider => {
        const keyterms = (process.env.TRANSCRIPTION_KEYTERMS ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        // Deepgram unless asked otherwise: it labels speakers, costs about a
        // third as much, and stores nothing once opted out. OpenAI is the
        // alternative to compare it against on real Krio-heavy meetings.
        return process.env.TRANSCRIPTION_PROVIDER === 'openai'
          ? new OpenAiProvider(
              process.env.OPENAI_API_KEY ?? '',
              process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-live-transcribe',
              keyterms,
            )
          : new DeepgramProvider(process.env.DEEPGRAM_API_KEY ?? '', keyterms);
      },
    },
    {
      provide: MinutesDrafter,
      // Reads ANTHROPIC_API_KEY on first draft, not at boot.
      useFactory: () => new MinutesDrafter(() => new Anthropic()),
    },
  ],
  controllers: [TranscriptionController],
})
export class TranscriptionModule {}
