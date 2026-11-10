import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ministryScope } from '../common/utils/ministry-scope.util';
import {
  ACCEPTED_ACCOUNT,
  matchEveryWord,
  searchWords,
} from '../common/utils/accepted-account.util';

/** Enough to fill a picker without becoming a data dump. */
const MAX_RESULTS = 25;

/**
 * Merges the two halves so neither can crowd the other out.
 *
 * This used to be accounts first, then cut to MAX_RESULTS — so in a ministry
 * with 25 matching accounts, everybody on the uploaded roster was invisible,
 * however exactly they were searched for. Each half is now guaranteed half the
 * list when it has that many, and gives up whatever it does not use.
 */
export function fairMerge<T>(first: T[], second: T[], max: number): T[] {
  const secondTake = Math.min(
    second.length,
    Math.max(max - first.length, Math.ceil(max / 2)),
  );
  const firstTake = Math.min(first.length, max - secondTake);
  return [...first.slice(0, firstTake), ...second.slice(0, secondTake)];
}

/** What a picker renders. `kind` tells the two sources apart. */
interface DirectoryPerson {
  id: string;
  name: string;
  email: string;
  jobTitle: string | null;
  kind: 'account' | 'staff';
}

/**
 * A read-only colleague lookup for assigning work.
 *
 * Deliberately separate from /api/v1/admin/users, which is administrative and
 * restricted to admin roles. Assigning an action item is ordinary staff work,
 * so staff need to see who they can assign to — but only names and job titles
 * within their own ministry, not the full administrative record.
 */
@Controller('api/v1/users')
export class DirectoryController {
  constructor(private prisma: PrismaService) {}

  @Get('directory')
  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  async directory(@CurrentUser() user: any, @Query('q') q?: string) {
    return (this.prisma as any).user.findMany({
      where: {
        ...ministryScope(user),
        active: true,
        deletedAt: null,
        // Colleagues are added to a meeting by account, which is a promise
        // that they can sign in and see it. Somebody still holding an unused
        // invitation cannot; the Guests lookup still finds them, and invites
        // them by email with a link that needs no sign-in.
        ...ACCEPTED_ACCOUNT,
        ...matchEveryWord(searchWords(q), ['name', 'email']),
      },
      select: { id: true, name: true, email: true, jobTitle: true },
      orderBy: { name: 'asc' },
      take: MAX_RESULTS,
    });
  }

  /**
   * The same lookup, widened to people who are on the ministry's staff roster
   * but do not hold an account.
   *
   * Every address in this platform is typed by hand, and in the places that
   * matter most a typo does not bounce — it creates a second person, because
   * attendance is unique on (eventId, guestEmail) and an invitee's
   * externalEmail is the only thing tying them to their RSVP. Letting an
   * organiser pick a colleague off a list is how that stops happening.
   *
   * `sources` selects which halves to return: `accounts`, `staff`, or both.
   * The create-user form wants staff only — offering it somebody who already
   * has an account would be offering a duplicate.
   *
   * The roster is a staging list, not a mirror of the ministry. An entry whose
   * address already belongs to a live account is dropped from the staff half
   * unconditionally, whatever `sources` says, so the list shrinks as people
   * are onboarded instead of showing each of them twice.
   */
  @Get('directory/people')
  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  async people(
    @CurrentUser() user: any,
    @Query('q') q?: string,
    @Query('sources') sources?: string,
  ): Promise<DirectoryPerson[]> {
    const words = searchWords(q);
    const requested = (sources ?? 'accounts,staff')
      .split(',')
      .map((s) => s.trim());
    const wantAccounts = requested.includes('accounts');
    const wantStaff = requested.includes('staff');

    const accounts: DirectoryPerson[] = wantAccounts
      ? (
          await (this.prisma as any).user.findMany({
            where: {
              ...ministryScope(user),
              active: true,
              deletedAt: null,
              ...matchEveryWord(words, ['name', 'email']),
            },
            select: { id: true, name: true, email: true, jobTitle: true },
            orderBy: { name: 'asc' },
            take: MAX_RESULTS,
          })
        ).map((u: any) => ({ ...u, kind: 'account' as const }))
      : [];

    if (!wantStaff) return accounts.slice(0, MAX_RESULTS);

    const entries = await (this.prisma as any).staffDirectoryEntry.findMany({
      where: {
        ...ministryScope(user),
        // Per word, so a full name finds a roster row: first and last names
        // are stored apart, and no one column holds "Abdul Mansaray".
        ...matchEveryWord(words, ['firstName', 'lastName', 'email']),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      // Over-fetched, because the onboarded are filtered out below and a page
      // of results that were all onboarded would otherwise come back empty.
      take: MAX_RESULTS * 2,
    });

    // Onboarded already? Then the account is the person, and the roster row is
    // a leftover.
    //
    // Matched case-insensitively per address rather than with `in`, which is
    // case-sensitive in Postgres. Roster rows are lowercased on write and so
    // are new accounts, but accounts created before that rule are not — and an
    // account this missed would put the same person in the list twice, which
    // is the one thing this endpoint exists to prevent. The OR is bounded by
    // the take above.
    const onboarded = new Set<string>(
      entries.length === 0
        ? []
        : (
            await (this.prisma as any).user.findMany({
              where: {
                deletedAt: null,
                OR: entries.map((e: any) => ({
                  email: { equals: e.email, mode: 'insensitive' },
                })),
              },
              select: { email: true },
            })
          ).map((u: any) => u.email.toLowerCase()),
    );

    const staff: DirectoryPerson[] = entries
      .filter((e: any) => !onboarded.has(e.email.toLowerCase()))
      .map((e: any) => ({
        id: e.id,
        // Some rosters carry only one name.
        name: [e.firstName, e.lastName].filter(Boolean).join(' '),
        email: e.email,
        // The export has no job titles, and inventing one would be worse than
        // the picker showing none.
        jobTitle: null,
        kind: 'staff' as const,
      }));

    // Accounts first in the list, but never at the roster's expense.
    return fairMerge(accounts, staff, MAX_RESULTS);
  }
}
