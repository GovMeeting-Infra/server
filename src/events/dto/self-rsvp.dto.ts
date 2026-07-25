import { IsEnum } from 'class-validator';

export enum SelfRsvpStatusEnum {
  CONFIRMED = 'CONFIRMED',
  DECLINED = 'DECLINED',
}

export class SelfRsvpDto {
  @IsEnum(SelfRsvpStatusEnum)
  status: SelfRsvpStatusEnum;
}
