import { IsString, IsInt, IsOptional, IsArray, Min, Max } from 'class-validator';

export class CreateRoomDto {
  @IsString()
  name: string;

  @IsString()
  location: string;

  @IsInt()
  @Min(1)
  @Max(10000)
  capacity: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  amenities?: string[];

  @IsOptional()
  latitude?: number;

  @IsOptional()
  longitude?: number;

  /** Super-admins only; everyone else creates within their own ministry. */
  @IsOptional()
  @IsString()
  ministryId?: string;
}
