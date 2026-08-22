import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZipArchive } from 'archiver';

/**
 * The export path builds a zip and has no other runtime coverage — the only
 * spec in this directory tests secret redaction. When archiver 8 removed the
 * callable default export, `export-processors.ts` had to change how the archive
 * is CONSTRUCTED, and a typecheck cannot tell you whether the bytes still come
 * out. This pins the construct → pipe → append → finalize sequence that file
 * actually uses, so the next archiver major fails here rather than in a
 * librarian's download.
 */
describe('ZipArchive (the shape export-processors.ts relies on)', () => {
  let dir = '';
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lbr-zip-'));
  });

  it('writes a real zip containing the appended entries', async () => {
    const outPath = path.join(dir, 'out.zip');
    const output = createWriteStream(outPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    const closed = new Promise<void>((resolve, reject) => {
      output.on('close', () => resolve());
      output.on('error', reject);
      archive.on('error', reject);
    });
    archive.pipe(output);
    archive.append('name,isbn\nDune,9780441013593\n', { name: 'books/books.csv' });
    archive.append(JSON.stringify({ ok: true }), { name: 'books/meta.json' });
    await archive.finalize();
    await closed;

    const buf = await readFile(outPath);
    // PK\x03\x04 — the local file header magic. Proves a zip, not an empty file.
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(buf.length).toBeGreaterThan(64);
    // Entry names live in the central directory in plain text.
    const asText = buf.toString('latin1');
    expect(asText).toContain('books/books.csv');
    expect(asText).toContain('books/meta.json');
  });
});
