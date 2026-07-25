import {
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ExternalAttendeeDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}

export class AddAttendeesDto {
  /** Ids of registered users to invite. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  userIds?: string[];

  /** Guests who have no account on the platform. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExternalAttendeeDto)
  externals?: ExternalAttendeeDto[];
}
