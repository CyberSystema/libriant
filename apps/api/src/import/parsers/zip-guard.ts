import { IMPORT_MAX_XLSX_UNCOMPRESSED_BYTES } from '../import.constants.js';
import { ParseError } from './types.js';

/**
 * A8-01: reject an .xlsx decompression bomb BEFORE inflating it.
 *
 * An .xlsx is a ZIP archive. `exceljs`/JSZip inflate every entry fully into
 * memory on `load()`, so a tiny upload that declares (and delivers) gigabytes of
 * uncompressed XML can OOM the worker — and a V8 out-of-memory abort is NOT
 * catchable (it kills the whole process, taking every BullMQ consumer with it).
 * The dimension/row caps run only AFTER `load()`, far too late.
 *
 * We read the ZIP central directory — which records each entry's *declared*
 * uncompressed size in its header, no inflation required — and reject the file
 * if the total declared expansion exceeds {@link IMPORT_MAX_XLSX_UNCOMPRESSED_BYTES}.
 * The declared size is what JSZip allocates toward, so this caps the allocation
 * before it happens. (A liar that under-declares its sizes still can't beat the
 * post-load row/column caps, and JSZip allocates per the declared size anyway.)
 *
 * Implementation reads the End Of Central Directory (EOCD) record, then walks
 * the Central File Header records — all fixed-layout, little-endian. ZIP64 (a
 * size or offset of 0xFFFFFFFF, i.e. a >4 GiB member) is treated as "too big".
 */

// ZIP record signatures (little-endian uint32).
const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CFH_SIG = 0x02014b50; // Central File Header
const U32_MAX = 0xffffffff;
const EOCD_MIN_SIZE = 22; // EOCD without comment
const MAX_COMMENT = 0xffff; // ZIP comment length field is 16-bit

export function assertXlsxNotZipBomb(buf: Buffer): void {
  // Find the EOCD by scanning backward from the end over the max comment window.
  const minStart = Math.max(0, buf.length - (EOCD_MIN_SIZE + MAX_COMMENT));
  let eocd = -1;
  for (let i = buf.length - EOCD_MIN_SIZE; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    // Not a recognizable ZIP/EOCD. Let exceljs produce its own clear error
    // rather than guessing — but a non-zip can't be a zip bomb.
    return;
  }

  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === U32_MAX || cdSize === U32_MAX || totalEntries === 0xffff) {
    throw new ParseError('The Excel file is too large or uses an unsupported ZIP64 layout.');
  }
  if (cdOffset + cdSize > buf.length) return; // malformed; let exceljs report it.

  let totalUncompressed = 0;
  let p = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CFH_SIG) {
      return; // central directory ran short / corrupt — defer to exceljs.
    }
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    if (compressedSize === U32_MAX || uncompressedSize === U32_MAX) {
      throw new ParseError('The Excel file declares a ZIP64 member that is too large to import.');
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > IMPORT_MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw new ParseError(
        'The Excel file expands to far more data than its size suggests ' +
          '(possible corruption or a decompression bomb) and was rejected. ' +
          'Re-export it as CSV or split it into smaller files.',
      );
    }
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    p += 46 + nameLen + extraLen + commentLen;
  }
}
