import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ministryScope } from '../common/utils/ministry-scope.util';

const LIMIT = 20;
const MIN_QUERY = 2;

const ADMIN_ROLES = ['SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN'];

@Injectable()
export class SearchService {
  constructor(private prisma: PrismaService) {}

  /**
   * Global search across events, minutes and people.
   *
   * Everything is ministry-scoped through the shared helper, so a user cannot
   * reach another ministry's records by guessing a term. People are only
   * searched for admin roles, matching the admin-only People section.
   */
  async search(
    user: { id: string; systemRole: string; ministryId?: string },
    rawQuery: string,
  ) {
    const q = (rawQuery ?? '').trim();

    if (q.length < MIN_QUERY) {
      return {
        query: q,
        tooShort: true,
        events: [],
        minutes: [],
        people: [],
      };
    }

    const scope = ministryScope(user);
    const like = { contains: q, mode: 'insensitive' as const };
    const isAdmin = ADMIN_ROLES.includes(user.systemRole);

    const [events, minutes, people] = await Promise.all([
      (this.prisma as any).event.findMany({
        where: { ...scope, OR: [{ title: like }, { description: like }] },
        select: {
          id: true,
          title: true,
          startAt: true,
          organizer: { select: { name: true, email: true } },
        },
        orderBy: { startAt: 'desc' },
        take: LIMIT,
      }),

      (this.prisma as any).minutes.findMany({
        where: {
          event: scope,
          // Archived records are leadership-only and are kept out of everyday
          // listings even for them — see archive.policy.ts and the same
          // default in MinutesService.list. Without this, search returned
          // them to anyone, and the snippet below meant the body was
          // disclosed in the results without the reader ever following the
          // link that would have refused them.
          status: { not: 'ARCHIVED' },
          OR: [{ body: like }, { summary: like }],
        },
        select: {
          id: true,
          summary: true,
          body: true,
          status: true,
          event: { select: { id: true, title: true } },
        },
        take: LIMIT,
      }),

      isAdmin
        ? (this.prisma as any).user.findMany({
            where: {
              ...scope,
              active: true,
              deletedAt: null,
              OR: [{ name: like }, { email: like }],
            },
            select: { id: true, name: true, email: true, jobTitle: true },
            take: LIMIT,
          })
        : Promise.resolve([]),
    ]);

    return {
      query: q,
      tooShort: false,
      events,
      // Trim the body to a snippet; the full minutes body can be very large.
      minutes: minutes.map((m: any) => ({
        id: m.id,
        status: m.status,
        event: m.event,
        snippet: (m.summary || m.body || '').slice(0, 200),
      })),
      people,
    };
  }
}
