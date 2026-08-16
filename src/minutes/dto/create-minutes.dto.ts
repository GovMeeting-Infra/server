import {
  IsArray,
  IsOptional,
  IsString,
  ArrayMaxSize,
  Length,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Longest a single decision or next step may be. */
export const MAX_POINT_LENGTH = 300;
/** Most lines one meeting can record in either list. */
export const MAX_POINTS = 50;

/**
 * The whole content of a minutes record.
 *
 * Both lists are replaced wholesale rather than patched item by item: a
 * drafter adds three lines, deletes one and reorders the rest before pressing
 * Save once, so position is simply the index in the array and the edit is
 * atomic. Omitting a key leaves that list untouched; sending an empty array
 * clears it.
 *
 * The length cap is the only thing standing between a decision and a
 * paragraph. Raising it far is how this feature reverts to what it replaced.
 */
export class CreateMinutesDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'What the meeting settled, one line each.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_POINTS)
  @IsString({ each: true })
  @Length(3, MAX_POINT_LENGTH, { each: true })
  decisions?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'What happens next, with nobody assigned. Anything with an owner is an action item.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_POINTS)
  @IsString({ each: true })
  @Length(3, MAX_POINT_LENGTH, { each: true })
  nextSteps?: string[];
}
