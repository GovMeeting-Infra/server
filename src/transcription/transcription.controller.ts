import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { TranscriptionService } from './transcription.service';

/**
 * The text of a recorded meeting. Recording itself happens over the WebSocket
 * in transcription.gateway.ts; this is reading, redrafting and deleting.
 */
@ApiTags('Transcripts')
@ApiBearerAuth()
@Controller('api/v1/events/:eventId/transcript')
@UseGuards(RolesGuard)
export class TranscriptionController {
  constructor(private transcripts: TranscriptionService) {}

  @Get()
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  get(@Param('eventId') eventId: string, @CurrentUser() user: any) {
    return this.transcripts.getTranscript(eventId, user);
  }

  /** Ask the AI for suggested minutes again, e.g. after a failed draft. */
  @Post('draft')
  @HttpCode(202)
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  draft(@Param('eventId') eventId: string, @CurrentUser() user: any) {
    return this.transcripts.requestDraft(eventId, user);
  }

  @Delete()
  @HttpCode(204)
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async remove(@Param('eventId') eventId: string, @CurrentUser() user: any) {
    await this.transcripts.deleteTranscript(eventId, user);
  }
}
