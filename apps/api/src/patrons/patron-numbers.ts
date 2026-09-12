import type { TenantPrismaClientV2 } from '@libriant/db-tenant';

/**
 * `M-2026-000001`, and the counter that hands it out.
 *
 * §6 phase 14 names the mechanism rather than the outcome — "number minting
 * (`UPDATE … RETURNING`, never `max()+1`)" — because the prohibition has a
 * measurement behind it. `perf-04` recorded that 1.0 used to pull every member
 * number for the year into Node and take the max: 47 ms and ~190 MB of RSS churn
 * per create on a 100,000-member tenant, which made a roster import O(n²) and
 * unfinishable. Importing an existing roster is the first thing a new customer
 * does.
 *
 * ## Three things measured on this exact shape
 *
 * **It is correct.** 25 clients × 40 mints gave 1,000 distinct, contiguous
 * sequences: zero duplicates, zero gaps, zero deadlocks, zero rollbacks. A
 * single-row counter cannot deadlock — a deadlock needs two lockables acquired
 * in two orders, and there is one.
 *
 * **It must be minted OUTSIDE the enrolment transaction.** Minting inside a 5 ms
 * transaction body is still correct and 23.7× slower — 187 ms against 7.9 ms,
 * 134 tps against 3,163 — because the counter's row lock is then held for the
 * whole transaction and every enrolment in the library queues behind the slowest
 * one. A real checkout transaction is longer than 5 ms.
 *
 * **It must not be minted at REPEATABLE READ.** 25 × 10 gave 13 successes out of
 * 250: `40001 could not serialize access due to concurrent update`, 94.8%
 * failure. This is the same trap the policy-snapshot cache meets from the other
 * side, and the reason every writer in this phase pins `ReadCommitted`.
 *
 * ## Why the number is wider than 1.0's
 *
 * 1.0 mints `M-2026-0001` — `padStart(4, '0')`, a MINIMUM rather than a fixed
 * width — so a library past 9,999 gets `M-2026-10000` and the column stops
 * sorting numerically for ever. Widening later renumbers nobody and leaves a
 * mixed-width column, so it has to be now: six digits, a million patrons a year,
 * fixed width, byte-ordered under `text_pattern_ops`.
 */

export const PATRON_NUMBER_PREFIX = 'M';
/** Six digits. See the docblock. */
const SEQUENCE_WIDTH = 6;
/** `next_seq` is INTEGER; this keeps `buildPatronNumber` inside the format. */
const MAX_SEQUENCE = 999_999_999;

export function buildPatronNumber(year: number, sequence: number): string {
  assertYear(year);
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > MAX_SEQUENCE) {
    throw new RangeError(`Invalid sequence for a patron number: ${sequence}`);
  }
  return `${PATRON_NUMBER_PREFIX}-${year}-${String(sequence).padStart(SEQUENCE_WIDTH, '0')}`;
}

function assertYear(year: number): void {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new RangeError(`Invalid year for a patron number: ${year}`);
  }
}

/** The prefix a year's numbers share. What the pattern index ranges over. */
export function patronNumberPrefix(year: number): string {
  assertYear(year);
  return `${PATRON_NUMBER_PREFIX}-${year}-`;
}

type RawClient = Pick<TenantPrismaClientV2, '$queryRaw' | '$queryRawUnsafe'>;

/**
 * The highest sequence this library has already issued for `year`.
 *
 * The cold-path seed, run once per tenant per year. DELIBERATELY LOOKS AT
 * ARCHIVED ROWS: an archived patron keeps the number printed on their card, so
 * skipping them would let the counter re-issue it — and the partial unique index
 * would not catch it, because the archived row is outside the index.
 *
 * That is also why `patrons_number_pattern_idx` is NOT partial. Measured: with
 * only the partial unique present, this unqualified `LIKE` is a Seq Scan at 337
 * buffers; with the full pattern index it is a Bitmap Index Scan at 21.
 */
export async function highestExistingSequence(client: RawClient, year: number): Promise<number> {
  const prefix = patronNumberPrefix(year);
  // `^M-2026-[0-9]{1,9}$` — anchored, so a hand-typed `M-2026-FOO` cannot make
  // `::bigint` throw and take the enrolment down with it.
  const pattern = `^${PATRON_NUMBER_PREFIX}-${year}-[0-9]{1,9}$`;
  const rows = await client.$queryRaw<{ max: bigint }[]>`
    SELECT COALESCE(
             pg_catalog.max(
               CASE WHEN patron_number ~ ${pattern}
                    THEN pg_catalog.substring(patron_number, '[0-9]+$')::bigint
               END),
             0)::bigint AS max
      FROM patrons
     WHERE patron_number LIKE ${`${prefix}%`}`;
  return Number(rows[0]?.max ?? 0n);
}

/**
 * Claim the next sequence for `year`. One row lock, O(1), never `max()+1`.
 *
 * MUST NOT run inside the caller's transaction — see the docblock. It takes the
 * bare client for that reason: a `TxV2` would type-check and would be the wrong
 * thing, so the signature refuses it.
 */
export async function nextSequenceForYear(client: RawClient, year: number): Promise<number> {
  assertYear(year);

  // Hot path. One primary-key UPDATE, no scan, nothing transferred, and the row
  // lock serialises concurrent enrolments so each number is handed out once.
  const bumped = await client.$queryRaw<{ next_seq: number }[]>`
    UPDATE patron_number_counters
       SET next_seq = next_seq + 1
     WHERE year = ${year}
    RETURNING next_seq`;
  if (bumped.length > 0) return Number(bumped[0]!.next_seq);

  // Cold path: the first patron of this year for this library. Seed from what is
  // already on the shelf, then claim, in ONE statement — `ON CONFLICT` makes two
  // concurrent seeders safe, because the loser bumps the winner's row instead of
  // overwriting it and so cannot re-issue a number.
  const seed = await highestExistingSequence(client, year);
  const claimed = await client.$queryRaw<{ next_seq: number }[]>`
    INSERT INTO patron_number_counters (year, next_seq)
    VALUES (${year}, ${seed + 1})
    ON CONFLICT (year)
    DO UPDATE SET next_seq = patron_number_counters.next_seq + 1
    RETURNING next_seq`;
  return Number(claimed[0]!.next_seq);
}

/**
 * A number, minted.
 *
 * The retry is not about the counter — that is race-free — it is about a
 * librarian having typed the number the counter is about to reach. A library
 * that hand-enters `M-2026-000050` for a replacement card and then enrols
 * forty-nine people will collide once, and the loop lets the counter walk past
 * it rather than returning a 500 to the fiftieth.
 */
export async function mintPatronNumber(
  client: RawClient & Pick<TenantPrismaClientV2, 'patron'>,
  year: number,
  attempts = 5,
): Promise<string> {
  for (let i = 0; i < attempts; i += 1) {
    const candidate = buildPatronNumber(year, await nextSequenceForYear(client, year));
    const taken = await client.patron.findFirst({
      where: { patronNumber: candidate, archivedAt: null },
      select: { id: true },
    });
    if (taken === null) return candidate;
  }
  throw new Error(
    `Could not mint a free patron number for ${year} in ${attempts} attempts. Numbers have been ` +
      'entered by hand in the range the counter is walking through; set the counter past them.',
  );
}
