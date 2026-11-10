import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService, SETTINGS } from '../common/settings/settings.service';
import { PLATFORM_ROLES } from '../common/utils/ministry-scope.util';
import { INVISIBLE, parseStaffCsv, StaffCsvError } from './staff-import.csv';
import {
  Candidate,
  Change,
  partition,
  screen,
  Skipped,
  SkipReason,
} from './staff-import.classify';

export const MAX_CSV_ROWS = 5000;

interface Actor {
  id: string;
  systemRole: string;
  ministryId?: string | null;
}

export interface StaffImportResult {
  ministry: { id: string; name: string; emailDomain: string };
  filename: string;
  committed: boolean;
  totals: {
    rows: number;
    new: number;
    updated: number;
    unchanged: number;
    skipped: number;
  };
  skippedByReason: Partial<Record<SkipReason, number>>;
  skipped: Skipped[];
  /** Preview only: who would be added, and whose name would change. */
  added?: Candidate[];
  updated?: Change[];
}

/**
 * Adds a ministry's staff list to its roster (StaffDirectoryEntry), the
 * no-account list the attendee picker searches.
 *
 * This creates no accounts and sends no mail. It adds people and corrects
 * their names; it never removes anybody, so a partial file cannot empty a
 * roster. scripts/import-staff-directory.ts is the hand-run predecessor and
 * deliberately does reconcile; the two are not meant to agree on that.
 *
 * Preview and commit run the same pipeline over the same bytes, so what the
 * uploader confirmed is what is written, recomputed against the data as it is
 * at the moment of writing rather than as it was when they looked.
 */
@Injectable()
export class StaffImportService {
  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
    private audit: AuditService,
  ) {}

  /** The ministries this person may upload to, for the picker on the page. */
  ministryOptions(user: Actor): Promise<unknown[]> {
    if (!PLATFORM_ROLES.includes(user.systemRole) && !user.ministryId) {
      return Promise.resolve([]);
    }
    return (this.prisma as any).ministry.findMany({
      where: PLATFORM_ROLES.includes(user.systemRole)
        ? { active: true }
        : { id: user.ministryId, active: true },
      select: { id: true, name: true, emailDomain: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Platform roles belong to no ministry and must say which one; everybody
   * else uploads to their own and may not name another.
   *
   * Not assertSameMinistry, which exempts only SUPER_ADMIN and would refuse a
   * platform admin, nor ministryScope, which is a read filter.
   */
  resolveMinistryId(user: Actor, requested?: string): string {
    const wanted = requested?.trim() || undefined;

    if (PLATFORM_ROLES.includes(user.systemRole)) {
      if (!wanted) {
        throw new BadRequestException({
          message: 'Choose which ministry this staff list belongs to.',
          code: 'MINISTRY_REQUIRED',
        });
      }
      return wanted;
    }

    if (!user.ministryId) {
      throw new ForbiddenException('Your account belongs to no ministry.');
    }
    if (wanted && wanted !== user.ministryId) {
      throw new ForbiddenException(
        "You can only add staff to your own ministry's list.",
      );
    }
    return user.ministryId;
  }

  async run(
    user: Actor,
    opts: {
      ministryId?: string;
      filename?: string;
      body: Buffer;
      commit: boolean;
      ipAddress?: string;
      userAgent?: string;
    },
  ): Promise<StaffImportResult> {
    const ministryId = this.resolveMinistryId(user, opts.ministryId);
    const filename = cleanFilename(opts.filename);

    const ministry = await (this.prisma as any).ministry.findUnique({
      where: { id: ministryId },
      select: { id: true, name: true, emailDomain: true, active: true },
    });
    if (!ministry) throw new NotFoundException('Ministry not found.');
    if (!ministry.active) {
      // Its people cannot be onboarded and the pickers leave it out, so a
      // roster for it would be rows nobody ever sees.
      throw new ConflictException({
        message: `${ministry.name} is inactive. Reactivate it before adding its staff.`,
        code: 'MINISTRY_INACTIVE',
      });
    }

    let rows;
    try {
      rows = parseStaffCsv(opts.body, { maxRows: MAX_CSV_ROWS });
    } catch (e) {
      if (e instanceof StaffCsvError) {
        throw new HttpException({ message: e.message, code: e.code }, e.status);
      }
      throw e;
    }

    const supportEmail =
      (await this.settings.get(SETTINGS.SUPPORT_EMAIL)) || null;
    const screened = screen(rows, {
      domain: ministry.emailDomain,
      supportEmail,
    });
    const emails = screened.candidates.map((c) => c.email);

    const [accountEmails, existing] = await Promise.all([
      this.accountEmails(emails),
      this.existingRoster(ministry.id, emails),
    ]);
    const sorted = partition(screened.candidates, { accountEmails, existing });

    const skipped = [...screened.skipped, ...sorted.skipped].sort(
      (a, b) => a.line - b.line,
    );
    const skippedByReason: Partial<Record<SkipReason, number>> = {};
    for (const s of skipped) {
      skippedByReason[s.reason] = (skippedByReason[s.reason] ?? 0) + 1;
    }

    const base = {
      ministry: {
        id: ministry.id,
        name: ministry.name,
        emailDomain: ministry.emailDomain,
      },
      filename,
      skippedByReason,
      skipped,
    };

    if (!opts.commit) {
      return {
        ...base,
        committed: false,
        totals: {
          rows: rows.length,
          new: sorted.added.length,
          updated: sorted.updated.length,
          unchanged: sorted.unchanged.length,
          skipped: skipped.length,
        },
        added: sorted.added,
        updated: sorted.updated,
      };
    }

    const auditBase = {
      action: 'STAFF_ROSTER_IMPORTED',
      actionCategory: 'STAFF_ROSTER',
      entityType: 'StaffDirectory',
      entityId: ministry.id,
      entityName: ministry.name,
      // The target ministry, not the actor's: a platform admin has none, and
      // the minister of the ministry imported into should see this entry.
      ministryId: ministry.id,
      actorId: user.id,
      ipAddress: opts.ipAddress,
      userAgent: opts.userAgent,
    };

    let created: number;
    let changed: number;
    try {
      ({ created, changed } = await this.write(
        ministry.id,
        `csv:${filename}`,
        sorted.writes,
      ));
    } catch (e) {
      await this.audit.log({
        ...auditBase,
        status: 'FAILURE',
        description: `Staff list "${filename}" could not be saved`,
        metadata: { filename, bytes: opts.body.length, rows: rows.length },
      });
      throw e;
    }

    // A row between preview and now may already hold the same name; the write
    // skips it, so it counts as unchanged rather than updated.
    const unchanged =
      sorted.unchanged.length + (sorted.writes.length - created - changed);
    const totals = {
      rows: rows.length,
      new: created,
      updated: changed,
      unchanged,
      skipped: skipped.length,
    };

    // Counts in the description as well as the metadata: the activity log
    // lists descriptions and does not select metadata. No addresses in either.
    await this.audit.log({
      ...auditBase,
      status: 'SUCCESS',
      description: `Staff list "${filename}": ${created} added, ${changed} updated, ${unchanged} unchanged, ${skipped.length} skipped`,
      metadata: {
        filename,
        bytes: opts.body.length,
        ...totals,
        skippedByReason,
      },
    });

    return { ...base, committed: true, totals };
  }

  /**
   * Lowercased addresses of live accounts in any ministry. Compared on
   * lower(email) because accounts created before addresses were lowercased on
   * write are stored as typed; Prisma's `in` is case-sensitive.
   */
  private async accountEmails(emails: string[]): Promise<Set<string>> {
    if (emails.length === 0) return new Set();
    const rows: Array<{ email: string }> = await (this.prisma as any).$queryRaw`
      SELECT lower(email) AS email
      FROM "User"
      WHERE "deletedAt" IS NULL
        AND lower(email) IN (SELECT jsonb_array_elements_text(${JSON.stringify(emails)}::jsonb))
    `;
    return new Set(rows.map((r) => r.email));
  }

  private async existingRoster(ministryId: string, emails: string[]) {
    const map = new Map<
      string,
      { firstName: string; lastName: string | null }
    >();
    if (emails.length === 0) return map;
    const rows = await (this.prisma as any).staffDirectoryEntry.findMany({
      where: { ministryId, email: { in: emails } },
      select: { email: true, firstName: true, lastName: true },
    });
    for (const r of rows) {
      map.set(r.email, { firstName: r.firstName, lastName: r.lastName });
    }
    return map;
  }

  /**
   * One statement for the whole file. Neon is an ocean away from the API, so
   * a query per person — the script's approach — would run for minutes on a
   * large ministry and outlive the proxy's 30-second timeout.
   *
   * One statement is also one transaction: the file lands whole or not at all,
   * and repeating it changes nothing further. Rows are sorted so two uploads
   * running at once lock in the same order and cannot deadlock; the later one
   * wins per address. The WHERE skips rows whose name is already right, so the
   * RETURNING count is the true number changed.
   */
  private async write(
    ministryId: string,
    source: string,
    writes: Candidate[],
  ): Promise<{ created: number; changed: number }> {
    if (writes.length === 0) return { created: 0, changed: 0 };

    const payload = JSON.stringify(
      writes.map((w) => ({
        // The column has no database default; @default(cuid()) is client-side.
        id: randomUUID(),
        firstName: w.firstName,
        lastName: w.lastName,
        email: w.email,
      })),
    );

    const rows: Array<{ created: boolean }> = await (this.prisma as any)
      .$queryRaw`
      INSERT INTO "StaffDirectoryEntry"
        (id, "firstName", "lastName", email, "ministryId", source, "updatedAt")
      SELECT r.id, r."firstName", r."lastName", r.email, ${ministryId}::text, ${source}::text, now()
      FROM jsonb_to_recordset(${payload}::jsonb)
        AS r(id text, "firstName" text, "lastName" text, email text)
      ORDER BY r.email
      ON CONFLICT ("ministryId", email) DO UPDATE SET
        "firstName" = EXCLUDED."firstName",
        "lastName"  = COALESCE(EXCLUDED."lastName", "StaffDirectoryEntry"."lastName"),
        source      = EXCLUDED.source,
        "updatedAt" = now()
      WHERE ("StaffDirectoryEntry"."firstName", "StaffDirectoryEntry"."lastName")
        IS DISTINCT FROM
        (EXCLUDED."firstName", COALESCE(EXCLUDED."lastName", "StaffDirectoryEntry"."lastName"))
      RETURNING (xmax = 0) AS created
    `;

    const created = rows.filter((r) => r.created).length;
    return { created, changed: rows.length - created };
  }
}

/** Basename only, printable, bounded: it is stored in `source` and the audit log. */
export function cleanFilename(raw?: string): string {
  const base = (raw ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(INVISIBLE, '')
    .trim()
    .slice(0, 120);
  return base || 'upload.csv';
}
