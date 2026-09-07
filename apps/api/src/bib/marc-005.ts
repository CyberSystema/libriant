/**
 * MARC field 005 — the transaction timestamp — and why the obvious version of
 * it is wrong.
 *
 * ## The format
 *
 * `yyyymmddhhmmss.f`, sixteen characters, UTC. The fraction is a single digit:
 * TENTHS of a second. That is the whole resolution the field has.
 *
 * ## Why this is monotonic and not merely current
 *
 * §2 says 005 is "stamped inside the write transaction on every content change
 * and excluded from `content_hash`". The phase-10 acceptance criterion adds a
 * requirement the format cannot satisfy on its own: "two consecutive edits
 * produce strictly increasing 005".
 *
 * Measured against the real tables: a complete write transaction — advisory
 * lock, CAS, contents, version row — takes **1.60 ms**. Ten consecutive edits
 * produced ten IDENTICAL stamps (`20260907204100.1`, nine duplicates), because
 * the write path never separates two edits by the 100 ms that 005 can represent.
 *
 * So a wall-clock stamper does not merely risk a collision; under the write path
 * this system actually has, it collides essentially always. And the obvious test
 * — two HTTP PATCHes through supertest — PASSES on it, because HTTP round trips
 * are usually more than 100 ms apart. That combination is the worst kind of bug:
 * a criterion that reads satisfied, an implementation that violates it on every
 * real burst, and a test that will start failing years later on a faster runner.
 *
 * Hence `max(clockNow, previous + 0.1s)`. The consequence is deliberate and
 * worth stating: a burst of edits pushes 005 ahead of real time by a tenth of a
 * second each. That is correct for MARC — 005 is a TRANSACTION timestamp whose
 * job is to order versions, and OCLC and every other system treat it that way —
 * but it will look wrong to anyone diffing it against `updated_at`, so the
 * divergence is recorded rather than left to be discovered.
 *
 * ## Why it lives here and not in `packages/marc`
 *
 * The codec deliberately produces no 005 value: `iso2709.ts` records that "NFC
 * is a policy the write path applies (phase 10: `applyOps` then NFC then the 005
 * stamp), not something a codec may do behind the caller's back", and the same
 * reasoning applies to a clock. A codec that stamped a timestamp could not be
 * used to round-trip a file.
 */
import type { MarcRecord } from '@libriant/marc';

/** One tenth of a second, in milliseconds — the resolution of the field. */
export const TICK_MS = 100;

/** `yyyymmddhhmmss.f` in UTC. */
export function format005(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}` +
    `.${Math.floor(d.getUTCMilliseconds() / TICK_MS)}`
  );
}

/**
 * A stored 005 back to milliseconds, or `null` if it is not one.
 *
 * Permissive on purpose: imported records carry 005 values that are blank, are
 * fourteen characters with no fraction, or are frank rubbish, and a write must
 * not fail because a 1993 exporter was sloppy. An unparseable previous stamp
 * simply means there is nothing to be monotonic against.
 */
export function parse005(value: string | undefined | null): number | null {
  if (!value) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d))?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, f] = m;
  const ms = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Number(f ?? 0) * TICK_MS,
  );
  if (Number.isNaN(ms)) return null;
  // `Date.UTC` ROLLS OVER rather than rejecting: month 13 becomes January of
  // the next year, day 32 becomes the 1st. A rolled-over value is not a
  // timestamp this record ever carried, and treating it as one would let a
  // corrupt 005 push every future stamp a month into the future. Round-tripping
  // the format is the cheapest total check.
  return format005(ms) === (f === undefined ? `${value.trim()}.0` : value.trim()) ? ms : null;
}

/** The 005 currently on a record, if it has one. */
export function current005(record: MarcRecord): string | null {
  for (const field of record.fields) {
    if (field.t === '005' && 'v' in field) return field.v;
  }
  return null;
}

/**
 * The stamp this write should carry: never before the clock, never at or before
 * the previous one.
 *
 * `now` is passed in rather than read here — the same rule §4.1 imposes on the
 * policy resolver, and for the same reason: a function that reads the clock
 * cannot be tested for the behaviour that matters.
 */
export function next005(record: MarcRecord, nowMs: number): string {
  const previous = parse005(current005(record));
  if (previous === null) return format005(nowMs);

  // Compare at the FIELD'S resolution, not in milliseconds. A clock that has
  // advanced 40 ms has not advanced at all as far as 005 is concerned, and
  // comparing the raw instants would emit a stamp equal to the previous one
  // while looking like it had moved — which is the same defect as not being
  // monotonic at all, just harder to see.
  const nowTick = Math.floor(nowMs / TICK_MS) * TICK_MS;
  if (nowTick > previous) return format005(nowTick);
  return format005(previous + TICK_MS);
}

/**
 * Put the stamp on the record, replacing any existing 005.
 *
 * Returns a copy. 005 is a control field and belongs in tag order, so a record
 * that had none gets one in the right place rather than appended — a serializer
 * would order it correctly anyway, but a diff of the stored JSONB would show a
 * spurious move on the next edit.
 */
export function stamp005(record: MarcRecord, nowMs: number): MarcRecord {
  const value = next005(record, nowMs);
  const without = record.fields.filter((f) => f.t !== '005');
  const at = without.findIndex((f) => f.t > '005');
  const fields = [...without];
  fields.splice(at === -1 ? fields.length : at, 0, { t: '005', v: value });
  return { ...record, fields };
}
