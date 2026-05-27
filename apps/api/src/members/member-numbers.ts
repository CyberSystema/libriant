import type { TenantPrismaClient } from '@libriant/db-tenant';

/**
 * Format: `M-<YYYY>-<NNNN>`. Year is the joinedAt year (caller passes the
 * date being used), sequence is the next free integer among existing
 * member numbers in that year for this tenant.
 *
 * Race safety: we read the current max, increment, and insert. A second
 * concurrent caller may pick the same number and trip the DB partial
 * unique index — callers retry up to 3 times. In practice this is fine
 * for typical write rates (a library admits members in seconds, not ms).
 *
 * Members can also supply their own memberNumber (any shape that matches
 * the DB regex). This helper is only invoked when no number was provided.
 */
export const MEMBER_NUMBER_PREFIX = 'M';

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
 * Look at all existing (non-archived) member numbers in `year` and return
 * the next sequence to use. Returns 1 when no members exist yet for the year.
 *
 * `LIKE` is fine here even on big tables because the prefix is a constant
 * string and the column has a B-tree index via the partial unique index.
 */
export async function nextSequenceForYear(
  client: TenantPrismaClient,
  year: number,
): Promise<number> {
  const prefix = `${MEMBER_NUMBER_PREFIX}-${year}-`;
  const rows = await client.member.findMany({
    where: { memberNumber: { startsWith: prefix } },
    select: { memberNumber: true },
  });
  let max = 0;
  for (const r of rows) {
    const tail = r.memberNumber.slice(prefix.length);
    const n = Number.parseInt(tail, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}
