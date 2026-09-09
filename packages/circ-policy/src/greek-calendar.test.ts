import assert from 'node:assert/strict';
import test from 'node:test';
import { civilKey, daysFromCivil, weekdayOf } from './calendar.js';
import {
  greekCalendarExceptions,
  greekCalendarExceptionsForYears,
  greekFixedHolidays,
  greekMovableFeasts,
  orthodoxPascha,
} from './greek-calendar.js';

/**
 * The acceptance criterion names "Orthodox movable feasts 2026–2030", and these
 * are the published dates: the Ecumenical Patriarchate's, not an algorithm's
 * output copied back into its own test.
 */
const PUBLISHED: Readonly<Record<number, string>> = {
  2024: '2024-05-05',
  2025: '2025-04-20',
  2026: '2026-04-12',
  2027: '2027-05-02',
  2028: '2028-04-16',
  2029: '2029-04-08',
  2030: '2030-04-28',
  2031: '2031-04-13',
  2032: '2032-05-02',
};

test('Orthodox Pascha matches the published dates', () => {
  for (const [year, expected] of Object.entries(PUBLISHED)) {
    assert.equal(civilKey(orthodoxPascha(Number(year))), expected, year);
  }
});

test('Pascha is always a Sunday', () => {
  for (let y = 1900; y <= 2099; y += 1) {
    assert.equal(weekdayOf(daysFromCivil(orthodoxPascha(y))), 0, String(y));
  }
});

test('it is NOT Gregorian Easter, and that is the whole point', () => {
  // Western Easter 2026 is 5 April; Orthodox is 12 April — a full week. An ILS
  // that reaches for Gauss or the Anonymous Gregorian algorithm, which is what a
  // search for "Easter algorithm" returns, closes the library on the wrong week
  // every year the two diverge.
  assert.equal(civilKey(orthodoxPascha(2026)), '2026-04-12');
  assert.notEqual(civilKey(orthodoxPascha(2026)), '2026-04-05');
});

test('the +13 day offset is asserted rather than assumed', () => {
  // Valid 1900–2099; the Julian drift makes it 14 from 2100. A constant that is
  // right for a century and then silently wrong is exactly the kind this repo
  // refuses to leave undocumented.
  assert.throws(() => orthodoxPascha(2100), RangeError);
  assert.throws(() => orthodoxPascha(1899), RangeError);
});

test('the six movable closures hang off Pascha at the right offsets', () => {
  const feasts = greekMovableFeasts(2026);
  const byName = new Map(feasts.map((f) => [f.name, civilKey(f.date)]));
  assert.equal(byName.get('Καθαρά Δευτέρα'), '2026-02-23', 'Pascha minus 48');
  assert.equal(byName.get('Μεγάλη Παρασκευή'), '2026-04-10');
  assert.equal(byName.get('Μέγα Σάββατο'), '2026-04-11');
  assert.equal(byName.get('Κυριακή του Πάσχα'), '2026-04-12');
  assert.equal(byName.get('Δευτέρα του Πάσχα'), '2026-04-13');
  assert.equal(byName.get('Αγίου Πνεύματος'), '2026-06-01', 'Pascha plus 50');
  // Clean Monday is always a Monday and Holy Spirit always a Monday too — the
  // Greek long weekends the whole country plans around.
  assert.equal(weekdayOf(daysFromCivil(feasts[0]!.date)), 1);
});

test('the fixed national holidays are all eight', () => {
  const names = greekFixedHolidays(2026).map((h) => h.name);
  assert.deepEqual(names, [
    'Πρωτοχρονιά',
    'Θεοφάνεια',
    'Ευαγγελισμός / Εθνική Εορτή',
    'Πρωτομαγιά',
    'Κοίμηση της Θεοτόκου',
    'Επέτειος του ΟΧΙ',
    'Χριστούγεννα',
    'Σύναξη Θεοτόκου',
  ]);
});

test('exceptions are closed-all-day rows, sorted, one per date', () => {
  const rows = greekCalendarExceptions(2026);
  assert.ok(
    rows.every((r) => r.intervals.length === 0),
    'closed, not "different hours"',
  );
  const keys = rows.map((r) => civilKey(r.date));
  assert.deepEqual([...keys], [...keys].sort(), 'sorted');
  assert.equal(new Set(keys).size, keys.length, 'one row per date');
});

test('a collision between a movable and a fixed feast produces ONE row', () => {
  // 2016: Ευαγγελισμός on 25 March WAS Μεγάλη Παρασκευή. Two rows for one date
  // would violate the (calendar_id, date) uniqueness phase 13 puts on the table,
  // and the FIXED name is the one printed on the public notice.
  const rows = greekCalendarExceptions(2016);
  const onMar25 = rows.filter((r) => civilKey(r.date) === '2016-03-25');
  assert.equal(onMar25.length, 1);
  assert.equal(onMar25[0]!.name, 'Ευαγγελισμός / Εθνική Εορτή');
});

test('Πρωτομαγιά is emitted on 1 May even in the years it moved', () => {
  // 2016, 2021 and 2024 all had the Ministry of Labour relocate it, each to a
  // different date, because it fell inside Holy Week. That is not computable
  // from a rule — which is the argument for seeding an EDITABLE ROW rather than
  // evaluating a predicate at query time, where a librarian's correction would
  // be overwritten on the next run.
  for (const year of [2016, 2021, 2024, 2026]) {
    const may1 = greekCalendarExceptions(year).find((r) => civilKey(r.date).endsWith('-05-01'));
    assert.ok(may1 !== undefined, String(year));
    assert.equal(may1.name, 'Πρωτομαγιά');
  }
});

test('a multi-year seed covers 2026-2030 with no gaps', () => {
  const rows = greekCalendarExceptionsForYears(2026, 2030);
  const years = new Set(rows.map((r) => r.date.year));
  assert.deepEqual([...years].sort(), [2026, 2027, 2028, 2029, 2030]);
  // Eight fixed plus six movable, minus any collisions, every year.
  assert.ok(rows.length >= 5 * 13, `expected ~70 closures, got ${rows.length}`);
});
