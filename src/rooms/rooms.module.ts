import { Module } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { BookingsService } from './bookings.service';
import { RoomsController } from './rooms.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { CacheModule } from '../cache/cache.module';

@Module({
  imports: [PrismaModule, AuditModule, CacheModule],
  providers: [RoomsService, BookingsService],
  controllers: [RoomsController],
  exports: [RoomsService, BookingsService],
})
export class RoomsModule {}
