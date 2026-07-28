import {
  IsString,
  IsDateString,
  IsInt,
  IsEnum,
  IsOptional,
  Min,
} from 'class-validator';

export enum BookingPurposeEnum {
  MEETING = 'MEETING',
  TRAINING = 'TRAINING',
  CONFERENCE = 'CONFERENCE',
  WORKSHOP = 'WORKSHOP',
  INTERVIEW = 'INTERVIEW',
  OTHER = 'OTHER',
}

export class BookRoomDto {
  @IsString()
  roomId: string;

  @IsDateString()
  startTime: string;

  @IsDateString()
  endTime: string;

  @IsEnum(BookingPurposeEnum)
  purpose: BookingPurposeEnum;

  @IsInt()
  @Min(1)
  attendeeCount: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
