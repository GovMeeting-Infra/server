import { IsOptional, IsString } from 'class-validator';

export class UpdateMinutesDto {
  @IsOptional()
  @IsString()
  body?: string;

  @IsOptional()
  @IsString()
  summary?: string;
}
