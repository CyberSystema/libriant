import { describe, expect, it } from 'vitest';
import { approxRowBytes, readTableInBatches, tableRowCeiling } from './export-processors.js';

/**
 * performance-01, the two executed bypasses of the streaming rewrite.
 *
 * A. The byte budget was blind to jsonb. `approxRowBytes` counted strings and
 *    Buffers and charged EVERYTHING ELSE a flat 16 bytes — including the parsed
 *    jsonb object node-pg hands back, which every tenant table carries as
 *    `customFields`. A 53 MB probe table reported 0.20 MiB for a batch whose
 *    real payload was 1,250 MiB, so the loop ramped to the row ceiling and the
 *    worker peaked at 2,632 MB inside a 1 GB container.
 *
 * B. The adaptation was one batch too late: the size of FETCH n+1 was derived
 *    from FETCH n, so a table whose first ~7,936 rows are narrow drove the ramp
 *    to 5,000 and the NEXT fetch pulled 5,000 rows of 1 MiB text — 5,197 MB.
 *
 * A is guarded by measuring the estimator; B by the per-table row ceiling,
 * which is measured over the WHOLE table before the cursor is declared and so
 * has no "rows not seen yet" hole to fall through.
 */

const MiB = 1024 * 1024;

/** A fake `SqlClient` that answers the catalog probe and the cursor protocol. */
function fakeClient(opts: { widestRowBytes: number; rows: number; probeThrows?: boolean }) {
  const fetched: number[] = [];
  let served = 0;
  const empty = { rows: [] as Record<string, unknown>[], fields: [], rowCount: 0 };
  const client = {
    async query(text: string) {
      if (text.startsWith('SET LOCAL')) return empty;
      if (text.includes('FROM pg_attribute')) {
        if (opts.probeThrows) throw new Error('canceling statement due to statement timeout');
        return {
          rows: [{ name: 'body', len: -1, type: 'text' }],
          fields: [],
          rowCount: 1,
        };
      }
      if (text.startsWith('SELECT COALESCE(MAX(')) {
        if (opts.probeThrows) throw new Error('canceling statement due to statement timeout');
        return { rows: [{ max: opts.widestRowBytes }], fields: [], rowCount: 1 };
      }
      if (text.startsWith('DECLARE') || text.startsWith('CLOSE')) return empty;
      if (text.startsWith('FETCH FORWARD ')) {
        const want = Number(text.split(' ')[2]);
        fetched.push(want);
        const give = Math.max(0, Math.min(want, opts.rows - served));
        served += give;
        const rows = Array.from({ length: give }, (_, i) => ({ body: `r${served - give + i}` }));
        return { rows, fields: [], rowCount: give };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
  return { client, fetched };
}

describe('approxRowBytes — bypass A: the estimator must see jsonb', () => {
  it('counts a parsed jsonb object instead of charging it 16 bytes', () => {
    // What node-pg hands back for a jsonb column: an already-parsed object.
    const payload = { note: 'Ελληνικά κείμενα '.repeat(8_000) };
    const realChars = payload.note.length;
    const row = { id: 1, customFields: payload };
    const bytes = approxRowBytes(row);
    // The audited version returned 16 + 16 for this row.
    expect(bytes).toBeGreaterThan(realChars);
    // …and does not wildly over-count either (V8 stores 2 bytes/char here).
    expect(bytes).toBeLessThan(realChars * 4);
  });

  it('counts nested arrays and objects, not just the top level', () => {
    const deep = { a: [{ b: [{ c: 'x'.repeat(50_000) }] }] };
    expect(approxRowBytes({ v: deep })).toBeGreaterThan(50_000);
  });

  it('charges an un-walkable value the FULL budget rather than under-counting', () => {
    // 60,000 keys blows the walk budget. Under-counting is what OOMs the
    // worker, so the walker must fail expensive, not cheap.
    const huge: Record<string, unknown> = {};
    for (let i = 0; i < 60_000; i++) huge[`k${i}`] = i;
    expect(approxRowBytes({ v: huge })).toBeGreaterThanOrEqual(8 * MiB);
  });

  it('still counts strings, buffers, dates and nulls', () => {
    expect(approxRowBytes({ s: 'abcd' })).toBeGreaterThan(8);
    expect(approxRowBytes({ b: Buffer.alloc(4096) })).toBeGreaterThan(4096);
    expect(approxRowBytes({ d: new Date() })).toBeGreaterThan(0);
    expect(approxRowBytes({ n: null })).toBeGreaterThan(0);
  });
});

describe('tableRowCeiling — bypass B: bound the FIRST batch, not the next one', () => {
  it('divides the byte budget by the WIDEST row in the table', async () => {
    const { client } = fakeClient({ widestRowBytes: 1 * MiB, rows: 0 });
    const ceiling = await tableRowCeiling(client, 'wide_probe', 8 * MiB, 1, 5_000);
    // 8 MiB budget / (1 MiB x the JS-bytes multiplier of 2) = 4 rows.
    expect(ceiling).toBe(4);
  });

  it('leaves an ordinary narrow table at the caller’s ceiling', async () => {
    const { client } = fakeClient({ widestRowBytes: 200, rows: 0 });
    expect(await tableRowCeiling(client, 'loans', 8 * MiB, 1, 5_000)).toBe(5_000);
  });

  it('fails SMALL, not open, when the probe cannot run', async () => {
    const { client } = fakeClient({ widestRowBytes: 0, rows: 0, probeThrows: true });
    const ceiling = await tableRowCeiling(client, 'audit_log', 8 * MiB, 1, 5_000);
    expect(ceiling).toBe(64);
    expect(ceiling).toBeLessThan(5_000);
  });
});

describe('readTableInBatches under the ceiling', () => {
  it('never asks for more rows than the widest row allows, and loses none', async () => {
    // 7,936 narrow rows then wide ones — the exact shape that defeated the
    // reactive ramp. The ceiling is computed from the widest row, so the very
    // first FETCH is already bounded.
    const { client, fetched } = fakeClient({ widestRowBytes: 1 * MiB, rows: 9_000 });
    let seen = 0;
    const total = await readTableInBatches(
      client,
      'wide_probe',
      async (rows) => {
        seen += rows.length;
      },
      {},
    );
    expect(total).toBe(9_000);
    expect(seen).toBe(9_000);
    expect(Math.max(...fetched)).toBeLessThanOrEqual(4);
  });

  it('does not probe at all in fixed-size mode (the specs that pin boundaries)', async () => {
    // The catalog probe would throw here; a numeric bound must not reach it.
    const { client, fetched } = fakeClient({ widestRowBytes: 0, rows: 12, probeThrows: true });
    const total = await readTableInBatches(client, 'books', async () => {}, 5);
    expect(total).toBe(12);
    expect(fetched).toEqual([5, 5, 5]);
  });
});
