import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  UseGuards,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MinutesAccessService } from './minutes-access.service';
import { GuestActionItemDto } from './dto/guest-action-item.dto';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimit } from '../common/decorators/rate-limit.decorator';

/** The points of one kind, already ordered by the query, as plain text. */
function pointsOfType(points: any[], type: string): string[] {
  return (points ?? [])
    .filter((p: any) => p.type === type)
    .map((p: any) => p.text);
}

/**
 * Published minutes for someone with no account.
 *
 * Deliberately carries no guards and no @Roles: RolesGuard only rejects when a
 * handler declares roles, so their absence is what makes these routes public.
 * The token is the credential, exactly as on the check-in and invite routes.
 *
 * Two rules hold this together. Every failure raises the same NotFoundException
 * — unknown token, unpublished minutes, archived minutes — so holding a token
 * reveals nothing about what exists. And the token's own email is the only
 * thing that decides which items may be written, never a value from the body.
 */
@ApiTags('Guest Access')
@Controller('api/v1/guest/minutes')
export class GuestMinutesController {
  constructor(
    private prisma: PrismaService,
    private access: MinutesAccessService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  @Get(':token')
  @UseGuards(RateLimitGuard)
  @RateLimit({ perIp: 60, windowSeconds: 60 })
  async read(@Param('token') token: string) {
    const { email, minutes } = await this.access.resolveToken(token);

    // A hand-written projection rather than minutesService.getMinutes, which
    // returns the drafter's and publisher's email addresses — nothing a guest
    // should receive.
    const actionItems = await (this.prisma as any).actionItem.findMany({
      where: { minutesId: minutes.id },
      select: {
        id: true,
        title: true,
        description: true,
        ownerName: true,
        ownerEmail: true,
        dueDate: true,
        status: true,
        progressNotes: true,
        progressLink: true,
      },
      orderBy: { dueDate: 'asc' },
    });

    return {
      viewerEmail: email,
      event: {
        title: minutes.event.title,
        startAt: minutes.event.startAt,
        endAt: minutes.event.endAt,
        venueName: minutes.event.venueName,
        ministryName: minutes.event.ministry?.name ?? null,
      },
      minutes: {
        decisions: pointsOfType(minutes.points, 'DECISION'),
        nextSteps: pointsOfType(minutes.points, 'NEXT_STEP'),
        publishedAt: minutes.publishedAt,
      },
      // Flagged rather than filtered: the guest sees the whole record, and the
      // flag is what the page uses to decide which rows it may edit.
      actionItems: actionItems.map((i: any) => ({
        ...i,
        isMine:
          !!i.ownerEmail && i.ownerEmail.toLowerCase() === email.toLowerCase(),
      })),
    };
  }

  @Patch(':token/action-items/:actionItemId')
  @UseGuards(RateLimitGuard)
  @RateLimit({ perIp: 20, perToken: 40, windowSeconds: 60 })
  async updateOwnItem(
    @Param('token') token: string,
    @Param('actionItemId') actionItemId: string,
    @Body() dto: GuestActionItemDto,
  ) {
    const { email, minutes } = await this.access.resolveToken(token);

    const item = await (this.prisma as any).actionItem.findFirst({
      // Scoped to this token's minutes, so a valid token cannot be used to
      // reach an item on some other meeting's record.
      where: { id: actionItemId, minutesId: minutes.id },
      select: {
        id: true,
        title: true,
        ownerEmail: true,
        assignedById: true,
        status: true,
      },
    });

    if (!item) {
      throw new NotFoundException('Action item not found');
    }

    if (
      !item.ownerEmail ||
      item.ownerEmail.toLowerCase() !== email.toLowerCase()
    ) {
      throw new ForbiddenException('This action item is not assigned to you');
    }

    const data: any = {};
    if (dto.status !== undefined) {
      data.status = dto.status;
      data.completedAt = dto.status === 'COMPLETED' ? new Date() : null;
    }
    if (dto.progressNotes !== undefined) data.progressNotes = dto.progressNotes;
    if (dto.progressLink !== undefined) data.progressLink = dto.progressLink;

    const updated = await (this.prisma as any).actionItem.update({
      where: { id: actionItemId },
      data,
    });

    await this.audit.log({
      action: 'ACTION_ITEM_UPDATED',
      actionCategory: 'ACTION_ITEM_MANAGEMENT',
      entityType: 'ActionItem',
      entityId: actionItemId,
      entityName: item.title,
      status: 'SUCCESS',
      ministryId: minutes.event.ministryId,
      // No actorId: a guest has no account. The address the token was issued
      // to is the closest thing to an identity here, so it goes in metadata
      // rather than being passed off as a user.
      metadata: { guestEmail: email, changes: dto },
      description: `Guest ${email} updated action item: ${item.title}`,
    });

    if (dto.status && dto.status !== item.status) {
      await this.notifyWatchers(actionItemId, minutes.event, item.assignedById);
    }

    return updated;
  }

  /**
   * Tell the ministry an external item moved.
   *
   * Both the person who raised it and the meeting's organizer, because a guest
   * update is otherwise invisible from inside the platform — nobody would learn
   * of it without going to look.
   */
  private async notifyWatchers(
    actionItemId: string,
    event: any,
    assignedById: string | null,
  ) {
    const targets = new Set(
      [assignedById, event.organizerId].filter(Boolean) as string[],
    );

    for (const userId of targets) {
      await this.notifications.notifyActionItemStatusChangedFor(
        actionItemId,
        userId,
      );
    }
  }
}
