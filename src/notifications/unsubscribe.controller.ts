import {
  Controller,
  Post,
  Body,
  UseGuards,
  BadRequestException,
  HttpCode,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { DIGEST_KIND, verifyEmail } from './unsubscribe.util';

export class UnsubscribeDto {
  @IsEmail()
  email: string;

  @IsString()
  token: string;
}

/**
 * Turning off the weekly summary.
 *
 * Deliberately carries no @Roles: the signature in the link is the credential,
 * as on the check-in and RSVP routes. It has to work without a session,
 * because action items can be owned by people who have no account and they
 * receive the digest too — an opt-out they cannot reach is not an opt-out.
 *
 * The summary is the only thing here that can be switched off. Everything else
 * is operational, and nobody unsubscribes from being told a meeting they are
 * expected at has been cancelled.
 */
@ApiTags('Notifications')
@Controller('api/v1/unsubscribe')
export class UnsubscribeController {
  constructor(private prisma: PrismaService) {}

  @Post('digest')
  @UseGuards(RateLimitGuard)
  @RateLimit({ perIp: 20, windowSeconds: 60 })
  @HttpCode(200)
  async unsubscribeDigest(@Body() dto: UnsubscribeDto) {
    const email = dto.email.trim().toLowerCase();

    if (!verifyEmail(email, dto.token)) {
      // The same message either way. Which half was wrong is not something a
      // caller needs to learn by probing.
      throw new BadRequestException('This unsubscribe link is not valid');
    }

    // Upsert rather than create: unsubscribing twice is the same fact, and a
    // one-click header may well be fired more than once.
    await (this.prisma as any).emailSuppression.upsert({
      where: { email_kind: { email, kind: DIGEST_KIND } },
      update: {},
      create: { email, kind: DIGEST_KIND },
    });

    return { unsubscribed: true, email };
  }
}
