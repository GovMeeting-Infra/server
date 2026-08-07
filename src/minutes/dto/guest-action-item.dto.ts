import { IsOptional, IsString, IsEnum } from 'class-validator';
import { ActionItemStatusEnum } from './update-action-item.dto';

/**
 * What a guest may change on an item assigned to them.
 *
 * Deliberately narrower than UpdateActionItemDto: no title, no due date, no
 * reassignment. A guest reports on the work, they do not redefine it — and with
 * forbidNonWhitelisted on, anything else in the body is a 400 rather than a
 * silently ignored field.
 */
export class GuestActionItemDto {
  @IsOptional()
  @IsEnum(ActionItemStatusEnum)
  status?: ActionItemStatusEnum;

  @IsOptional()
  @IsString()
  progressNotes?: string;

  @IsOptional()
  @IsString()
  progressLink?: string;
}
