import { Module } from '@nestjs/common';
import { CheckinService } from './checkin.service';
import { RSVPService } from './rsvp.service';
import { QRTokenService } from './qr-token.service';
import { CheckinController } from './checkin.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { CacheModule } from '../cache/cache.module';
import { CheckInRateLimitGuard } from './guards/check-in-rate-limit.guard';

@Module({
  // CacheModule backs the rate limiter on the public check-in routes.
  imports: [PrismaModule, AuditModule, CacheModule],
  providers: [
    CheckinService,
    RSVPService,
    QRTokenService,
    CheckInRateLimitGuard,
  ],
  controllers: [CheckinController],
  exports: [
    CheckinService,
    RSVPService,
    QRTokenService,
  ],
})
export class AttendanceModule {}
