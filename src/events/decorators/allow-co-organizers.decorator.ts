import { SetMetadata } from '@nestjs/common';

export const ALLOW_CO_ORGANIZERS = 'allowCoOrganizers';

/**
 * Widens CanManageEventGuard to accept the event's co-organizers.
 *
 * Opt-in per route rather than on by default: the same guard protects delete,
 * publish and cancel, and co-organizers must not inherit those. Mirrors the
 * `allowCoOrganizer` flag EventsService.assertCanAdminister already uses for
 * the same distinction.
 */
export const AllowCoOrganizers = () => SetMetadata(ALLOW_CO_ORGANIZERS, true);
