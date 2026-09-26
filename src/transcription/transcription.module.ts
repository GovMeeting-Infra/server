import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
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
import { MINUTES_DRAFTER, MinutesDrafter } from './minutes-drafter';
import { ClaudeDrafter } from './drafters/claude.drafter';
import { OpenAiDrafter } from './drafters/openai.drafter';

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
              // Diarizing by default: speaker labels matter more to a set of
              // minutes than the key-term prompt this model gives up.
              process.env.OPENAI_TRANSCRIBE_MODEL ||
                'gpt-4o-transcribe-diarize',
              keyterms,
            )
          : new DeepgramProvider(process.env.DEEPGRAM_API_KEY ?? '', keyterms);
      },
    },
    {
      provide: MINUTES_DRAFTER,
      // Keys are read on the first draft, not at boot. OpenAI by default so a
      // deployment transcribing with OpenAI needs no second vendor; set
      // MINUTES_DRAFT_PROVIDER=anthropic to have Claude write them instead.
      useFactory: (): MinutesDrafter =>
        process.env.MINUTES_DRAFT_PROVIDER === 'anthropic'
          ? new ClaudeDrafter(() => new Anthropic())
          : new OpenAiDrafter(() => new OpenAI()),
    },
  ],
  controllers: [TranscriptionController],
})
export class TranscriptionModule {}
