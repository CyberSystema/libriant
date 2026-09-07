import { describe, expect, it } from 'vitest';
import type { MarcRecord } from '@libriant/marc';
import { current005, format005, next005, parse005, stamp005, TICK_MS } from './marc-005.js';

const rec = (fields: MarcRecord['fields'] = []): MarcRecord => ({
  leader: 'x'.repeat(24),
  fields,
});

describe('MARC 005', () => {
  it('formats as yyyymmddhhmmss.f in UTC', () => {
    // 2026-09-08T12:34:56.780Z → tenths, truncated, not rounded: .7 not .8
    expect(format005(Date.UTC(2026, 8, 8, 12, 34, 56, 780))).toBe('20260908123456.7');
    expect(format005(Date.UTC(2026, 0, 1, 0, 0, 0, 0))).toBe('20260101000000.0');
  });

  it('round-trips through parse', () => {
    const ms = Date.UTC(2026, 8, 8, 12, 34, 56, 700);
    expect(parse005(format005(ms))).toBe(ms);
  });

  it('tolerates the 005 values real exporters actually write', () => {
    // A write must not fail because a 1993 exporter was sloppy. Each of these
    // means "there is nothing to be monotonic against", not "reject the save".
    expect(parse005('20260908123456')).toBe(Date.UTC(2026, 8, 8, 12, 34, 56, 0));
    expect(parse005('')).toBeNull();
    expect(parse005(undefined)).toBeNull();
    expect(parse005('        ')).toBeNull();
    expect(parse005('not a date')).toBeNull();
    expect(parse005('20261308123456.0')).toBeNull(); // month 13
  });

  describe('monotonicity — the criterion the wall clock cannot satisfy', () => {
    it('uses the clock when the clock has moved', () => {
      const t0 = Date.UTC(2026, 8, 8, 12, 0, 0, 0);
      const r = rec([{ t: '005', v: format005(t0) }]);
      expect(next005(r, t0 + 5_000)).toBe(format005(t0 + 5_000));
    });

    it('advances by one tick when the clock has NOT moved', () => {
      // THE case. Measured: a full write transaction takes 1.60 ms and this
      // field has 100 ms of resolution, so two consecutive edits land on the
      // same instant essentially always.
      const t0 = Date.UTC(2026, 8, 8, 12, 0, 0, 0);
      const r = rec([{ t: '005', v: format005(t0) }]);
      expect(next005(r, t0)).toBe(format005(t0 + TICK_MS));
      // And when the clock has moved, but by less than a tick.
      expect(next005(r, t0 + 40)).toBe(format005(t0 + TICK_MS));
    });

    it('gives ten DISTINCT stamps for ten edits at one instant', () => {
      // The measured failure, reproduced: ten sequential writes took 16.0 ms
      // total and a wall-clock stamper produced `20260907204100.1` ten times.
      // This is the assertion an HTTP-driven test cannot make, because two
      // supertest round trips are usually more than 100 ms apart — so the
      // obvious test passes on the broken implementation.
      const t0 = Date.UTC(2026, 8, 8, 12, 0, 0, 0);
      let r = rec();
      const stamps: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        r = stamp005(r, t0); // the SAME instant every time
        stamps.push(current005(r)!);
      }
      expect(new Set(stamps).size).toBe(10);
      // Strictly increasing, which is what the criterion actually says.
      expect([...stamps].sort()).toEqual(stamps);
      // And a whole second has been consumed by ten tenths.
      expect(stamps[9]).toBe(format005(t0 + 9 * TICK_MS));
    });

    it('never goes backwards when the clock does', () => {
      // NTP steps, a VM resuming, a container clock skewing. 005 orders
      // versions; a version that claims to precede the one it replaces is worse
      // than one that is a little ahead of the wall.
      const t0 = Date.UTC(2026, 8, 8, 12, 0, 0, 0);
      const r = rec([{ t: '005', v: format005(t0) }]);
      expect(next005(r, t0 - 60_000)).toBe(format005(t0 + TICK_MS));
    });
  });

  describe('stamping', () => {
    it('replaces an existing 005 rather than adding a second', () => {
      const t0 = Date.UTC(2026, 8, 8, 12, 0, 0, 0);
      const r = stamp005(rec([{ t: '005', v: '19930101000000.0' }]), t0);
      expect(r.fields.filter((f) => f.t === '005')).toHaveLength(1);
      expect(current005(r)).toBe(format005(t0));
    });

    it('inserts in tag order, so the next diff shows no spurious move', () => {
      const t0 = Date.UTC(2026, 8, 8, 12, 0, 0, 0);
      const r = stamp005(
        rec([
          { t: '001', v: 'abc' },
          { t: '008', v: 'x'.repeat(40) },
          { t: '245', i: '10', s: [{ a: 'Title' }] },
        ]),
        t0,
      );
      expect(r.fields.map((f) => f.t)).toEqual(['001', '005', '008', '245']);
    });

    it('does not mutate its input', () => {
      const before = rec([{ t: '245', i: '10', s: [{ a: 'Title' }] }]);
      const snapshot = JSON.stringify(before);
      stamp005(before, Date.UTC(2026, 8, 8, 12, 0, 0, 0));
      expect(JSON.stringify(before)).toBe(snapshot);
    });
  });
});
