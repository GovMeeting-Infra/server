import { IsEnum, IsOptional, IsNumber, IsDateString, Min } from 'class-validator';

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

export class CreateEventSeriesDto {
  @IsEnum(FrequencyEnum)
  frequency: FrequencyEnum;

  @IsOptional()
  @IsNumber()
  @Min(1)
  interval?: number;

  @IsEnum(EndTypeEnum)
  endType: EndTypeEnum;

  @IsOptional()
  @IsNumber()
  @Min(1)
  count?: number;

  @IsOptional()
  @IsDateString()
  until?: string;
}
