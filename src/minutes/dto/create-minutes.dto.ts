import { IsString, IsOptional } from 'class-validator';

export class CreateMinutesDto {
  @IsString()
  body: string;

  @IsOptional()
  @IsString()
  summary?: string;
}
