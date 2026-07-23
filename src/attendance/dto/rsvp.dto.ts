import { IsString, IsEnum } from 'class-validator';

export enum RSVPStatus {
  CONFIRMED = 'CONFIRMED',
  DECLINED = 'DECLINED',
}

export class RSVPDto {
  @IsString()
  @IsEnum(RSVPStatus)
  status: RSVPStatus;
}
