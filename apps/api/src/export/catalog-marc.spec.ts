import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readIso2709Record, splitIso2709 } from '@libriant/marc';
import { catalogManifest, writeCatalogMarc, type CatalogSource } from './catalog-marc.js';

/**
 * What happens to a record ISO 2709 cannot carry.
 *
 * The interesting behaviour of a catalogue export is not the ninety-nine
 * thousand records that serialize — it is the one that does not, and a real
 * catalogue produces one about that often. `writeIso2709` REFUSES rather than
 * corrupts: a field over 9,999 bytes (a multi-volume 505 contents note reaches
 * that in practice), a record over 99,999, a separator byte inside a value, a
 * tag that is not three characters. Every message names MARCXML as the answer,
 * and it is right — the XML writer has none of those ceilings.
 *
 * So the export must do three things and they are all tested here: keep going,
 * put the refused record somewhere it survives, and ACCOUNT for it. A catalogue
 * export that silently contained fewer records than the catalogue is the worst
 * outcome available — the library discovers it years later, in another system,
 * with no way to tell which records were lost.
 *
 * Driven against a fake client rather than a database, because these records are
 * exactly what a real catalogue will not hand you on demand.
 */
let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lbr-catalog-marc-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Row = { id: string; leader: string; control_number: string | null; content: unknown };

/** A client that answers the keyset walk from memory, paging like the real one. */
function fakeSource(rows: Row[]): CatalogSource {
  return {
    async query<T>(_text: string, params: unknown[]) {
      const after = String(params[0] ?? '');
      const limit = Number(params[1] ?? 500);
      const page = rows.filter((r) => r.id > after).slice(0, limit);
      return { rows: page as unknown as T[] };
    },
  };
}

const LEADER = '00000nam a2200000 a 4500';
const ok = (id: string, title: string): Row => ({
  id,
  leader: LEADER,
  control_number: `cn-${id}`,
  content: [
    { t: '008', v: '260908s2020    gr |||||||||||000 0 gre d' },
    { t: '245', i: '10', s: [{ a: title }] },
  ],
});

async function run(rows: Row[]) {
  const mrcPath = path.join(dir, `${rows.length}-${Math.random().toString(36).slice(2)}.mrc`);
  const xmlPath = `${mrcPath}.xml`;
  const result = await writeCatalogMarc({
    source: fakeSource(rows),
    mrcPath,
    xmlPath,
    assertHealthy: () => undefined,
  });
  return { result, mrcPath, xmlPath };
}

describe('an ordinary catalogue', () => {
  it('writes one ISO 2709 record per row, and they re-parse', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ok(`r${i}`, `Τίτλος ${i}`));
    const { result, mrcPath } = await run(rows);
    expect(result).toMatchObject({ total: 7, written: 7, refused: 0 });

    const bytes = new Uint8Array(await readFile(mrcPath));
    const parsed = splitIso2709(bytes);
    expect(parsed).toHaveLength(7);
    // The 245 that went in is the 245 that comes out — the whole point.
    const title = readIso2709Record(parsed[3]!).record.fields.find((f) => f.t === '245');
    expect(title).toEqual({ t: '245', i: '10', s: [{ a: 'Τίτλος 3' }] });
  });

  it('does not create an oversize.xml when nothing was refused', async () => {
    // An empty `oversize.xml` in the archive would invite exactly the reading it
    // exists to prevent — "some of my records are in the other file".
    const { xmlPath } = await run([ok('a', 'A')]);
    await expect(stat(xmlPath)).rejects.toThrow();
  });

  it('pages, rather than reading the catalogue into memory', async () => {
    // 1,200 rows against a page size of 500: three pages. The assertion is only
    // that the walk terminates and sees every row — the paging itself is what
    // stops a 5M-record catalogue from being one array.
    const rows = Array.from({ length: 1200 }, (_, i) =>
      ok(`p${String(i).padStart(5, '0')}`, `T${i}`),
    );
    const { result } = await run(rows);
    expect(result.total).toBe(1200);
    expect(result.written).toBe(1200);
  });
});

describe('a record ISO 2709 cannot carry', () => {
  /** A 505 contents note past the 9,999-byte field ceiling. Real, and common. */
  const fieldTooLong = (id: string): Row => ({
    id,
    leader: LEADER,
    control_number: `cn-${id}`,
    content: [
      { t: '245', i: '10', s: [{ a: 'A set in many volumes' }] },
      { t: '505', i: '0 ', s: [{ a: 'v. 1. Πρόλογος -- '.repeat(700) }] },
    ],
  });

  /**
   * A subfield delimiter (0x1F) inside a value.
   *
   * ISO 2709 has no escape for it, so `writeIso2709` refuses rather than
   * emitting a record that would parse as two subfields at the far end. Written
   * as `\u001f` rather than the literal byte on purpose: a raw control character
   * in a source file is invisible to a reader and one editor away from being
   * silently removed.
   */
  const notEncodable = (id: string): Row => ({
    id,
    leader: LEADER,
    control_number: `cn-${id}`,
    content: [{ t: '245', i: '10', s: [{ a: 'Before\u001fAfter' }] }],
  });

  it('keeps going, and writes the refused record to oversize.xml', async () => {
    const rows = [ok('a', 'First'), fieldTooLong('b'), ok('c', 'Third'), notEncodable('d')];
    const { result, mrcPath, xmlPath } = await run(rows);

    expect(result.total).toBe(4);
    expect(result.written).toBe(2);
    expect(result.refused).toBe(2);
    // total = written + refused, ALWAYS. It is the one arithmetic a librarian
    // reading the manifest checks.
    expect(result.written + result.refused).toBe(result.total);

    // The good records are whole and parseable — a refusal must contribute ZERO
    // bytes to the stream, or every record after it is unreadable too.
    const parsed = splitIso2709(new Uint8Array(await readFile(mrcPath)));
    expect(parsed).toHaveLength(2);

    const xml = await readFile(xmlPath, 'utf8');
    expect(xml).toContain('<collection xmlns="http://www.loc.gov/MARC21/slim">');
    expect(xml).toContain('</collection>');
    expect(xml).toContain('A set in many volumes');
    // MARCXML has none of ISO 2709's ceilings, which is why it is the answer
    // rather than a consolation prize.
    expect(xml).toContain('Πρόλογος');
  });

  it('names each refusal with the codec code and the record it happened to', async () => {
    const { result } = await run([fieldTooLong('x'), notEncodable('y')]);
    expect(result.refusals.map((r) => r.code).sort()).toEqual([
      'data-not-encodable',
      'field-too-long',
    ]);
    expect(result.refusals.map((r) => r.recordId).sort()).toEqual(['x', 'y']);
    expect(result.refusals[0]!.controlNumber).toMatch(/^cn-/);
    // The message names MARCXML, which is what makes it actionable rather than
    // an apology.
    expect(result.refusals.some((r) => /MARCXML/i.test(r.message))).toBe(true);
  });

  it('accounts for every record in the manifest', async () => {
    const { result } = await run([ok('a', 'A'), fieldTooLong('b')]);
    const manifest = JSON.parse(catalogManifest(result, '2026-09-10T00:00:00.000Z')) as {
      records: { total: number; inCatalogueMrc: number; inOversizeXml: number };
      refusalsTruncated: boolean;
      refusals: { code: string }[];
    };
    expect(manifest.records).toEqual({ total: 2, inCatalogueMrc: 1, inOversizeXml: 1 });
    expect(manifest.refusalsTruncated).toBe(false);
    expect(manifest.refusals[0]!.code).toBe('field-too-long');
  });

  it('writes a manifest even when nothing was refused', async () => {
    // "0 refused" is the assurance a librarian is looking for, and its absence
    // is not the same statement.
    const { result } = await run([ok('a', 'A')]);
    const manifest = JSON.parse(catalogManifest(result, '2026-09-10T00:00:00.000Z')) as {
      records: { total: number; inOversizeXml: number };
      refusals: unknown[];
    };
    expect(manifest.records.total).toBe(1);
    expect(manifest.records.inOversizeXml).toBe(0);
    expect(manifest.refusals).toEqual([]);
  });
});

describe('the guard is consulted', () => {
  it('stops when the shared run guard says to', async () => {
    // The four-hour deadline and the 2 GiB disk reserve belong to
    // `ExportRunGuard`, and this walk must actually ask. An export that only
    // checked at the end would be one that fills the volume and then reports it.
    const rows = Array.from({ length: 3 }, (_, i) => ok(`g${i}`, `T${i}`));
    let asked = 0;
    await expect(
      writeCatalogMarc({
        source: fakeSource(rows),
        mrcPath: path.join(dir, 'guard.mrc'),
        xmlPath: path.join(dir, 'guard.xml'),
        assertHealthy: () => {
          asked += 1;
          throw new Error('spool volume is nearly full');
        },
      }),
    ).rejects.toThrow('nearly full');
    // Before the first page, not after the last.
    expect(asked).toBe(1);
  });
});
