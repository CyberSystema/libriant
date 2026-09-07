/**
 * Byte helpers, written against `Uint8Array` because this package may not use
 * `node:` built-ins.
 *
 * That constraint is not stylistic. `packages/marc` is compiled into the Tauri
 * client's webview in M8 and its logic is mirrored by the Rust core; a package
 * that reached for `Buffer` would fork into a Node copy and a browser copy, and
 * the two would disagree about exactly the thing nobody tests — the boundary
 * bytes. `packages/marc/tsconfig.json` sets `types: []`, so `Buffer`, `process`
 * and every `node:` specifier are compile errors rather than review findings.
 */

/** The three ISO 2709 delimiters. */
export const SUBFIELD_DELIMITER = 0x1f;
export const FIELD_TERMINATOR = 0x1e;
export const RECORD_TERMINATOR = 0x1d;

export const ESCAPE = 0x1b;

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
const UTF8_LOSSY = new TextDecoder('utf-8');
const UTF8_ENCODER = new TextEncoder();

/**
 * Decode bytes as one code point each — byte 0xNN becomes U+00NN.
 *
 * Written as a loop rather than `new TextDecoder('latin1')` because that label
 * is a lie the platform tells: WHATWG maps `latin1`, `iso-8859-1` AND `ascii`
 * all onto **windows-1252**, so bytes 0x80-0x9F come back as U+20AC, U+0178 and
 * the rest of the CP1252 punctuation block instead of as themselves. Measured on
 * Node 26: `new TextDecoder('latin1').encoding === 'windows-1252'`, and
 * `decode([0x80])` is U+20AC.
 *
 * That matters here because this function reads the STRUCTURE — the leader, the
 * directory, tags, indicators and subfield codes — and {@link encodeLatin1}
 * writes it back one byte per code point. With CP1252 in the middle, a record
 * carrying 0x80 in a tag reads as U+20AC and then fails to re-encode, which is a
 * confusing error a long way from its cause.
 */
export function decodeBytesAsCodePoints(bytes: Uint8Array, from = 0, to = bytes.length): string {
  const end = Math.min(to, bytes.length);
  let out = '';
  // Chunked rather than a single spread: `String.fromCharCode(...bytes)` blows
  // the argument limit on a large field.
  const CHUNK = 4096;
  for (let at = Math.max(from, 0); at < end; at += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(at, Math.min(at + CHUNK, end)));
  }
  return out;
}

/**
 * Decode the structural parts: leader, directory, tags, indicators, codes.
 *
 * One byte, one code point, no character-set interpretation at all — which is
 * what "structure" means. Field DATA never comes through here; it goes to
 * {@link decodeUtf8} or the MARC-8 decoder.
 */
export function decodeLatin1(bytes: Uint8Array, from = 0, to = bytes.length): string {
  return decodeBytesAsCodePoints(bytes, from, to);
}

/**
 * Decode as ASCII, with anything above 0x7E reported rather than reinterpreted.
 *
 * Returns `clean: false` when a byte was outside ASCII, so a caller can raise an
 * anomaly instead of silently accepting a structural byte that cannot be what it
 * claims to be.
 */
export function decodeAscii(
  bytes: Uint8Array,
  from = 0,
  to = bytes.length,
): { text: string; clean: boolean } {
  const text = decodeBytesAsCodePoints(bytes, from, to);
  let clean = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7e) {
      clean = false;
      break;
    }
  }
  return { text, clean };
}

/** Decode UTF-8, reporting whether the bytes were actually valid. */
export function decodeUtf8(
  bytes: Uint8Array,
  from = 0,
  to = bytes.length,
): { text: string; valid: boolean } {
  const slice = bytes.subarray(from, to);
  try {
    return { text: UTF8_STRICT.decode(slice), valid: true };
  } catch {
    // U+FFFD in place of each bad sequence. Losing the record entirely because
    // one field was mis-encoded is worse than importing it with a visible
    // replacement character and an anomaly saying so.
    return { text: UTF8_LOSSY.decode(slice), valid: false };
  }
}

export function encodeUtf8(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text);
}

/**
 * Encode a string as one byte per code point, for the structural parts.
 *
 * Throws above U+00FF: a tag or a leader position that is not Latin-1 is a
 * programming error, not data to be silently truncated.
 */
export function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0xff) throw new RangeError(`Cannot encode U+${c.toString(16)} as a structural byte.`);
    out[i] = c;
  }
  return out;
}

/**
 * Read `width` ASCII digits as an unsigned integer.
 *
 * Returns `NaN` on anything that is not a digit, rather than `parseInt`'s
 * prefix-parsing — `parseInt('12 4')` is 12, and a directory entry read that way
 * points at the wrong byte and yields a field that looks plausible. Leading
 * SPACES are accepted because real exporters pad with them, and `spacePadded`
 * says so, so the caller can record an anomaly instead of the reader deciding
 * alone.
 */
export function readUint(
  bytes: Uint8Array,
  from: number,
  width: number,
): { value: number; spacePadded: boolean } {
  if (from + width > bytes.length) return { value: Number.NaN, spacePadded: false };
  let value = 0;
  let seenDigit = false;
  let spacePadded = false;
  for (let i = from; i < from + width; i++) {
    const b = bytes[i] as number;
    if (b === 0x20 && !seenDigit) {
      spacePadded = true;
      continue;
    }
    if (b < 0x30 || b > 0x39) return { value: Number.NaN, spacePadded };
    seenDigit = true;
    value = value * 10 + (b - 0x30);
  }
  return { value: seenDigit ? value : Number.NaN, spacePadded };
}

/** Left-pad a non-negative integer with zeros to exactly `width` digits. */
export function padUint(value: number, width: number): string {
  const s = String(Math.trunc(value));
  if (s.length > width) throw new RangeError(`${value} does not fit in ${width} digits.`);
  return s.padStart(width, '0');
}

/** Concatenate byte chunks into one buffer. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Lowercase hex, for hashes and for error messages that quote bytes. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
