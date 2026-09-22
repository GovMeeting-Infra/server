import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { DeepgramProvider } from './providers/deepgram.provider';
import { TRANSCRIPTION_PROVIDER } from './providers/transcription-provider';
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
      useFactory: () =>
        new DeepgramProvider(
          process.env.DEEPGRAM_API_KEY ?? '',
          (process.env.TRANSCRIPTION_KEYTERMS ?? '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        ),
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
