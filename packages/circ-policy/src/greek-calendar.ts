import { civilFromDays, daysFromCivil } from './calendar.js';
import type { CalendarException, CivilDate } from './types.js';

/**
 * When a Greek library is shut.
 *
 * ## The Julian Paschalion, not Gregorian Easter
 *
 * This is the single thing an Anglophone ILS gets wrong here, and it is wrong by
 * a week or five. Greek Orthodox Easter is computed on the JULIAN calendar and
 * then converted; in 2026 it falls on 12 April against Western Easter's 5 April.
 * Every library that reaches for the Gauss or Anonymous-Gregorian algorithm —
 * which is what a search for "Easter algorithm" returns — closes on the wrong
 * week, every year the two diverge, which is most years.
 *
 * ## It emits ROWS, and does not evaluate a rule
 *
 * The temptation is a function the calendar calls at query time: "is this date a
 * Greek holiday?". It is the wrong shape for two reasons, and the second is
 * decisive.
 *
 * The first is that a holiday is a fact about ONE library. Every Greek
 * municipality has a legally recognised patron-saint holiday — Άγιος Δημήτριος
 * on 26 October in Thessaloniki, Άγιος Ανδρέας on 30 November in Patras, Άγιος
 * Μηνάς on 11 November in Heraklion — so a single national list is unusable, and
 * a per-branch list is exactly what `calendar_exceptions` is.
 *
 * The second is Πρωτομαγιά. When 1 May falls inside Holy Week the Ministry of
 * Labour issues a decision RELOCATING the holiday — it did in 2016, 2021 and
 * 2024, each time to a different date. That is not computable from a rule, and a
 * seeder that recomputed at query time would silently overwrite a librarian's
 * correction on every run. Rows are editable; a rule is not.
 *
 * So: this module produces `CalendarException` rows for a year, a librarian
 * edits what their municipality actually does, and phase 13's seeder writes them
 * once with an idempotent key.
 */

/**
 * Orthodox Pascha, as a Gregorian civil date.
 *
 * Meeus's Julian Paschalion — nine lines of modular arithmetic that have been
 * right since 325 CE — followed by the Julian→Gregorian conversion.
 *
 * THE +13 IS ONLY VALID 1900–2099. The Julian calendar drifts one day per
 * century that is not a leap year in the Gregorian, so the offset becomes 14 in
 * 2100. That is beyond any loan this system will compute, but it is exactly the
 * sort of constant that is right for a century and then silently wrong, so the
 * range is asserted rather than assumed.
 *
 * Verified against the published dates: 2026-04-12, 2027-05-02, 2028-04-16,
 * 2029-04-08, 2030-04-28 — all Sundays, all matching the Ecumenical Patriarchate.
 */
export function orthodoxPascha(year: number): CivilDate {
  if (year < 1900 || year > 2099) {
    throw new RangeError(
      `orthodoxPascha is implemented for 1900-2099 and was asked for ${year}. The Julian-to-` +
        'Gregorian offset is 13 days only in that range; it becomes 14 from 2100.',
    );
  }
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const julianMonth = Math.floor((d + e + 114) / 31);
  const julianDay = ((d + e + 114) % 31) + 1;
  // The result above is a JULIAN calendar date. Adding 13 days on the day-number
  // line converts it, and reusing the package's own civil arithmetic keeps this
  // free of `Date` exactly like everything else here.
  return civilFromDays(daysFromCivil({ year, month: julianMonth, day: julianDay }) + 13);
}

/** How far each movable closure sits from Pascha, in days. */
const MOVABLE: readonly (readonly [number, string])[] = [
  [-48, 'Καθαρά Δευτέρα'],
  [-2, 'Μεγάλη Παρασκευή'],
  [-1, 'Μέγα Σάββατο'],
  [0, 'Κυριακή του Πάσχα'],
  [1, 'Δευτέρα του Πάσχα'],
  [50, 'Αγίου Πνεύματος'],
];

/** The fixed national holidays a Greek public library observes. */
const FIXED: readonly (readonly [number, number, string])[] = [
  [1, 1, 'Πρωτοχρονιά'],
  [1, 6, 'Θεοφάνεια'],
  [3, 25, 'Ευαγγελισμός / Εθνική Εορτή'],
  // Πρωτομαγιά. RELOCATED BY MINISTERIAL DECISION when it collides with Holy
  // Week — 2016, 2021 and 2024 all moved, each to a different date. Emitted on
  // 1 May because that is where it is in an ordinary year, and emitted as an
  // editable ROW because in the other years a librarian has to move it.
  [5, 1, 'Πρωτομαγιά'],
  [8, 15, 'Κοίμηση της Θεοτόκου'],
  [10, 28, 'Επέτειος του ΟΧΙ'],
  [12, 25, 'Χριστούγεννα'],
  [12, 26, 'Σύναξη Θεοτόκου'],
];

/** The movable feasts of one year, as civil dates. */
export function greekMovableFeasts(year: number): readonly { date: CivilDate; name: string }[] {
  const pascha = daysFromCivil(orthodoxPascha(year));
  return MOVABLE.map(([offset, name]) => ({ date: civilFromDays(pascha + offset), name }));
}

/** The fixed national holidays of one year, as civil dates. */
export function greekFixedHolidays(year: number): readonly { date: CivilDate; name: string }[] {
  return FIXED.map(([month, day, name]) => ({ date: { year, month, day }, name }));
}

/**
 * Every closure of one year, as `CalendarException` rows a librarian can edit.
 *
 * `intervals: []` means CLOSED. A library that opens late on Christmas Eve
 * writes its own row with hours in it; this seeder only knows about the days the
 * whole country is shut.
 *
 * Sorted by date and deduplicated, because a movable feast can land on a fixed
 * one — Ευαγγελισμός on 25 March fell on Μεγάλη Παρασκευή in 2016 — and two rows
 * for one date would violate the `(calendar_id, date)` uniqueness phase 13 will
 * put on the table. The FIXED name wins, because that is the one printed on the
 * public notice.
 */
export function greekCalendarExceptions(year: number): readonly CalendarException[] {
  const byDate = new Map<number, CalendarException>();
  for (const { date, name } of greekMovableFeasts(year)) {
    byDate.set(daysFromCivil(date), { date, intervals: [], name });
  }
  for (const { date, name } of greekFixedHolidays(year)) {
    byDate.set(daysFromCivil(date), { date, intervals: [], name });
  }
  return [...byDate.entries()].sort(([a], [b]) => a - b).map(([, e]) => e);
}

/** Every closure across an inclusive range of years. */
export function greekCalendarExceptionsForYears(
  fromYear: number,
  toYear: number,
): readonly CalendarException[] {
  const out: CalendarException[] = [];
  for (let y = fromYear; y <= toYear; y += 1) out.push(...greekCalendarExceptions(y));
  return out;
}
