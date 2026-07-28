import { SetMetadata } from '@nestjs/common';
import {
  RATE_LIMIT,
  RateLimitConfig,
} from '../guards/check-in-rate-limit.guard';

export const RateLimit = (config: RateLimitConfig) =>
  SetMetadata(RATE_LIMIT, config);
