import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { AuthController } from './auth.controller';
import { RolesGuard } from './guards/roles.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { MailModule } from '../mail/mail.module';
import { CacheModule } from '../cache/cache.module';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';

@Module({
  // MailModule sends the reset link; CacheModule backs the rate limiter on the
  // unauthenticated reset routes.
  imports: [PrismaModule, AuditModule, MailModule, CacheModule],
  providers: [AuthService, PasswordResetService, RolesGuard, RateLimitGuard],
  controllers: [AuthController],
  exports: [AuthService, RolesGuard],
})
export class AuthModule {}
