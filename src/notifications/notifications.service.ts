import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  NotificationType,
  NotificationPreferences,
  PREFERENCE_FOR,
  DEFAULT_PREFERENCES,
} from './notification-types';

export interface NotificationInput {
  userId: string;
  ministryId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** In-app destination, e.g. /administrative/events/abc. */
  link?: string;
  entityType?: string;
  entityId?: string;
}

/**
 * Dates as a Sierra Leonean civil servant writes them.
 *
 * These titles and bodies are the entire content of the notifications page, and
 * several of them used to leave out the one fact the reader needed — a meeting
 * reminder that did not say when the meeting was, a change notice that did not
 * say what changed. The data was loaded and dropped on the floor.
 */
function onDate(value: Date | string): string {
  return new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function atTime(value: Date | string): string {
  return new Date(value).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function onDateAtTime(value: Date | string): string {
  return `${onDate(value)} at ${atTime(value)}`;
}

/**
 * Status as the board writes it.
 *
 * These were rendered with `.replace('_', ' ').toLowerCase()`, which replaces
 * only the FIRST underscore — fine for IN_PROGRESS, wrong for any future
 * two-underscore status, and lowercase where the board shows title case. The
 * labels here match BOARD_COLUMNS in the web app, so a notification and the
 * column it refers to call the same thing by the same name.
 */
const STATUS_LABELS: Record<string, string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  BLOCKED: 'Blocked',
  COMPLETED: 'Done',
  CANCELLED: 'Cancelled',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replaceAll('_', ' ').toLowerCase();
}

/**
 * When a piece of work is due, or that it is not.
 *
 * An assignment notice that omits the date makes the person open the board to
 * find out whether it matters today.
 */
function dueLine(dueDate: Date | string | null | undefined): string {
  if (!dueDate) return 'No due date set.';
  return `Due ${onDate(dueDate)}.`;
}

/**
 * What actually changed about a meeting, rather than that something did.
 *
 * "The details have changed" sends someone to the event page to diff it against
 * their own memory. Naming the move means most people never need to open it.
 */
function describeChange(
  event: { startAt: Date | string; venueName?: string | null },
  options: { previousStartAt?: Date | null; previousVenueName?: string | null },
): string {
  const parts: string[] = [];

  const movedTime =
    options.previousStartAt &&
    new Date(options.previousStartAt).getTime() !==
      new Date(event.startAt).getTime();

  if (movedTime) {
    parts.push(
      `Now ${onDateAtTime(event.startAt)}, was ${onDateAtTime(options.previousStartAt!)}.`,
    );
  }

  const movedVenue =
    options.previousVenueName !== undefined &&
    options.previousVenueName !== null &&
    options.previousVenueName !== event.venueName;

  if (movedVenue) {
    parts.push(
      event.venueName
        ? `Now in ${event.venueName}, was ${options.previousVenueName}.`
        : `No longer in ${options.previousVenueName}.`,
    );
  }

  // The caller reports a change without saying which field, which happens when
  // something other than time or venue was edited. Better to admit that than to
  // name a change we cannot describe.
  if (parts.length === 0) {
    return `It is still ${onDateAtTime(event.startAt)}. Open it to see what was edited.`;
  }

  return parts.join(' ');
}

interface Recipient {
  userId: string;
  ministryId: string | null;
}

@Injectable()
export class NotificationsService {
  private logger = new Logger('NotificationsService');

  constructor(
    private prisma: PrismaService,
    @InjectQueue('email-queue') private emailQueue: Queue,
  ) {}

  /**
   * Queue an email, swallowing failures.
   *
   * A notification is a side effect of doing something else — assigning work,
   * publishing minutes — and Redis being unreachable must not fail that action.
   */
  private async enqueueEmail(name: string, data: any, jobId: string) {
    try {
      await this.emailQueue.add(name, data, {
        // A stable id, so the same assignment queued twice sends once.
        jobId,
        removeOnComplete: { age: 2 * 60 * 60 },
        removeOnFail: { age: 2 * 60 * 60 },
      });
    } catch (error) {
      this.logger.error(`Failed to queue ${name}`, error);
    }
  }

  /**
   * Queue several emails in one round trip.
   *
   * One `add` per recipient in a loop was N Redis commands on a bill that
   * charges per command, and N sequential awaits on a hosted connection.
   */
  private async enqueueEmails(
    jobs: { name: string; data: any; jobId: string }[],
  ) {
    if (jobs.length === 0) return;
    try {
      await this.emailQueue.addBulk(
        jobs.map((j) => ({
          name: j.name,
          data: j.data,
          opts: {
            jobId: j.jobId,
            removeOnComplete: { age: 2 * 60 * 60 },
            removeOnFail: { age: 2 * 60 * 60 },
          },
        })),
      );
    } catch (error) {
      this.logger.error(`Failed to queue ${jobs.length} emails`, error);
    }
  }

  // ==========================================================================
  // Preferences
  // ==========================================================================

  /**
   * Preferences for a set of users, falling back to the schema defaults where
   * no row exists. One query regardless of recipient count, because publishing
   * minutes fans out across every attendee.
   */
  private async preferencesFor(userIds: string[]) {
    const rows = await (this.prisma as any).userPreferences.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        emailNotifications: true,
        minutesNotifications: true,
        actionItemNotifications: true,
        meetingReminders: true,
      },
    });

    const byUser = new Map<string, NotificationPreferences>(
      rows.map((r: any) => [r.userId, r]),
    );

    return (userId: string) => byUser.get(userId) ?? DEFAULT_PREFERENCES;
  }

  /** Whether this user wants an in-app notification of this kind. */
  async wantsInApp(userId: string, type: NotificationType): Promise<boolean> {
    const lookup = await this.preferencesFor([userId]);
    return lookup(userId)[PREFERENCE_FOR[type]] !== false;
  }

  /**
   * Whether this user wants an email of this kind.
   *
   * Two gates: emailNotifications is the master switch for email as a channel,
   * and the category toggle applies to the subject regardless of channel.
   */
  async wantsEmail(userId: string, type: NotificationType): Promise<boolean> {
    const lookup = await this.preferencesFor([userId]);
    const prefs = lookup(userId);
    return (
      prefs.emailNotifications !== false &&
      prefs[PREFERENCE_FOR[type]] !== false
    );
  }

  // ==========================================================================
  // Raising notifications
  // ==========================================================================

  /**
   * Writes one notification, honouring the recipient's preferences.
   *
   * Never throws: a notification is a side effect of some other action, and
   * failing to record one must not roll back publishing minutes or inviting
   * someone to a meeting.
   */
  async notify(input: NotificationInput): Promise<boolean> {
    const [created] = await this.notifyMany(
      [{ userId: input.userId, ministryId: input.ministryId }],
      input,
    );
    return created;
  }

  /**
   * Writes notifications for several recipients at once.
   *
   * Returns a boolean per recipient, in order, so callers can log how many were
   * suppressed by preference rather than lost.
   */
  async notifyMany(
    recipients: Recipient[],
    payload: Omit<NotificationInput, 'userId' | 'ministryId'>,
  ): Promise<boolean[]> {
    if (recipients.length === 0) return [];

    try {
      // No filtering. Platform mail and its in-app twin are part of the
      // service now, and the four Settings toggles that gated this were
      // removed rather than left as switches that saved and did nothing. The
      // weekly summary is the one thing anyone can turn off, and it is
      // suppressed by address rather than by preference — see
      // unsubscribe.controller.
      //
      // Two things the gating did quietly go with it: turning off "Meeting
      // reminders" also stopped invitations, because they shared a key; and
      // anyone without a ministry was dropped, so super admins received
      // nothing at all.
      const wanted = recipients;

      if (wanted.length > 0) {
        await (this.prisma as any).notification.createMany({
          data: wanted.map((r) => ({
            userId: r.userId,
            ministryId: r.ministryId ?? null,
            type: payload.type,
            title: payload.title,
            body: payload.body,
            link: payload.link ?? null,
            entityType: payload.entityType ?? null,
            entityId: payload.entityId ?? null,
          })),
        });
      }

      const suppressed = recipients.length - wanted.length;
      if (suppressed > 0) {
        this.logger.log(
          `${payload.type}: notified ${wanted.length}, suppressed ${suppressed} by preference`,
        );
      }

      const sent = new Set(wanted.map((r) => r.userId));
      return recipients.map((r) => sent.has(r.userId));
    } catch (error) {
      this.logger.error(`Failed writing ${payload.type} notifications`, error);
      return recipients.map(() => false);
    }
  }

  // ==========================================================================
  // Producers
  // ==========================================================================

  async notifyMinutesPublished(eventId: string) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        title: true,
        ministryId: true,
        attendees: { select: { userId: true } },
      },
    });

    if (!event) {
      this.logger.warn(`Event ${eventId} not found for minutes notification`);
      return;
    }

    const recipients: Recipient[] = event.attendees
      .filter((a: any) => a.userId)
      .map((a: any) => ({ userId: a.userId, ministryId: event.ministryId }));

    await this.notifyMany(recipients, {
      type: 'MINUTES_PUBLISHED',
      title: `Minutes are up for ${event.title}`,
      body: 'You attended, so check the actions recorded against your name.',
      link: `/administrative/events/${eventId}/minutes`,
      entityType: 'Event',
      entityId: eventId,
    });
  }

  /**
   * Tell the owner an item is theirs, in-app and by email.
   *
   * Previously this returned early whenever ownerId was null and never sent
   * mail at all, so an item assigned to someone without an account reached
   * nobody by any route. An owner recorded only as a name and email has no
   * inbox in the app, so email is the whole channel for them.
   */
  async notifyActionItemAssigned(actionItemId: string) {
    const item = await (this.prisma as any).actionItem.findUnique({
      where: { id: actionItemId },
      select: {
        id: true,
        title: true,
        dueDate: true,
        ownerId: true,
        ownerEmail: true,
        owner: { select: { ministryId: true } },
      },
    });

    if (!item) return;
    if (!item.ownerId && !item.ownerEmail) return;

    if (item.ownerId) {
      await this.notify({
        userId: item.ownerId,
        ministryId: item.owner?.ministryId ?? undefined,
        type: 'ACTION_ITEM_ASSIGNED',
        // Title and body used to say the same thing twice, and neither named
        // the due date. The email version got this right all along.
        title: `Assigned to you: ${item.title}`,
        body: dueLine(item.dueDate),
        link: `/administrative/action-items?item=${actionItemId}`,
        entityType: 'ActionItem',
        entityId: actionItemId,
      });
    }

    await this.enqueueEmail(
      'send-action-item-assigned',
      { itemId: actionItemId },
      `action-item-assigned:${actionItemId}:${item.ownerId ?? item.ownerEmail}`,
    );
  }

  /** The in-app half of the due-soon reminder; the email half is the cron's. */
  async notifyActionItemDueSoon(actionItemId: string) {
    const item = await (this.prisma as any).actionItem.findUnique({
      where: { id: actionItemId },
      select: {
        id: true,
        title: true,
        dueDate: true,
        ownerId: true,
        owner: { select: { ministryId: true } },
      },
    });

    if (!item?.ownerId) return;

    await this.notify({
      userId: item.ownerId,
      ministryId: item.owner?.ministryId ?? undefined,
      type: 'ACTION_ITEM_DUE_SOON',
      // The cron matches the calendar day the item is due, so "soon" always
      // meant today — and a civil servant reading "due soon" at 08:00 had no
      // way to know that.
      title: `Due today: ${item.title}`,
      body: `Set for ${onDate(item.dueDate)}.`,
      link: `/administrative/action-items?item=${actionItemId}`,
      entityType: 'ActionItem',
      entityId: actionItemId,
    });
  }

  /** One Monday summary per person, however many items they owe. */
  async notifyActionItemWeeklyDigest(
    userId: string,
    ministryId: string | null,
    openCount: number,
  ) {
    await this.notify({
      userId,
      ministryId: ministryId ?? (undefined as any),
      type: 'ACTION_ITEM_WEEKLY_DIGEST',
      title: 'What is still open',
      body:
        openCount === 1
          ? 'One action item to carry into this week.'
          : `${openCount} action items to carry into this week.`,
      // The whole board on purpose: a digest is about the set, not one item.
      link: '/administrative/action-items',
    });
  }

  /**
   * Tell one named person an item moved, whoever owns it.
   *
   * notifyActionItemStatusChanged only ever targets the owner, which is no use
   * when the owner is an external guest with no account — the people who need
   * telling are the ones inside the ministry watching the work.
   */
  async notifyActionItemStatusChangedFor(actionItemId: string, userId: string) {
    const [item, user] = await Promise.all([
      (this.prisma as any).actionItem.findUnique({
        where: { id: actionItemId },
        select: { title: true, status: true, ownerName: true },
      }),
      (this.prisma as any).user.findUnique({
        where: { id: userId },
        select: { ministryId: true },
      }),
    ]);

    if (!item || !user) return;

    const who = item.ownerName ? `${item.ownerName} ` : '';
    await this.notify({
      userId,
      ministryId: user.ministryId ?? (undefined as any),
      type: 'ACTION_ITEM_STATUS_CHANGED',
      title: `${who}moved "${item.title}" to ${statusLabel(item.status)}`,
      body: 'For your awareness.',
      link: `/administrative/action-items?item=${actionItemId}`,
      entityType: 'ActionItem',
      entityId: actionItemId,
    });
  }

  async notifyActionItemStatusChanged(actionItemId: string, newStatus: string) {
    const item = await (this.prisma as any).actionItem.findUnique({
      where: { id: actionItemId },
      select: {
        id: true,
        title: true,
        ownerId: true,
        owner: { select: { ministryId: true } },
      },
    });

    if (!item?.ownerId) return;

    await this.notify({
      userId: item.ownerId,
      ministryId: item.owner?.ministryId ?? undefined,
      type: 'ACTION_ITEM_STATUS_CHANGED',
      title: `"${item.title}" moved to ${statusLabel(newStatus)}`,
      body: 'Changed by someone else on the item.',
      link: `/administrative/action-items?item=${actionItemId}`,
      entityType: 'ActionItem',
      entityId: actionItemId,
    });
  }

  /**
   * A task closed, told to the people with a stake in it.
   *
   * The owner, whoever raised it, anyone helping, and the organizer of the
   * meeting it came from — deduplicated, and never the person who just made
   * the change. Everyone else who attended sees it in the Monday summary:
   * mailing forty people because one task closed is how a platform teaches
   * its users to filter its mail.
   */
  async notifyActionItemCompleted(actionItemId: string, actorId: string) {
    const item = await (this.prisma as any).actionItem.findUnique({
      where: { id: actionItemId },
      select: {
        title: true,
        ownerName: true,
        ownerEmail: true,
        owner: { select: { id: true, name: true, email: true, ministryId: true } },
        assignedBy: {
          select: { id: true, name: true, email: true, ministryId: true },
        },
        assistants: {
          select: {
            user: { select: { id: true, name: true, email: true, ministryId: true } },
          },
        },
        minutes: {
          select: {
            event: {
              select: {
                title: true,
                organizer: {
                  select: { id: true, name: true, email: true, ministryId: true },
                },
              },
            },
          },
        },
      },
    });

    if (!item) return;

    const people = [
      item.owner,
      item.assignedBy,
      ...item.assistants.map((a: any) => a.user),
      item.minutes?.event?.organizer,
    ].filter(Boolean) as {
      id: string;
      name: string;
      email: string;
      ministryId: string | null;
    }[];

    // An owner with no account still needs telling; they have no id to
    // deduplicate on, so they are added by address.
    const byKey = new Map<string, { id: string | null; name: string; email: string; ministryId: string | null }>();
    for (const p of people) {
      if (p.id === actorId) continue;
      if (!p.email) continue;
      byKey.set(p.id, p);
    }
    if (!item.owner && item.ownerEmail) {
      byKey.set(item.ownerEmail.toLowerCase(), {
        id: null,
        name: item.ownerName ?? 'Colleague',
        email: item.ownerEmail,
        ministryId: null,
      });
    }

    const recipients = [...byKey.values()];
    if (recipients.length === 0) return;

    await this.notifyMany(
      recipients
        .filter((r) => r.id)
        .map((r) => ({ userId: r.id as string, ministryId: r.ministryId })),
      {
        type: 'ACTION_ITEM_STATUS_CHANGED',
        title: `Done: ${item.title}`,
        body: 'Closed out, nothing further needed.',
        link: `/administrative/action-items?item=${actionItemId}`,
        entityType: 'ActionItem',
        entityId: actionItemId,
      },
    );

    await this.enqueueEmails(
      recipients.map((r) => ({
        name: 'send-action-item-completed',
        data: { itemId: actionItemId, email: r.email, name: r.name },
        jobId: `action-item-completed:${actionItemId}:${r.id ?? r.email.toLowerCase()}`,
      })),
    );
  }

  /** Told to the person a task was taken from; the new owner gets the assignment mail. */
  async notifyActionItemUnassigned(
    actionItemId: string,
    previous: { id: string | null; name: string; email: string; ministryId?: string | null },
    newOwnerName: string | null,
  ) {
    if (!previous.email) return;

    if (previous.id && previous.ministryId) {
      // Loaded for its title. The notice named neither the item nor anything
      // else identifying — "An action item assigned to you has been passed to
      // Aminata" left the reader guessing which of theirs had moved.
      const item = await (this.prisma as any).actionItem.findUnique({
        where: { id: actionItemId },
        select: { title: true },
      });

      await this.notify({
        userId: previous.id,
        ministryId: previous.ministryId,
        type: 'ACTION_ITEM_ASSIGNED',
        title: item ? `No longer yours: ${item.title}` : 'No longer yours',
        body: newOwnerName
          ? `Passed to ${newOwnerName}. Nothing further needed from you.`
          : 'Unassigned. Nothing further needed from you.',
        link: `/administrative/action-items?item=${actionItemId}`,
        entityType: 'ActionItem',
        entityId: actionItemId,
      });
    }

    await this.enqueueEmail(
      'send-action-item-unassigned',
      {
        itemId: actionItemId,
        email: previous.email,
        name: previous.name,
        newOwnerName,
      },
      `action-item-unassigned:${actionItemId}:${previous.email.toLowerCase()}:${Date.now()}`,
    );
  }

  /**
   * A meeting was cancelled or its details moved.
   *
   * The only email here whose absence had a physical cost: nothing told anyone
   * a meeting was called off, so people travelled to it.
   */
  async notifyMeetingChanged(
    eventId: string,
    options: {
      cancelled: boolean;
      previousStartAt?: Date | null;
      previousVenueName?: string | null;
    },
  ) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      select: {
        title: true,
        ministryId: true,
        // Needed to say what the meeting moved *to*. The previous values were
        // already being passed in and forwarded to the email while the in-app
        // notice said only that "details have changed".
        startAt: true,
        venueName: true,
        attendees: {
          // Somebody who declined does not need chasing about a meeting they
          // already said no to.
          where: { status: { not: 'DECLINED' } },
          select: {
            externalName: true,
            externalEmail: true,
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });

    if (!event) return;

    const recipients = event.attendees
      .map((a: any) => ({
        id: a.user?.id ?? null,
        name: a.user?.name ?? a.externalName ?? 'Colleague',
        email: a.user?.email ?? a.externalEmail ?? null,
      }))
      .filter((r: any) => r.email);

    if (recipients.length === 0) return;

    await this.notifyMany(
      recipients
        .filter((r: any) => r.id)
        .map((r: any) => ({ userId: r.id, ministryId: event.ministryId })),
      {
        // Its own kind. Filed as MEETING_INVITATION, a cancellation would be
        // offered under "invitations" by any filter, and shown with the icon
        // of the thing it cancels.
        type: options.cancelled ? 'MEETING_CANCELLED' : 'MEETING_CHANGED',
        title: options.cancelled
          ? `${event.title} is cancelled`
          : `${event.title} has moved`,
        body: options.cancelled
          ? `It was set for ${onDateAtTime(event.startAt)}. You do not need to attend.`
          : describeChange(event, options),
        link: `/administrative/events/${eventId}`,
        entityType: 'Event',
        entityId: eventId,
      },
    );

    await this.enqueueEmails(
      recipients.map((r: any) => ({
        name: 'send-meeting-changed',
        data: {
          eventId,
          email: r.email,
          name: r.name,
          cancelled: options.cancelled,
          previousStartAt: options.previousStartAt?.toISOString() ?? null,
          previousVenueName: options.previousVenueName ?? null,
        },
        // Stamped, because a meeting can move more than once and each move is
        // its own thing to be told about.
        jobId: `meeting-changed:${eventId}:${r.id ?? r.email.toLowerCase()}:${Date.now()}`,
      })),
    );
  }

  async notifyMeetingInvitation(eventId: string, userIds: string[]) {
    if (userIds.length === 0) return;

    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        title: true,
        startAt: true,
        venueName: true,
        ministryId: true,
      },
    });

    if (!event) return;

    await this.notifyMany(
      userIds.map((userId) => ({ userId, ministryId: event.ministryId })),
      {
        type: 'MEETING_INVITATION',
        // The meeting's name, in the title. The longest title in the set used
        // to be "You have been invited to a meeting", which is the one line
        // that carries no information about which meeting.
        title: `Invitation: ${event.title}`,
        body: event.venueName
          ? `${onDateAtTime(event.startAt)}, ${event.venueName}.`
          : `${onDateAtTime(event.startAt)}.`,
        link: `/administrative/events/${eventId}`,
        entityType: 'Event',
        entityId: eventId,
      },
    );
  }

  async notifyMeetingReminder(eventId: string, userId: string) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        title: true,
        startAt: true,
        venueName: true,
        ministryId: true,
      },
    });

    if (!event) return;

    await this.notify({
      userId,
      ministryId: event.ministryId,
      type: 'MEETING_REMINDER',
      // The most urgent message the platform sends, and it used to contain
      // neither the time nor the place: "starts within the hour" is anywhere
      // between four minutes and fifty-nine, and the person reading it is
      // deciding whether to leave their desk now.
      title: `${event.title} starts at ${atTime(event.startAt)}`,
      body: event.venueName
        ? `${event.venueName}. Check in when you arrive.`
        : 'Check in when you arrive.',
      link: `/administrative/events/${eventId}`,
      entityType: 'Event',
      entityId: eventId,
    });
  }

  // ==========================================================================
  // Reading
  // ==========================================================================

  /**
   * How many are actually unread.
   *
   * The bell derived its badge from the length of the preview list it had
   * already capped at six, so someone with forty unread notifications saw "6",
   * and the button announced "6 unread" to a screen reader. A badge that
   * silently plateaus stops carrying information within a week, and people
   * learn to ignore it.
   */
  async countUnread(userId: string): Promise<number> {
    return (this.prisma as any).notification.count({
      where: { userId, read: false },
    });
  }

  /**
   * A page of someone's notifications, newest first.
   *
   * `total` comes back alongside the rows because the page cannot otherwise
   * tell whether it is showing everything: it used to render 50 rows with no
   * indication that a fifty-first existed, and nothing anywhere deletes an
   * unread notification, so a backlog could sit permanently out of reach.
   */
  async getUserNotifications(
    userId: string,
    limit = 20,
    includeRead = false,
    skip = 0,
  ) {
    const where: any = { userId };
    if (!includeRead) where.read = false;

    const [items, total] = await Promise.all([
      (this.prisma as any).notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      (this.prisma as any).notification.count({ where }),
    ]);

    return { items, total, skip, limit };
  }

  /**
   * Scoped to the owner, not just the id.
   *
   * These took a bare id and updated it, so any signed-in user could mark or
   * delete anyone else's notifications by guessing or reading an id. The
   * ownership test lives in the where clause rather than a separate read, so
   * there is no window between checking and writing.
   *
   * A row belonging to someone else raises the same NotFoundException as one
   * that does not exist — the distinction is not the caller's to learn.
   */
  async markAsRead(notificationId: string, userId: string) {
    const { count } = await (this.prisma as any).notification.updateMany({
      where: { id: notificationId, userId },
      data: { read: true, readAt: new Date() },
    });

    if (count === 0) {
      throw new NotFoundException('Notification not found');
    }

    return { success: true };
  }

  async markAllAsRead(userId: string) {
    return (this.prisma as any).notification.updateMany({
      where: { userId, read: false },
      data: { read: true, readAt: new Date() },
    });
  }

  /** Owner-scoped, for the same reason as markAsRead. */
  async deleteNotification(notificationId: string, userId: string) {
    const { count } = await (this.prisma as any).notification.deleteMany({
      where: { id: notificationId, userId },
    });

    if (count === 0) {
      throw new NotFoundException('Notification not found');
    }

    return { success: true };
  }

  async deleteAllUserNotifications(userId: string) {
    return (this.prisma as any).notification.deleteMany({ where: { userId } });
  }
}
