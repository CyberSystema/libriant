import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { controlDb, type LibraryType } from '@libriant/db-control';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { BUNDLE_TABLES, PATRON_DATA_TABLES } from '../patrons/patron-data-map.js';
import {
  assessMinor,
  noticeIsAboutSubject,
  subjectAccessFilename,
  type MinorAssessment,
} from './subject-access-bundle.js';

/**
 * GDPR Article 15 and 20, over the 2.0 schema (2.0 phase 20b-ii).
 *
 * ## Why this is a new file and not an edit
 *
 * `subject-access.service.ts` reads `client.member`, `client.loan`,
 * `client.reservation` and `client.fine` — four 1.0 models. Phase 20b-iii
 * archives those tables, and the route that serves them is mounted from THIS
 * directory rather than from `members/`, so the deletion §6 describes would have
 * left an Article 15 endpoint live and reading a schema that had moved. The two
 * services exist side by side until the cutover and the 1.0 one goes with its
 * tables.
 *
 * The PURE half is not duplicated. `subject-access-bundle.ts` holds the
 * decisions that can actually hurt someone — the age assessment, the
 * shared-mailbox filter, the download filename — and none of them knows what a
 * table is, so both services import the same functions and
 * `subject-access-bundle.spec.ts` covers both.
 *
 * ## The bundle is DRIVEN FROM THE MAP, not from a list of queries
 *
 * `patron-data-map.ts` already enumerates every `lbr2` table holding something
 * about a person, with a verdict and an erase rule, and its docblock says what
 * it is for: "the bundle is driven FROM this list rather than from six
 * hand-written queries, which turns 'did somebody remember?' from unanswerable
 * into a diff."
 *
 * Until now it had **zero consumers**. It was a specification of a thing nobody
 * had built, which is the most expensive kind of document — it reads like
 * coverage. So this walks `BUNDLE_TABLES` and emits one section per entry, and
 * a table added to `lbr2` with a patron column is either in the map (and
 * therefore in the bundle) or it fails `patrons.spec.ts`'s coverage assertion.
 * Neither the bundle nor the erase can quietly miss a table without the map
 * disagreeing with the schema.
 *
 * ## Raw SQL, and why
 *
 * A Prisma model call per table would need a generated delegate per table name,
 * which a data-driven walk cannot express — the whole point is that the table
 * list is DATA. So each section is one parameterised `SELECT *` against a table
 * name taken from the map, which is a closed set defined in this repository and
 * never from a request. `lbr2.`-qualified as every raw statement here must be;
 * phase 20b-iii rewrites that with the other 377.
 */
export type PatronBundleSection = {
  readonly table: string;
  readonly rows: readonly Record<string, unknown>[];
  /** Present when the section was capped, so a reader knows it is partial. */
  readonly truncatedAt?: number;
};

export type PatronBundle = {
  readonly generatedAt: string;
  readonly tenant: { readonly slug: string };
  readonly subject: {
    readonly patronId: string;
    readonly minor: MinorAssessment;
  };
  readonly sections: readonly PatronBundleSection[];
  /** Tables deliberately NOT in the bundle, each with the reason. */
  readonly excluded: readonly { readonly table: string; readonly reason: string }[];
  readonly notifications: readonly Record<string, unknown>[];
  readonly filename: string;
};

/**
 * Per-section row cap, carried over from the 1.0 bundle verbatim.
 *
 * A patron with a decade of borrowing is a few hundred loans, so this is not a
 * real ceiling for anybody — it bounds how much a single request can be made to
 * assemble, and a section that hits it says so rather than silently ending.
 */
const SECTION_LIMIT = 5_000;

@Injectable()
export class PatronSubjectAccessService {
  private readonly logger = new Logger(PatronSubjectAccessService.name);

  constructor(@Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService) {}

  async bundle(tenant: TenantContext, patronId: string): Promise<PatronBundle> {
    const client = this.tenantPrisma.getClientV2(tenant);

    const patron = await client.patron.findUnique({
      where: { id: patronId },
      select: { id: true, email: true, dateOfBirth: true, erasedAt: true },
    });
    if (patron === null) throw new NotFoundException(`No patron with id ${patronId}.`);

    // An erased record has nothing left to disclose, and saying so is the
    // correct answer rather than an empty bundle that reads like a bug. 1.0
    // answers the same way.
    if (patron.erasedAt !== null) {
      throw new NotFoundException(
        'This patron record was erased under Article 17, so there is nothing left to disclose. ' +
          'The erasure itself is recorded in the audit log.',
      );
    }

    const sections: PatronBundleSection[] = [];
    for (const entry of BUNDLE_TABLES) {
      // The table and column names come from the map — a closed set compiled
      // into this build — never from a request, so the interpolation below
      // cannot carry anything a caller chose. The VALUE is still bound.
      const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM ${entry.table} WHERE ${entry.patronColumn} = $1 LIMIT ${SECTION_LIMIT + 1}`,
        patronId,
      );
      const truncated = rows.length > SECTION_LIMIT;
      sections.push({
        table: entry.table,
        rows: truncated ? rows.slice(0, SECTION_LIMIT) : rows,
        ...(truncated ? { truncatedAt: SECTION_LIMIT } : {}),
      });
    }

    // What is NOT here, and why, travels WITH the bundle. A subject-access
    // response that silently omits a table is the failure the map exists to
    // prevent; one that names its omissions is answerable.
    const excluded = PATRON_DATA_TABLES.filter(
      (t) => t.verdict === 'excluded' && t.reason !== undefined,
    ).map((t) => ({ table: t.table, reason: t.reason as string }));

    // THE SHARED-MAILBOX FILTER. The control-plane outbox holds no patron id —
    // the only handle is the address — so a household sharing one mailbox would
    // otherwise disclose a parent's overdue notice inside a child's bundle.
    // `noticeIsAboutSubject` drops anything whose own metadata attributes it to
    // a loan or hold that is not this person's. Same function the 1.0 bundle
    // uses, and the reason it is pure.
    const loanIds = new Set(
      sections.find((x) => x.table === 'loans')?.rows.map((r) => String(r['id'])) ?? [],
    );
    const holdIds = new Set(
      sections.find((x) => x.table === 'holds')?.rows.map((r) => String(r['id'])) ?? [],
    );
    const notifications =
      patron.email === null
        ? []
        : (
            await controlDb.emailOutbox.findMany({
              where: { toEmail: patron.email },
              orderBy: { createdAt: 'desc' },
              take: SECTION_LIMIT,
            })
          ).filter((n) => noticeIsAboutSubject(n.metadataJson, loanIds, holdIds));

    const now = new Date();
    return {
      generatedAt: now.toISOString(),
      tenant: { slug: tenant.slug },
      subject: {
        patronId: patron.id,
        minor: assessMinor(patron.dateOfBirth, await this.libraryTypeOf(tenant), now),
      },
      sections,
      excluded,
      notifications,
      filename: subjectAccessFilename(tenant.slug, patronId, now),
    };
  }

  /**
   * The library's type, for the age assessment, and `null` rather than a throw
   * when the control plane cannot be reached.
   *
   * Copied in shape from the 1.0 service on purpose: a subject-access request
   * must not fail because a lookup that only refines a LABEL was unavailable,
   * and `assessMinor` already treats `null` as "no basis" rather than "adult".
   */
  private async libraryTypeOf(tenant: TenantContext): Promise<LibraryType | null> {
    try {
      const row = await controlDb.tenant.findUnique({
        where: { id: tenant.id },
        select: { libraryType: true },
      });
      return row?.libraryType ?? null;
    } catch (err) {
      this.logger.warn(`could not read libraryType for ${tenant.slug}: ${(err as Error).message}`);
      return null;
    }
  }
}
