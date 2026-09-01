// better-auth ships ESM this jest setup cannot parse. It arrives here only
// because importing the controllers pulls their whole constructor graph in —
// which is the point: this test reads the decorators off the real classes, not
// off a copy of them.
jest.mock('better-auth', () => ({ betterAuth: jest.fn(() => ({})) }));
jest.mock('better-auth/crypto', () => ({
  hashPassword: jest.fn(),
  verifyPassword: jest.fn(),
}));
jest.mock('better-auth/plugins', () => ({ admin: jest.fn() }));
jest.mock('better-auth/api', () => ({ APIError: class APIError extends Error {} }));
jest.mock('better-auth/adapters/prisma', () => ({ prismaAdapter: jest.fn() }));

import 'reflect-metadata';

import { MinutesController } from '../../minutes/minutes.controller';
import { MinutesListController } from '../../minutes/minutes-list.controller';
import { ActionItemsController } from '../../minutes/action-items.controller';
import { CheckinController } from '../../attendance/checkin.controller';
import { AttendanceExportController } from '../../attendance/attendance-export.controller';
import { ReportsController } from '../../reports/reports.controller';
import { SearchController } from '../../search/search.controller';
import { EventsController } from '../../events/events.controller';
import { DirectoryController } from '../../users/directory.controller';
import { UploadsController } from '../../uploads/uploads.controller';
import { UsersController } from '../../users/users.controller';
import { MinistriesController } from '../../ministries/ministries.controller';
import { SettingsController } from '../../common/settings/settings.controller';
import { AuditController } from '../../audit/audit.controller';
import { PlatformController } from '../../platform/platform.controller';
import { NotificationsController } from '../../notifications/notifications.controller';

/**
 * What a platform admin can reach is decided by omission: RolesGuard is an
 * allowlist, so a route refuses the role by simply never naming it. That is a
 * good mechanism and a fragile convention — adding one role to one decorator
 * for one convenient reason would hand engineers a ministry's minutes, and
 * nothing else in the codebase would notice.
 *
 * So this reads the real @Roles metadata off the real controllers. It is not a
 * restatement of the design; it fails when the design is edited.
 */
const ROLE = 'PLATFORM_ADMIN';

function rolesFor(controller: any, method: string): string[] | undefined {
  return Reflect.getMetadata('roles', controller.prototype[method]);
}

function methodsOf(controller: any): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter(
    (m) => m !== 'constructor' && typeof controller.prototype[m] === 'function',
  );
}

/** Every controller whose payloads carry meeting content or personal data. */
const CONTENT_CONTROLLERS: Array<[string, any]> = [
  ['MinutesController', MinutesController],
  ['MinutesListController', MinutesListController],
  ['ActionItemsController', ActionItemsController],
  ['CheckinController', CheckinController],
  ['AttendanceExportController', AttendanceExportController],
  ['SearchController', SearchController],
  ['DirectoryController', DirectoryController],
  ['UploadsController', UploadsController],
];

/**
 * Events and reports are partly open, so they are checked route by route rather
 * than wholesale. A platform admin oversees every ministry's calendar and sees
 * the aggregate figures; it runs no meeting and exports no rows about people.
 */
describe('PLATFORM_ADMIN sees the schedule but cannot touch it', () => {
  it.each([
    ['list events', 'list'],
    ['read one event', 'getOne'],
  ])('can %s', (_label, method) => {
    expect(rolesFor(EventsController, method)).toContain(ROLE);
  });

  it('can read the aggregate figures', () => {
    expect(rolesFor(ReportsController, 'getAnalyticsDashboard')).toContain(ROLE);
  });

  it('is refused every other route on those two controllers', () => {
    const READ_ONLY = new Set([
      'EventsController.list',
      'EventsController.getOne',
      'ReportsController.getAnalyticsDashboard',
    ]);
    const leaked: string[] = [];

    for (const [name, controller] of [
      ['EventsController', EventsController],
      ['ReportsController', ReportsController],
    ] as Array<[string, any]>) {
      for (const method of methodsOf(controller)) {
        const id = `${name}.${method}`;
        const roles = rolesFor(controller, method);
        if (READ_ONLY.has(id)) continue;
        // Undecorated counts as a leak here too: no @Roles is open to everyone.
        if (!roles || roles.includes(ROLE)) leaked.push(id);
      }
    }

    expect(leaked).toEqual([]);
  });

  it('cannot export rows about people', () => {
    for (const method of [
      'exportEventsCSV',
      'exportAttendanceCSV',
      'exportActionItemsCSV',
    ]) {
      expect(rolesFor(ReportsController, method)).not.toContain(ROLE);
    }
  });
});

describe('PLATFORM_ADMIN is kept out of ministry content', () => {
  it.each(CONTENT_CONTROLLERS)('%s names it on no route', (_name, controller) => {
    for (const method of methodsOf(controller)) {
      const roles = rolesFor(controller, method);
      if (!roles) continue;
      expect(roles).not.toContain(ROLE);
    }
  });

  it('covers every route on those controllers, not just the decorated ones', () => {
    // A handler with no @Roles is open to everyone, this role included, so the
    // loop above would pass it by rather than catch it.
    //
    // Five routes are undecorated on purpose: the attendee-facing surfaces are
    // reached by people with no account at all, holding a QR or RSVP token that
    // is itself the credential. They are listed by name so that a *new*
    // undecorated route still fails this.
    const PUBLIC_BY_TOKEN = new Set([
      'CheckinController.checkInContext',
      'CheckinController.checkIn',
      'CheckinController.guestCheckIn',
      'CheckinController.rsvpInvitation',
      'CheckinController.rsvpResponse',
    ]);

    const undecorated: string[] = [];
    for (const [name, controller] of CONTENT_CONTROLLERS) {
      for (const method of methodsOf(controller)) {
        const id = `${name}.${method}`;
        if (rolesFor(controller, method) === undefined && !PUBLIC_BY_TOKEN.has(id)) {
          undecorated.push(id);
        }
      }
    }

    expect(undecorated).toEqual([]);
  });

  it('keeps it off the people-bearing audit log, and on the redacted one', () => {
    expect(rolesFor(AuditController, 'list')).not.toContain(ROLE);
    expect(rolesFor(AuditController, 'categories')).not.toContain(ROLE);
    expect(rolesFor(AuditController, 'systemEvents')).toContain(ROLE);
  });
});

describe('PLATFORM_ADMIN reaches provisioning and operations', () => {
  it.each([
    ['create a user', UsersController, 'create'],
    ['list users', UsersController, 'findAll'],
    ['change a role', UsersController, 'updateRole'],
    ['re-send an invite', UsersController, 'reinvite'],
    ['create a ministry', MinistriesController, 'create'],
    ['list ministries', MinistriesController, 'findAll'],
    ['edit a ministry', MinistriesController, 'update'],
    ['read settings', SettingsController, 'findAll'],
    ['change settings', SettingsController, 'update'],
    ['the operations console', PlatformController, 'overview'],
  ])('can %s', (_label, controller, method) => {
    expect(rolesFor(controller, method as string)).toContain(ROLE);
  });

  it.each([
    ['deactivate a user', UsersController, 'setActive'],
    ['revoke sessions', UsersController, 'revokeSessions'],
    ['unlock an account', UsersController, 'unlock'],
    ['erase a user', UsersController, 'anonymize'],
    ['change an email or ministry', UsersController, 'updateDetails'],
    ['delete a ministry', MinistriesController, 'delete'],
  ])('cannot %s', (_label, controller, method) => {
    const roles = rolesFor(controller, method as string);
    expect(roles).toBeDefined();
    expect(roles).not.toContain(ROLE);
  });
});

/**
 * The bell polls on every page and the results page is reachable from the
 * topbar, so getting these two wrong is not a locked door — it is a permanent
 * error in the corner of the screen.
 */
describe('what a platform admin needs in order to use any page at all', () => {
  it('can read its own notifications', () => {
    // Every route there is scoped to the caller's own id, so this is their own
    // (empty) list rather than anyone else's.
    for (const method of methodsOf(NotificationsController)) {
      const roles = rolesFor(NotificationsController, method);
      if (!roles) continue;
      expect(roles).toContain(ROLE);
    }
  });

  it('still cannot search', () => {
    // Search spans events, minutes and people. The topbar hides the box for
    // them; this is why it has to.
    for (const method of methodsOf(SearchController)) {
      expect(rolesFor(SearchController, method)).not.toContain(ROLE);
    }
  });
});
