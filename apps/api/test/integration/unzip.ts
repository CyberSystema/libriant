import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

/**
 * Read the entries out of a zip, for tests that assert what an export contains.
 *
 * ## Why this is here rather than a package
 *
 * The repo WRITES zips (`archiver`) and has never needed to read one: the only
 * existing archive assertion checks the `PK\x03\x04` magic and greps the central
 * directory for entry names as latin1 text. That was enough while the contents
 * were CSVs whose bytes came from a function the same suite already tested.
 *
 * Phase 11b's catalogue export is different — the whole claim is that
 * `catalogue.mrc` inside the archive re-parses to the same 10,000 records — so
 * the bytes have to come back out. Adding a zip library to `devDependencies` for
 * one function is exactly the trade `check:supply-chain` exists to make
 * deliberate, and the central directory is 40 lines of documented structure. So
 * it is hand-rolled, which is also this repo's stated line: hand-roll formats,
 * never primitives. `inflateRawSync` from `node:zlib` is the primitive, and it
 * is Node's.
 *
 * ## What it does NOT do
 *
 * Zip64, encryption, multi-disk, and data descriptors with unknown sizes. This
 * reads what `archiver` writes with `{ zlib: { level: 9 } }` — stored (method 0)
 * and deflated (method 8) entries with sizes in the central directory — and
 * throws on anything else rather than returning something plausible.
 */
export async function unzip(zipPath: string): Promise<Map<string, Buffer>> {
  const buf = await readFile(zipPath);
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);

  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central header at ${at}`);
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');

    if (buf.readUInt32LE(localAt) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    // The LOCAL header's own name/extra lengths, which may differ from the
    // central directory's — archiver writes a different extra field in each.
    const localNameLen = buf.readUInt16LE(localAt + 26);
    const localExtraLen = buf.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataAt, dataAt + compressedSize);

    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw));
    else throw new Error(`${name}: unsupported compression method ${method}`);

    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * The End of Central Directory record, scanned backwards.
 *
 * Its signature can be followed by a comment of up to 65,535 bytes, so there is
 * no fixed offset — the format genuinely requires a backwards scan, which is why
 * every zip reader does this.
 */
function findEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('not a zip: no end-of-central-directory record');
}
