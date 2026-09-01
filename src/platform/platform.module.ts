import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PlatformController } from './platform.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { CacheModule } from '../cache/cache.module';

@Module({
  imports: [
    PrismaModule,
    CacheModule,
    BullModule.registerQueue({ name: 'email-queue' }),
  ],
  controllers: [PlatformController],
})
export class PlatformModule {}
