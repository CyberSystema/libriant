import { UnsupportedMediaTypeException } from '@nestjs/common';

/**
 * input-and-files-09. The MIME allowlist in `allowed-types.ts` is applied to
 * the `Content-Type` the client typed into the multipart part header, and
 * nothing ever read the bytes: an HTML document declared `image/png` was
 * accepted as a book cover (201) and read back byte-identical. Today the damage
 * is contained by serving every download `Content-Disposition: attachment` +
 * `X-Content-Type-Options: nosniff`, so no browser renders it — which is why
 * this is low and not urgent. But the lie is what gets stored, and the day one
 * endpoint serves a cover inline (a public OPAC page, an email attachment, a
 * PDF viewer) the allowlist turns out to have guaranteed nothing at all about
 * what is on the library's disk.
 *
 * So: when the declared type has an unambiguous signature, the first bytes have
 * to agree with it.
 *
 * Two things were considered and deliberately NOT done:
 *
 *   - Sniff the bytes and store whatever they turn out to be. That accepts
 *     every upload and quietly relabels it, which is a worse allowlist than no
 *     allowlist: a librarian would never learn that the file now attached to a
 *     book is not the file they picked.
 *   - Check every declared type, including `text/*` and the legacy
 *     `application/vnd.ms-excel`. Plain text, CSV and MARC have no signature to
 *     check, and a Greek library migrating off an older ILS routinely hands us
 *     a CSV whose export screen named it `.xls`. Refusing those would break
 *     imports that work today in order to prevent nothing — the import parsers
 *     read the bytes and never the header (parsers/index.ts `detectFormat`).
 */

type Signature = {
  /** What a librarian calls this format — it goes into the rejection message. */
  label: string;
  matches: (data: Buffer) => boolean;
};

function startsWith(data: Buffer, bytes: readonly number[]): boolean {
  return data.length >= bytes.length && bytes.every((b, i) => data[i] === b);
}

function ascii(data: Buffer, start: number, end: number): string {
  return data.subarray(start, end).toString('latin1');
}

/**
 * Declared type -> what its first bytes must look like. Only formats whose
 * header is unambiguous appear here; anything absent is accepted unchecked.
 */
const SIGNATURES: Readonly<Record<string, Signature>> = {
  'image/jpeg': {
    label: 'JPEG image',
    matches: (d) => startsWith(d, [0xff, 0xd8, 0xff]),
  },
  'image/png': {
    label: 'PNG image',
    matches: (d) => startsWith(d, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  'image/gif': {
    label: 'GIF image',
    matches: (d) => ascii(d, 0, 6) === 'GIF87a' || ascii(d, 0, 6) === 'GIF89a',
  },
  'image/webp': {
    // RIFF container: "RIFF" <4-byte length> "WEBP".
    label: 'WebP image',
    matches: (d) => d.length >= 12 && ascii(d, 0, 4) === 'RIFF' && ascii(d, 8, 12) === 'WEBP',
  },
  'application/pdf': {
    // Searched in a prefix rather than anchored at 0: the spec puts %PDF- at
    // the start, but scanners and older exporters do prepend junk, and readers
    // (and file(1)) tolerate it. Rejecting a real scanned PDF a library
    // received from a supplier would be a worse outcome than accepting one
    // with a preamble.
    label: 'PDF document',
    matches: (d) => d.subarray(0, 1024).includes('%PDF-'),
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    // .xlsx is a zip. "PK\x03\x04" is a normal archive, "PK\x05\x06" an empty
    // one — an empty zip is not a workbook, but that is the parser's sentence
    // to pass, not this check's.
    label: 'Excel workbook',
    matches: (d) =>
      startsWith(d, [0x50, 0x4b, 0x03, 0x04]) || startsWith(d, [0x50, 0x4b, 0x05, 0x06]),
  },
};

/**
 * Refuse an upload whose bytes contradict the type it was sent as. A type with
 * no entry in {@link SIGNATURES} is accepted unchecked — see the file docblock
 * for why that is deliberate and not a gap to be filled later.
 */
export function assertBytesMatchContentType(contentType: string, data: Buffer): void {
  // `image/png; charset=utf-8` reaches the storage allowlist as-is and is
  // rejected there, but the import upload has no allowlist in front of it, so
  // normalise here rather than let a parameter smuggle a check past us.
  const declared = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  const signature = SIGNATURES[declared];
  if (!signature || signature.matches(data)) return;
  throw new UnsupportedMediaTypeException(
    `This file is being sent as "${declared}" but its contents are not a ${signature.label}. ` +
      'Re-save it in that format, or upload it as the type it really is.',
  );
}
