import type { TenantPrismaClient } from '@libriant/db-tenant';

/**
 * Format: `M-<YYYY>-<NNNN>`. Year is the joinedAt year (caller passes the
 * date being used), sequence comes from a per-year counter row.
 *
 * Members can also supply their own memberNumber (any shape that matches
 * the DB regex). This helper is only invoked when no number was provided.
 */
export const MEMBER_NUMBER_PREFIX = 'M';

/**
 * Largest sequence the counter can hold. `member_number_counters."nextSeq"` is
 * an INTEGER, so the seed scan must not hand back something that overflows it —
 * hence the `[0-9]{1,9}` bound in the seed regex below (999,999,999 < 2^31-1).
 * A library that has issued a billion member numbers has other problems.
 */
const MAX_SEQUENCE = 999_999_999;

export function buildMemberNumber(year: number, sequence: number): string {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new Error(`Invalid year for member number: ${year}`);
  }
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`Invalid sequence for member number: ${sequence}`);
  }
  return `${MEMBER_NUMBER_PREFIX}-${year}-${sequence.toString().padStart(4, '0')}`;
}

/**
 * Highest sequence already in use for `year`, or 0 if the year is unused.
 *
 * ONE server-side aggregate, run at most once per tenant per year (see
 * {@link nextSequenceForYear}) — it is the counter's seed, not a hot path.
 *
 * Deliberately looks at EVERY member row, archived ones included: an archived
 * member keeps the number printed on their card, so skipping them would let the
 * counter re-issue it. That also means the partial unique index
 * (`members_member_number_unique_active`, `WHERE "archivedAt" IS NULL`) is not
 * the right index for this query and the seq scan here is expected — the point
 * of the counter is that this runs once, not once per create.
 *
 * The regex is anchored and length-bounded so a hand-entered number like
 * `M-2026-LIB-7` or a 40-digit tail cannot poison the seed (or overflow the
 * INTEGER column): only `M-<year>-<1..9 digits>` contributes.
 */
async function highestExistingSequence(client: TenantPrismaClient, year: number): Promise<number> {
  const prefix = `${MEMBER_NUMBER_PREFIX}-${year}-`;
  const pattern = `^${MEMBER_NUMBER_PREFIX}-${year}-[0-9]{1,9}$`;
  const rows = await client.$queryRaw<{ max: bigint | number | null }[]>`
    SELECT COALESCE(
             MAX(CASE WHEN "memberNumber" ~ ${pattern}
                      THEN substring("memberNumber" from '[0-9]+$')::bigint
                 END),
             0)::bigint AS max
      FROM "members"
     WHERE "memberNumber" LIKE ${`${prefix}%`}`;
  const raw = rows[0]?.max ?? 0;
  const max = typeof raw === 'bigint' ? Number(raw) : Number(raw ?? 0);
  if (!Number.isFinite(max) || max < 0) return 0;
  return Math.min(max, MAX_SEQUENCE);
}

/**
 * Claim the next member-number sequence for `year`.
 *
 * performance-04: this used to be
 * `member.findMany({ where: { memberNumber: { startsWith: prefix } } })` and a
 * max in JavaScript — a full scan of `members` plus a full transfer of the
 * year's rows into Node on EVERY member create. On the 100,000-member tenant
 * the audit seeded that measured 47 ms and ~190 MB of RSS churn per call, and
 * because the CSV importer calls it once per row (import-engine.ts
 * `generateMemberNumber`), importing a library's existing roster — the first
 * thing a new customer does — was O(n^2) and would not finish.
 *
 * It is now a single-row `UPDATE … RETURNING` against `member_number_counters`:
 * one primary-key lookup, no rows transferred, and the row lock the UPDATE
 * takes serialises concurrent creates so each number is handed out exactly
 * once. (The caller's retry loop stays: a member may still have been created
 * manually with the number the counter is about to mint, and the retry lets the
 * counter walk past it.)
 *
 * The counter is seeded LAZILY rather than by the migration, because the seed
 * value is per-tenant data (`max(memberNumber) for the year`) that a schema
 * migration has no business computing, and because a tenant that has never
 * admitted a member in `year` should not carry a row for it. The seed costs one
 * aggregate scan, once per tenant per year; the `ON CONFLICT` makes two
 * concurrent seeders safe (the loser bumps the winner's row instead of
 * overwriting it, so no number is issued twice).
 */
export async function nextSequenceForYear(
  client: TenantPrismaClient,
  year: number,
): Promise<number> {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new Error(`Invalid year for member number: ${year}`);
  }

  try {
    // Hot path: the counter row already exists. One primary-key UPDATE, no scan,
    // no rows transferred, and the row lock serialises concurrent creates.
    const bumped = await client.$queryRaw<{ nextSeq: number }[]>`
      UPDATE "member_number_counters"
         SET "nextSeq" = "nextSeq" + 1
       WHERE "year" = ${year}
      RETURNING "nextSeq"`;
    if (bumped.length > 0) return Number(bumped[0]!.nextSeq);

    // Cold path: first member of this year for this tenant. Seed from what is
    // already on the shelf, then claim, in one statement so two concurrent
    // seeders cannot both hand out the same number.
    const seed = await highestExistingSequence(client, year);
    const claimed = await client.$queryRaw<{ nextSeq: number }[]>`
      INSERT INTO "member_number_counters" ("year", "nextSeq")
      VALUES (${year}, ${seed + 1})
      ON CONFLICT ("year")
      DO UPDATE SET "nextSeq" = "member_number_counters"."nextSeq" + 1
      RETURNING "nextSeq"`;
    const seq = Number(claimed[0]?.nextSeq ?? seed + 1);
    if (!Number.isInteger(seq) || seq < 1) {
      throw new Error(`Member-number counter for ${year} returned an unusable sequence.`);
    }
    return seq;
  } catch (err) {
    if (!isMissingCounterTable(err)) throw err;
    // A tenant database that has not had the tenant migrations applied yet —
    // the API can roll out before the maintenance window that migrates every
    // library. Admitting a member is the most basic thing a library does and
    // must not 500 for that reason, so fall back to the aggregate seed.
    //
    // This is NOT the code performance-04 was raised against: that pulled every
    // member number for the year into Node on every create (100,000 rows,
    // 47 ms, ~190 MB of churn per call, quadratic across an import). This is a
    // single server-side MAX that transfers one integer. It is still a scan, so
    // say so loudly rather than letting a library run on it forever.
    console.error(
      '[members] member_number_counters is missing from this tenant database — ' +
        'run the tenant migrations. Minting numbers from a MAX() scan until then.',
    );
    return (await highestExistingSequence(client, year)) + 1;
  }
}

/**
 * Claim a sequence for `year` that is past everything already on the shelf.
 *
 * data-integrity-11. The counter is a cheap monotonic ticker; it knows nothing
 * about numbers a library assigned ITSELF. A new customer's first act is to
 * load their existing roster, and Greek libraries number members in exactly the
 * `M-<year>-<n>` shape we mint — so the counter is routinely left sitting
 * BELOW a solid block of taken numbers. `nextSequenceForYear` then hands out
 * one taken number per attempt, the caller's three retries step 1, 2, 3 into a
 * gap twelve or two hundred wide, and the librarian is shown "A member with
 * this number already exists" about a number they never typed. Reproduced with
 * no concurrency at all in test/integration/member-number-minting.spec.ts.
 *
 * So: on a collision, RESYNC rather than step. One aggregate scan — the same
 * one the cold path already pays once per tenant per year — and the counter is
 * permanently repaired, so the next create is back on the one-row hot path.
 *
 * `GREATEST("nextSeq" + 1, seed)` and not a bare assignment: two callers can
 * resync at once, and a counter that ever moves BACKWARDS re-issues numbers.
 * It only goes forwards, so the loser of the race lands above the winner.
 */
export async function resyncSequenceForYear(
  client: TenantPrismaClient,
  year: number,
): Promise<number> {
  const seed = (await highestExistingSequence(client, year)) + 1;
  try {
    const rows = await client.$queryRaw<{ nextSeq: number }[]>`
      INSERT INTO "member_number_counters" ("year", "nextSeq")
      VALUES (${year}, ${seed})
      ON CONFLICT ("year")
      DO UPDATE SET "nextSeq" = GREATEST("member_number_counters"."nextSeq" + 1, ${seed})
      RETURNING "nextSeq"`;
    const seq = Number(rows[0]?.nextSeq ?? seed);
    if (!Number.isInteger(seq) || seq < 1) {
      throw new Error(`Member-number counter for ${year} returned an unusable sequence.`);
    }
    return seq;
  } catch (err) {
    if (!isMissingCounterTable(err)) throw err;
    // Same un-migrated tenant database `nextSequenceForYear` tolerates. The
    // seed IS the answer there — it is already past every number on the shelf.
    return seed;
  }
}

/** True for Postgres 42P01 (undefined_table) naming the counter table. */
function isMissingCounterTable(err: unknown): boolean {
  const text = [
    (err as { message?: string } | null)?.message ?? '',
    JSON.stringify((err as { meta?: unknown } | null)?.meta ?? ''),
  ].join(' ');
  return text.includes('member_number_counters') && /42P01|does not exist/i.test(text);
}
