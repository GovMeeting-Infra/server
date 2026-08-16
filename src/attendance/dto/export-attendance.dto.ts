import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const EXPORT_FORMATS = ['csv', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * The five sets the attendees page offers as tabs. Naming them the same way
 * keeps "download what I am looking at" honest.
 */
export const EXPORT_SETS = [
  'checked-in',
  'invited',
  'confirmed',
  'declined',
  'awaiting',
] as const;
export type ExportSet = (typeof EXPORT_SETS)[number];

export class ExportAttendanceDto {
  @ApiProperty({ enum: EXPORT_FORMATS })
  @IsIn(EXPORT_FORMATS)
  format: ExportFormat;

  @ApiProperty({ enum: EXPORT_SETS })
  @IsIn(EXPORT_SETS)
  set: ExportSet;
}
