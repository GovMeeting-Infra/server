import {
  IsOptional,
  IsString,
  IsDateString,
  IsInt,
  IsEnum,
  Min,
} from 'class-validator';
import { BookingPurposeEnum } from './book-room.dto';

export class UpdateBookingDto {
  @IsOptional()
  @IsDateString()
  startTime?: string;

  @IsOptional()
  @IsDateString()
  endTime?: string;

  @IsOptional()
  @IsEnum(BookingPurposeEnum)
  purpose?: BookingPurposeEnum;

  @IsOptional()
  @IsInt()
  @Min(1)
  attendeeCount?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
