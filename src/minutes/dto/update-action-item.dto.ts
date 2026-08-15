import {
  IsOptional,
  IsString,
  IsDateString,
  IsEnum,
  IsEmail,
  ValidateIf,
} from 'class-validator';

export enum ActionItemPriorityEnum {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

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

  /** What has been done. Overwritten in place, not appended. */
  @IsOptional()
  @IsString()
  progressNotes?: string;

  /**
   * A link to the work. Not @IsUrl: a ministry intranet address may have no
   * public TLD, and rejecting it would block the common case.
   */
  @IsOptional()
  @IsString()
  progressLink?: string;

  @IsOptional()
  @IsString()
  ownerName?: string;

  /** Reassign to someone with no account. Clears ownerId when used. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsEmail()
  ownerEmail?: string | null;

  @IsOptional()
  @IsEnum(ActionItemStatusEnum)
  status?: ActionItemStatusEnum;

  /**
   * The column has existed with a "medium" default since it was added and no
   * client has ever written to it, so every row reads medium today.
   */
  @IsOptional()
  @IsEnum(ActionItemPriorityEnum)
  priority?: ActionItemPriorityEnum;

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
