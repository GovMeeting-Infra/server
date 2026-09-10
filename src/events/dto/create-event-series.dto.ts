import {
  IsEnum,
  IsOptional,
  IsNumber,
  IsDateString,
  IsNotEmpty,
  Min,
  Max,
  ValidateIf,
} from 'class-validator';
import { MAX_OCCURRENCES } from '../event-series.constants';

export enum FrequencyEnum {
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  WEEKDAYS = 'WEEKDAYS',
  BIWEEKLY = 'BIWEEKLY',
  MONTHLY = 'MONTHLY',
  QUARTERLY = 'QUARTERLY',
  YEARLY = 'YEARLY',
}

export enum EndTypeEnum {
  COUNT = 'COUNT',
  UNTIL = 'UNTIL',
  NEVER = 'NEVER',
}

/**
 * A repeat rule, whole. Sent to set one for the first time or to replace one
 * that exists, so it always carries every field rather than a patch — a rule
 * half-changed is not a state worth being able to express.
 */
export class CreateEventSeriesDto {
  @IsEnum(FrequencyEnum)
  frequency: FrequencyEnum;

  // Meaningless for WEEKDAYS, which always advances one working day, and
  // doubled by BIWEEKLY, which is already a fortnight. The form hides it for
  // both rather than offering a combination that means nothing.
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(52)
  interval?: number;

  @IsEnum(EndTypeEnum)
  endType: EndTypeEnum;

  // Required when the rule ends after a number of occurrences, and capped.
  // Both were missing: `endType: COUNT` with no count validated fine and fell
  // through to a silent default of 52, and `count: 5000` was accepted and
  // created 4,999 rows synchronously inside one request.
  @ValidateIf((o: CreateEventSeriesDto) => o.endType === EndTypeEnum.COUNT)
  @IsNotEmpty({ message: 'Say how many occurrences the series should have' })
  @IsNumber()
  @Min(2, { message: 'A repeating activity needs at least two occurrences' })
  @Max(MAX_OCCURRENCES, {
    message: `A series cannot have more than ${MAX_OCCURRENCES} occurrences`,
  })
  count?: number;

  // Likewise: `endType: UNTIL` with no date validated and produced a series
  // that ran to the ceiling instead of to the date nobody had given.
  @ValidateIf((o: CreateEventSeriesDto) => o.endType === EndTypeEnum.UNTIL)
  @IsNotEmpty({ message: 'Say what date the series should run until' })
  @IsDateString()
  until?: string;
}
