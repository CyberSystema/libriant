import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  BufferedWriter,
  xlsxSheetQueueBytes,
  assertExportSizeSane,
  createRowStreamer,
  readTableInBatches,
  writeCsvTable,
  writeJsonTables,
  writeXlsxSheets,
  type SqlClient,
  type TableShape,
} from './export-processors.js';

/**
 * performance-01: the export worker used to run `SELECT * FROM "t"` per table
 * and keep every row of every table in a JS array until the file was written —
 * 1.4 GB RSS on one audit_log, OOM-killing the 1 GB worker and every other
 * consumer sharing that process. It now reads through a server-side cursor in
 * bounded batches, so the whole correctness question moves to the batch
 * boundary: a paging loop that mishandles the last partial chunk, an
 * exactly-full chunk, or an empty table silently ships a truncated export that
 * nobody notices until a restore.
 *
 * These specs drive the real readers against a fake pg client (no DB) and
 * assert both the row-for-row output AND that nothing accumulates.
 */

type FakeRow = Record<string, unknown>;

/** A pg client that answers DECLARE/FETCH/CLOSE from in-memory tables. */
function fakeClient(tables: Record<string, FakeRow[]>) {
  const sql: string[] = [];
  let cursor: { rows: FakeRow[]; pos: number } | null = null;
  const empty = { rows: [] as FakeRow[], fields: [], rowCount: 0 };
  const client: SqlClient = {
    async query(text: string) {
      sql.push(text);
      const declared = /^DECLARE \S+ NO SCROLL CURSOR FOR SELECT \* FROM "(.+)"$/.exec(text);
      if (declared) {
        cursor = { rows: tables[declared[1]!.replace(/""/g, '"')] ?? [], pos: 0 };
        return empty;
      }
      const fetched = /^FETCH FORWARD (\d+) FROM/.exec(text);
      if (fetched) {
        if (!cursor) throw new Error('FETCH without an open cursor');
        const rows = cursor.rows.slice(cursor.pos, cursor.pos + Number(fetched[1]));
        cursor.pos += rows.length;
        return { rows, fields: [], rowCount: rows.length };
      }
      if (text.startsWith('CLOSE ')) {
        cursor = null;
        return empty;
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
  const counts = () => ({
    declares: sql.filter((s) => s.startsWith('DECLARE')).length,
    fetches: sql.filter((s) => s.startsWith('FETCH')).length,
    closes: sql.filter((s) => s.startsWith('CLOSE')).length,
  });
  return { client, sql, counts };
}

const rows = (n: number): FakeRow[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `row ${i + 1}` }));

const shape = (name: string, columns = ['id', 'title']): TableShape => ({
  name,
  columns,
  numericColumns: new Set(['id']),
});

/** Writable that keeps what it was given plus the largest single chunk. */
class MemSink extends Writable {
  chunks: string[] = [];
  maxChunk = 0;
  override _write(chunk: unknown, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    const s = String(chunk);
    this.maxChunk = Math.max(this.maxChunk, s.length);
    this.chunks.push(s);
    cb();
  }
  get text(): string {
    return this.chunks.join('');
  }
}

describe('readTableInBatches (cursor paging)', () => {
  it('delivers a final PARTIAL chunk and stops without an extra fetch', async () => {
    const { client, counts } = fakeClient({ books: rows(12) });
    const seen: number[][] = [];
    const total = await readTableInBatches(
      client,
      'books',
      async (batch) => {
        seen.push(batch.map((r) => r.id as number));
      },
      5,
    );
    expect(seen.map((b) => b.length)).toEqual([5, 5, 2]);
    expect(seen.flat()).toEqual(rows(12).map((r) => r.id));
    expect(total).toBe(12);
    // 3 fetches: the short third chunk already proves exhaustion.
    expect(counts()).toEqual({ declares: 1, fetches: 3, closes: 1 });
  });

  it('handles an EXACTLY-FULL final chunk (the off-by-one that drops rows)', async () => {
    const { client, counts } = fakeClient({ books: rows(10) });
    const seen: number[][] = [];
    const total = await readTableInBatches(
      client,
      'books',
      async (batch) => {
        seen.push(batch.map((r) => r.id as number));
      },
      5,
    );
    expect(seen.map((b) => b.length)).toEqual([5, 5]);
    expect(total).toBe(10);
    // The trailing empty fetch is required here, and must NOT reach onBatch.
    expect(counts().fetches).toBe(3);
  });

  it('emits nothing for an EMPTY table but still closes the cursor', async () => {
    const { client, counts } = fakeClient({ books: [] });
    let called = 0;
    const total = await readTableInBatches(
      client,
      'books',
      async () => {
        called++;
      },
      5,
    );
    expect(called).toBe(0);
    expect(total).toBe(0);
    expect(counts()).toEqual({ declares: 1, fetches: 1, closes: 1 });
  });

  it('closes the cursor when the writer throws mid-table', async () => {
    const { client, counts } = fakeClient({ books: rows(12) });
    await expect(
      readTableInBatches(client, 'books', async () => Promise.reject(new Error('disk full')), 5),
    ).rejects.toThrow('disk full');
    // Left open, the next table's DECLARE of the same cursor name would fail.
    expect(counts().closes).toBe(1);
  });

  it('quotes the table name (a quoted identifier must not break out of the SQL)', async () => {
    const { client, sql } = fakeClient({ 'odd"name': rows(1) });
    const total = await readTableInBatches(client, 'odd"name', async () => {}, 5);
    expect(sql[0]).toContain('SELECT * FROM "odd""name"');
    expect(total).toBe(1);
  });
});

describe('assertExportSizeSane (pre-flight, before any row is read)', () => {
  it('refuses an oversized database after ONE catalog query', async () => {
    const sql: string[] = [];
    const client: SqlClient = {
      async query(text: string) {
        sql.push(text);
        return { rows: [{ est: '30000000', bytes: '1' }], fields: [], rowCount: 1 };
      },
    };
    await expect(assertExportSizeSane(client, 25_000_000)).rejects.toThrow(/row export limit/);
    // The whole point of the fix: nothing was read before the refusal.
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('reltuples');
  });

  it('passes an Institutional-sized library through (6M rows must be exportable)', async () => {
    const client: SqlClient = {
      async query() {
        return { rows: [{ est: '6020000', bytes: '4096' }], fields: [], rowCount: 1 };
      },
    };
    await expect(assertExportSizeSane(client, 25_000_000)).resolves.toEqual({
      rows: 6_020_000,
      bytes: 4096,
    });
  });

  it('measures the same tables the export reads — _prisma_migrations excluded', async () => {
    // The estimate counted a table the enumeration skips. Small in absolute
    // terms, but an estimate over a different set of tables than the run is not
    // an estimate of the run, and it is now also the input to the disk guard.
    let sql = '';
    const client: SqlClient = {
      async query(text: string) {
        sql = text;
        return { rows: [{ est: '1', bytes: '1' }], fields: [], rowCount: 1 };
      },
    };
    await assertExportSizeSane(client);
    expect(sql).toContain("'_prisma_migrations'");
    expect(sql).toContain('NOT IN');
    // And it reports bytes, which is what the spool-space guard budgets from.
    expect(sql).toContain('pg_table_size');
  });
});

describe('createRowStreamer', () => {
  it('redacts control-plane secrets on every batch, not just the first', async () => {
    const secretRows = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1,
      passwordhash: `hash-${i}`,
    }));
    const { client } = fakeClient({ users: secretRows });
    const streamRows = createRowStreamer(client, { isControl: true }, 1_000, 5);
    const seen: FakeRow[] = [];
    await streamRows(shape('users', ['id', 'passwordhash']), async (batch) => {
      seen.push(...batch);
    });
    expect(seen).toHaveLength(7);
    expect(seen.every((r) => r.passwordhash === '[redacted]')).toBe(true);
  });

  it('trips the runaway backstop mid-stream instead of after reading everything', async () => {
    const { client, counts } = fakeClient({ loans: rows(100) });
    const streamRows = createRowStreamer(client, {}, 7, 5);
    await expect(streamRows(shape('loans'), async () => {})).rejects.toThrow(/7-row limit/);
    // Aborted on the second batch (10 > 7), not after buffering all 100.
    expect(counts().fetches).toBe(2);
  });
});

describe('writeJsonTables (streamed, byte-identical to the buffered version)', () => {
  const write = async (tables: Record<string, FakeRow[]>, batchSize = 5) => {
    const sink = new MemSink();
    const out = new BufferedWriter(sink, 64);
    const { client } = fakeClient(tables);
    const streamRows = createRowStreamer(client, {}, 1_000_000, batchSize);
    await writeJsonTables(
      out,
      Object.keys(tables).map((n) => shape(n)),
      streamRows,
    );
    await out.close();
    return sink;
  };

  it('matches JSON.stringify(…, null, 2) across batch boundaries', async () => {
    const tables = { books: rows(12), loans: rows(5) };
    const sink = await write(tables);
    expect(sink.text).toBe(JSON.stringify(tables, null, 2));
    expect(JSON.parse(sink.text).books).toHaveLength(12);
  });

  it('renders an empty table as [] and a database with no tables as {}', async () => {
    expect((await write({ books: [], loans: rows(1) })).text).toBe(
      JSON.stringify({ books: [], loans: rows(1) }, null, 2),
    );
    expect((await write({})).text).toBe('{}');
  });
});

describe('writeCsvTable (streamed)', () => {
  it('writes one header plus every row, CRLF-separated, no trailing newline', async () => {
    const sink = new MemSink();
    const out = new BufferedWriter(sink, 64);
    const { client } = fakeClient({ books: rows(12) });
    await writeCsvTable(out, shape('books'), createRowStreamer(client, {}, 1_000_000, 5));
    await out.close();
    const lines = sink.text.split('\r\n');
    expect(lines[0]).toBe('id,title');
    expect(lines).toHaveLength(13);
    expect(lines[12]).toBe('12,row 12');
  });

  it('writes only the header for an empty table', async () => {
    const sink = new MemSink();
    const out = new BufferedWriter(sink, 64);
    const { client } = fakeClient({ books: [] });
    await writeCsvTable(out, shape('books'), createRowStreamer(client, {}, 1_000_000, 5));
    await out.close();
    expect(sink.text).toBe('id,title');
  });

  it('memory in flight does not grow with the row count', async () => {
    const sink = new MemSink();
    const flushBytes = 64 * 1024;
    const out = new BufferedWriter(sink, flushBytes);
    const { client } = fakeClient({ books: rows(20_000) });
    await writeCsvTable(out, shape('books'), createRowStreamer(client, {}, 1_000_000, 5_000));
    await out.close();
    expect(sink.text.length).toBeGreaterThan(200_000);
    // Every chunk handed to the stream is one flush window (plus the row that
    // crossed it) — the old code handed the writer the whole table at once.
    expect(sink.maxChunk).toBeLessThan(flushBytes + 1_024);
    expect(sink.chunks.length).toBeGreaterThan(3);
  });
});

describe('writeXlsxSheets (ExcelJS streaming workbook writer)', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lbr-xlsx-'));
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('keeps every row across batch boundaries in a readable workbook', async () => {
    const outPath = path.join(dir, 'out.xlsx');
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: outPath,
      useSharedStrings: false,
      useStyles: false,
    });
    const { client } = fakeClient({ books: rows(12), loans: [] });
    await writeXlsxSheets(
      wb,
      [shape('books'), shape('loans')],
      createRowStreamer(client, {}, 1_000_000, 5),
    );
    await wb.commit();

    const read = new ExcelJS.Workbook();
    await read.xlsx.readFile(outPath);
    const books = read.getWorksheet('books');
    expect(books).toBeDefined();
    expect(books?.rowCount).toBe(13); // header + 12
    expect(books?.getRow(13).getCell(2).value).toBe('row 12');
    // An empty table still gets its sheet with just the header.
    expect(read.getWorksheet('loans')?.rowCount).toBe(1);
  });

  it('still exposes the zip queue the row throttle depends on', async () => {
    // ExcelJS never blocks on its own zip backpressure, so writeXlsxSheets
    // watches that queue itself and pauses when it grows. MEASURED before the
    // throttle existed: 47 MB of live Buffers per 100k rows, ~1.4 GB for one
    // 3M-row audit_log — the performance-01 OOM again, just off-heap. If a
    // future ExcelJS/archiver moves this stream the throttle would silently
    // become a no-op, so pin it here rather than in a librarian's download.
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: path.join(dir, 'queue.xlsx'),
      useSharedStrings: false,
      useStyles: false,
    });
    const ws = wb.addWorksheet('probe');
    // No await inside the loop: nothing can drain, so the queue must be visible.
    for (let i = 0; i < 5_000; i++) ws.addRow([i, 'x'.repeat(200)]).commit();
    const queued = xlsxSheetQueueBytes(ws);
    expect(queued).not.toBeNull();
    expect(queued).toBeGreaterThan(100_000);
    ws.commit();
    await wb.commit();
  });
});

describe('BufferedWriter', () => {
  it('fails the job on a stream error rather than crashing the worker', async () => {
    // ENOSPC on the shared _exports volume: an unlistened 'error' event would
    // be an uncaught exception, killing every other consumer in the process —
    // the same blast radius performance-01 was about.
    const boom = new Writable({
      write(_chunk, _enc, cb) {
        cb(new Error('ENOSPC: no space left on device'));
      },
    });
    const out = new BufferedWriter(boom, 8);
    await expect(
      (async () => {
        for (let i = 0; i < 10; i++) await out.write('0123456789');
        await out.close();
      })(),
    ).rejects.toThrow(/ENOSPC/);
  });

  it('flushes while writing rather than holding everything until close', async () => {
    const sink = new MemSink();
    const out = new BufferedWriter(sink, 16);
    for (let i = 0; i < 20; i++) await out.write('0123456789');
    expect(sink.chunks.length).toBeGreaterThan(1); // flushed mid-stream
    await out.close();
    expect(sink.text).toBe('0123456789'.repeat(20));
  });
});
