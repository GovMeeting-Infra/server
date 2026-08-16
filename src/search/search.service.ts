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
          points: { some: { text: like } },
        },
        select: {
          id: true,
          // The lines that matched, which are the result — a decision reads as
          // an answer, where a slice of the old prose body was a fragment cut
          // mid-sentence.
          points: {
            where: { text: like },
            orderBy: [{ type: 'asc' }, { order: 'asc' }],
            take: 3,
            select: { text: true },
          },
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
      minutes: minutes.map((m: any) => ({
        id: m.id,
        status: m.status,
        event: m.event,
        // Still capped: three matching lines are short, but nothing stops one
        // of them running to the DTO's limit.
        snippet: m.points
          .map((p: any) => p.text)
          .join(' · ')
          .slice(0, 200),
      })),
      people,
    };
  }
}
