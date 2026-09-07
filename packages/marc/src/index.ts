/**
 * `@libriant/marc` — the MARC codec.
 *
 * The system of record for a Libriant catalogue is a MARC record, and this is
 * the only place that knows how one is shaped, read, written, addressed, edited,
 * compared and hashed. Everything above it — the store (phase 10), the
 * projection and the export endpoints (phase 11), the validator (phase 8), copy
 * cataloguing (phase 30), OAI-PMH and SRU (M6) — is a caller.
 *
 * ## The constraint that shapes the whole package
 *
 * **No `node:` built-ins.** `packages/marc/tsconfig.json` sets `types: []`, so
 * `Buffer`, `process` and every `node:` specifier are compile errors, not review
 * findings. The reason is scheduled work: M8 renders these same records in a
 * Tauri webview and mirrors this logic in a Rust core, and a package that forked
 * into a Node copy and a browser copy would disagree about exactly the thing
 * nobody tests — the boundary bytes. Hence `Uint8Array` rather than `Buffer`,
 * `TextDecoder` rather than `iconv`, and `crypto.subtle` (async) rather than
 * `node:crypto`.
 *
 * ## Where to start
 *
 * | I want to…                          | Use                                    |
 * | ----------------------------------- | -------------------------------------- |
 * | read a `.mrc` file                  | `readIso2709`                          |
 * | write one                           | `writeIso2709`                         |
 * | read or write MARCXML               | `readMarcXml` / `writeMarcXml`         |
 * | exchange JSON with another system   | `toMarcJson` / `fromMarcJson`          |
 * | name one place in a record          | `parseMarcPath`, `get`                 |
 * | change a record                     | `applyOps` (`invert` undoes ONE op)    |
 * | show what changed                   | `diff`                                 |
 * | decide whether to write a version   | `sameContent`, `contentHash`           |
 * | check a record against a format     | `validate` + `shippedSchema`           |
 * | decide whether an EDIT may be saved | `validateDelta`                        |
 * | start a new record                  | `SHIPPED_TEMPLATES`, `recordFromTemplate` |
 */

export * from './types.js';
export * from './iso2709.js';
export * from './marcxml.js';
export * from './marc-json.js';
export * from './path.js';
export * from './ops.js';
export * from './diff.js';
export * from './canonical.js';
export * from './avram.js';
export * from './issues.js';
export * from './validate.js';
export * from './rules.js';
export * from './templates.js';
export {
  SHIPPED_PROFILES,
  UNAVAILABLE_PROFILES,
  shippedSchema,
  shippedSchemas,
  type ShippedProfile,
} from './definitions.js';
export * from './linkage.js';
export {
  canEncodeMarc8,
  decodeMarc8,
  encodeMarc8,
  newMarc8State,
  type Marc8DecodeResult,
  type Marc8State,
} from './marc8.js';
export { MARC8_SET, MARC8_SET_NAME, type Marc8SetId } from './marc8-sets.js';
export { SUPPORTED_TABLES, type Marc8Table } from './marc8-tables.js';
export {
  bytesEqual,
  concatBytes,
  decodeAscii,
  decodeBytesAsCodePoints,
  decodeLatin1,
  decodeUtf8,
  encodeLatin1,
  encodeUtf8,
  toHex,
  FIELD_TERMINATOR,
  RECORD_TERMINATOR,
  SUBFIELD_DELIMITER,
} from './bytes.js';

/**
 * Greek folding and the shared primitives, re-exported so a caller working with
 * records has one import.
 *
 * These live in `@libriant/shared` because the SAME fold has to run in
 * TypeScript, in a Postgres index expression, in an OpenSearch analyzer and in
 * the Rust core — `check:greek-folding` is the gate that holds all four to one
 * answer. Re-exporting rather than reimplementing is the entire point: a second
 * `foldGreek` in this package would be a fifth answer nothing checks.
 */
export { foldGreek, greekPhoneticKey, stripNonfilingArticle } from '@libriant/shared/greek';
