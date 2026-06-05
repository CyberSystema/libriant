/**
 * Bytes → string decoding for text imports.
 *
 * Legacy ILS exports come in a zoo of encodings. We resolve one robustly:
 *   1. A byte-order mark wins outright (UTF-8 / UTF-16 LE / UTF-16 BE).
 *   2. An explicitly declared encoding (the librarian picked one) is honored.
 *   3. Otherwise we try STRICT UTF-8 — the modern default — and only if the
 *      bytes aren't valid UTF-8 do we fall back to Windows-1253 (the legacy
 *      Greek code page, by far the most common non-UTF-8 source for our
 *      target market). The fallback is deterministic, never throws, and is
 *      always overridable from the upload UI.
 *
 * Node ships full-ICU, so `TextDecoder` understands `windows-1253`,
 * `windows-1252`, `iso-8859-7`, etc. out of the box.
 */

export type DecodeResult = { text: string; encoding: string };

/** Strip a leading UTF-8 BOM character if one survived decoding. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function tryDecoder(buf: Buffer, encoding: string, fatal: boolean): string | null {
  try {
    return new TextDecoder(encoding, { fatal }).decode(buf);
  } catch {
    return null;
  }
}

export function decodeBuffer(buf: Buffer, declared?: string): DecodeResult {
  // 1. BOM sniffing — unambiguous.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  }

  // 2. Caller-declared encoding overrides detection.
  if (declared && declared.trim().length) {
    const norm = declared.trim().toLowerCase();
    const text = tryDecoder(buf, norm, false);
    if (text !== null) return { text: stripBom(text), encoding: norm };
    // Unknown label → fall through to auto-detect rather than throwing.
  }

  // 3. Strict UTF-8, then Greek legacy fallback.
  const strict = tryDecoder(buf, 'utf-8', true);
  if (strict !== null) return { text: stripBom(strict), encoding: 'utf-8' };

  const greek = tryDecoder(buf, 'windows-1253', false);
  if (greek !== null) return { text: stripBom(greek), encoding: 'windows-1253' };

  // Last resort — latin1 never fails and at least preserves byte values.
  return { text: stripBom(new TextDecoder('latin1').decode(buf)), encoding: 'latin1' };
}
