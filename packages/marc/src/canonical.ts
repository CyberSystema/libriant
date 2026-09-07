import { encodeUtf8, toHex } from './bytes.js';
import { LEADER, MarcError } from './types.js';
import {
  isDataField,
  subfieldCode,
  subfieldValue,
  type MarcField,
  type MarcRecord,
} from './types.js';

/**
 * The canonical form of a record, and the hash taken over it.
 *
 * `marc_records.content_hash` is "sha256 over canonical NFC JSON, EXCLUDING
 * 005". This module is the definition of "canonical", and every rule below is
 * written out because a canonicalizer whose rules are implicit is one that
 * diverges the moment a second implementation exists — and a second
 * implementation is scheduled: the Rust core in M8 must agree with this
 * byte-for-byte or the offline client raises a conflict on a record nobody
 * touched.
 *
 * The hash decides three things, which is why the rules are worth this much
 * prose: whether a save writes a new version at all, whether a concurrent edit
 * gets a 409, and whether two implementations in two languages think a record is
 * the same record.
 *
 * ## The rules
 *
 * 1. **NFC.** Every string — subfield values, control values, indicators, tags,
 *    the leader. `'ά'` as U+03AC and as U+03B1 U+0301 are the same title and
 *    must be the same hash; they are two different JavaScript strings, one and
 *    two code units, two and four UTF-8 bytes.
 * 2. **Fixed key order,** written by an explicit serializer rather than
 *    `JSON.stringify` on an object built elsewhere. `JSON.stringify` preserves
 *    insertion order, so `{t, i}` and `{i, t}` produce different bytes for
 *    identical content — and every test builds its objects with one literal
 *    shape, so this is the failure that never shows up until a second code path
 *    constructs a field.
 * 3. **005 is OMITTED,** not blanked. It is a transaction timestamp stamped on
 *    every write; including it would mean every save changed the record. Omitted
 *    rather than emptied so that a record which never had an 005 and a record
 *    whose 005 was cleared hash identically.
 * 4. **`x` is excluded.** Anomalies are provenance about the SOURCE, already
 *    persisted in `marc_record_contents.anomalies`. Inside the hash, fixing a
 *    reader defect — the work of this very phase — would change the hash of
 *    every record ever imported.
 * 5. **The leader is included, with its DERIVED positions zeroed.** The master
 *    architecture does not settle this and somebody has to. Excluding the leader
 *    entirely would make a change to Leader/17 (encoding level) write no version
 *    and be invisible to an `expectedContentHash` precondition. Including it raw
 *    would make the hash unstable across a serialize-and-reparse, because
 *    /00-04 and /12-16 are recomputed on every write. So they are zeroed and
 *    everything else is kept.
 * 6. **No whitespace, no BOM, UTF-8.**
 */

/** Never part of the hash: stamped on every write. */
export const HASH_EXCLUDED_TAGS: ReadonlySet<string> = new Set(['005']);

function nfc(value: string): string {
  return value.normalize('NFC');
}

/** JSON string escaping, over the canonical NFC text. */
function quote(value: string): string {
  return JSON.stringify(nfc(value));
}

/**
 * The leader as it enters the hash: derived positions zeroed.
 *
 * `/00-04` is the record's byte length and `/12-16` its base address. Both are
 * recomputed from the serialized form, so a record that round-trips through
 * ISO 2709 comes back with different bytes there and identical content. Hashing
 * them would make `write(read(b))` a different record from `b`.
 */
export function canonicalLeader(leader: string): string {
  const padded = leader.padEnd(24, ' ').slice(0, 24);
  const zeros = (n: number) => '0'.repeat(n);
  return (
    zeros(5) +
    padded.slice(LEADER.recordStatus[0], LEADER.baseAddress[0]) +
    zeros(5) +
    padded.slice(LEADER.encodingLevel[0])
  );
}

/**
 * The canonical JSON text of a record.
 *
 * Built by hand, key by key, in a fixed order. Read rule 2 above before
 * replacing this with an object literal and `JSON.stringify`.
 */
export function canonicalJson(record: MarcRecord): string {
  const parts: string[] = [];
  for (const f of record.fields) {
    if (HASH_EXCLUDED_TAGS.has(f.t)) continue;
    if (isDataField(f)) {
      const subfields = f.s
        .map((s) => `{${quote(subfieldCode(s))}:${quote(subfieldValue(s))}}`)
        .join(',');
      parts.push(`{"t":${quote(f.t)},"i":${quote(f.i)},"s":[${subfields}]}`);
    } else {
      parts.push(`{"t":${quote(f.t)},"v":${quote(f.v)}}`);
    }
  }
  return `{"leader":${quote(canonicalLeader(record.leader))},"fields":[${parts.join(',')}]}`;
}

/**
 * The record's content hash: SHA-256 over {@link canonicalJson}.
 *
 * Async because it uses WebCrypto — `crypto.subtle` — rather than a `node:`
 * import, which is what lets this package run unchanged in a webview and in the
 * Tauri client. Every caller in the write path is already async (it is inside a
 * database transaction), so the cost is a keyword; the one place it bites is a
 * synchronous comparison in a test, which should await once and compare hex.
 */
export async function contentHash(record: MarcRecord): Promise<Uint8Array> {
  // `crypto.subtle` is undefined outside a secure context, so a browser on an
  // http:// LAN or staging origin would otherwise fail with "Cannot read
  // properties of undefined" from inside a hash function, which is not a
  // diagnosable error. Say what is missing and why.
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new MarcError(
      'no-webcrypto',
      'crypto.subtle is not available. WebCrypto requires a secure context: serve the ' +
        'application over https (or localhost). The record hash cannot be computed without it.',
    );
  }
  // `new Uint8Array(...)` re-wraps over a plain ArrayBuffer. TextEncoder's
  // result is typed against `ArrayBufferLike`, which includes SharedArrayBuffer
  // and so is not a `BufferSource`; the copy is a few hundred bytes and buys a
  // cast-free call.
  const bytes = new Uint8Array(encodeUtf8(canonicalJson(record)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(digest);
}

/** The content hash as lowercase hex, for logs, ETags and test assertions. */
export async function contentHashHex(record: MarcRecord): Promise<string> {
  return toHex(await contentHash(record));
}

/**
 * Whether two records are the same CONTENT, without hashing.
 *
 * Cheaper than two digests and, more usefully, synchronous — so the write path
 * can decide "this save changes nothing, write no version" without awaiting.
 */
export function sameContent(a: MarcRecord, b: MarcRecord): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** A copy of the record with every string NFC-normalized. The write-path policy. */
export function toNfc(record: MarcRecord): MarcRecord {
  return mapStrings(record, (s) => s.normalize('NFC'));
}

/** A copy with every string NFD-normalized. For `export_normalization='nfd'`. */
export function toNfd(record: MarcRecord): MarcRecord {
  return mapStrings(record, (s) => s.normalize('NFD'));
}

function mapStrings(record: MarcRecord, f: (s: string) => string): MarcRecord {
  const fields: MarcField[] = record.fields.map((field) =>
    isDataField(field)
      ? { ...field, s: field.s.map((s) => ({ [subfieldCode(s)]: f(subfieldValue(s)) })) }
      : { ...field, v: f(field.v) },
  );
  // The leader is structural ASCII; normalizing it would be a no-op at best and
  // a corruption if a stray non-ASCII byte ever landed there.
  return { leader: record.leader, fields };
}
