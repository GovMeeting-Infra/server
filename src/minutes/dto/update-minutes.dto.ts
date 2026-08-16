import { CreateMinutesDto } from './create-minutes.dto';

/**
 * Identical to the create shape, and deliberately so: every field there is
 * already optional, because the two lists are independent and either may be
 * left alone.
 */
export class UpdateMinutesDto extends CreateMinutesDto {}
