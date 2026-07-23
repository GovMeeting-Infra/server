import { Module } from '@nestjs/common';
import { CheckinService } from './checkin.service';
import { RSVPService } from './rsvp.service';
import { QRTokenService } from './qr-token.service';
import { CheckinController } from './checkin.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  providers: [CheckinService, RSVPService, QRTokenService],
  controllers: [CheckinController],
  exports: [CheckinService, RSVPService, QRTokenService],
})
export class AttendanceModule {}
