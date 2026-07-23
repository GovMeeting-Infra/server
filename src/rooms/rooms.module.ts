import { Module } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { BookingsService } from './bookings.service';
import { RoomsController } from './rooms.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  providers: [RoomsService, BookingsService],
  controllers: [RoomsController],
  exports: [RoomsService, BookingsService],
})
export class RoomsModule {}
