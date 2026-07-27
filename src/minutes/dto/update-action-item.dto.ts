import {
  IsOptional,
  IsString,
  IsDateString,
  IsEnum,
  ValidateIf,
} from 'class-validator';

export enum ActionItemStatusEnum {
  TODO = 'TODO',
  IN_PROGRESS = 'IN_PROGRESS',
  BLOCKED = 'BLOCKED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export class UpdateActionItemDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsEnum(ActionItemStatusEnum)
  status?: ActionItemStatusEnum;

  /**
   * Reassign the item. Pass null to unassign; omit to leave the owner alone —
   * the two are deliberately different, so a partial edit cannot silently
   * clear an assignment.
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  ownerId?: string | null;
}
