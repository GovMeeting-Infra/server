import { IsNotEmpty, IsObject, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';

/**
 * The encryption keys half of PushSubscription.toJSON().
 *
 * These are the browser's, not ours: everything sent is encrypted to them, so
 * the push service in the middle relays a payload it cannot read.
 */
export class PushSubscriptionKeysDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  p256dh!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  auth!: string;
}

/**
 * Exactly what `PushSubscription.toJSON()` produces in the browser, plus the
 * user agent so somebody can tell one of their own devices from another.
 */
export class CreatePushSubscriptionDto {
  /**
   * The push service URL. Validated as a URL and length-capped because it is
   * supplied by the client, stored, and later fetched by our own server — an
   * unchecked one is a request we would make on request.
   */
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(1000)
  endpoint!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => PushSubscriptionKeysDto)
  keys!: PushSubscriptionKeysDto;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  userAgent?: string;
}

export class DeletePushSubscriptionDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(1000)
  endpoint!: string;
}
