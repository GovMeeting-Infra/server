import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PushService } from './push.service';
import {
  CreatePushSubscriptionDto,
  DeletePushSubscriptionDto,
} from './dto/push-subscription.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

const EVERY_SIGNED_IN_ROLE = [
  'STAFF',
  'MINISTRY_ADMIN',
  'MINISTER',
  'SUPER_ADMIN',
  'PLATFORM_ADMIN',
] as const;

/**
 * Registering a browser for push, and telling it whether push exists here.
 *
 * Every route is scoped to the caller's own subscriptions. Platform admins are
 * included for the same reason they are on the notifications controller: the
 * client asks on page load, and a 403 in the corner of the screen forever is
 * worse than an empty answer.
 */
@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('api/v1/notifications/push')
@UseGuards(RolesGuard)
export class PushController {
  constructor(private readonly pushService: PushService) {}

  /**
   * What the client needs before it can subscribe.
   *
   * The VAPID public key is served from here rather than baked into the web
   * bundle as a NEXT_PUBLIC_ variable. It is public by definition — it is
   * handed to the push service on every subscribe — and serving it means
   * rotating the pair is a server restart rather than a web rebuild and
   * redeploy, with no window where the two halves disagree.
   */
  @Get()
  @Roles(...EVERY_SIGNED_IN_ROLE)
  async getStatus(@CurrentUser() user: any) {
    return {
      configured: this.pushService.isConfigured,
      publicKey: this.pushService.isConfigured
        ? (process.env.VAPID_PUBLIC_KEY ?? null)
        : null,
      devices: await this.pushService.countForUser(user.id),
    };
  }

  /** Idempotent: re-subscribing the same browser updates its row. */
  @Post('subscriptions')
  @HttpCode(204)
  @Roles(...EVERY_SIGNED_IN_ROLE)
  async subscribe(
    @CurrentUser() user: any,
    @Body() dto: CreatePushSubscriptionDto,
  ): Promise<void> {
    await this.pushService.saveSubscription(user.id, dto);
  }

  /**
   * Removes one device.
   *
   * A DELETE with a body rather than the endpoint in the path or query: a push
   * endpoint is a long URL containing an opaque token, and putting it in a URL
   * would write it into access logs and browser history.
   */
  @Delete('subscriptions')
  @HttpCode(204)
  @Roles(...EVERY_SIGNED_IN_ROLE)
  async unsubscribe(
    @CurrentUser() user: any,
    @Body() dto: DeletePushSubscriptionDto,
  ): Promise<void> {
    await this.pushService.removeSubscription(user.id, dto.endpoint);
  }
}
