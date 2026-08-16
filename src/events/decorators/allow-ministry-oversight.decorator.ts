import { SetMetadata } from '@nestjs/common';

export const ALLOW_MINISTRY_OVERSIGHT = 'allowMinistryOversight';

/**
 * Widens CanManageEventGuard to accept a minister of the event's own ministry,
 * even when the event has an organizer.
 *
 * The guard already lets ministry-level roles through on events with no
 * organizer, because public activities have nobody to own them. This is the
 * other half: a minister answers for every meeting held under their ministry
 * and has to be able to read its attendance, which the organizer check alone
 * refuses. Opt-in per route, and only on reads — it must not become a way to
 * edit or cancel someone else's meeting.
 */
export const AllowMinistryOversight = () =>
  SetMetadata(ALLOW_MINISTRY_OVERSIGHT, true);
