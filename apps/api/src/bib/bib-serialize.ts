import { ConflictException } from '@nestjs/common';
import {
  MarcError,
  toMarcJson,
  writeIso2709,
  writeMarcXmlRecord,
  MARCXML_NAMESPACE,
  type MarcRecord,
} from '@libriant/marc';

/**
 * The three serializations a record can be asked for, and what they cost.
 *
 * This is the whole of phase 11b's "MARC comes back out" promise expressed as a
 * function, and it is deliberately dumb: it takes a record and returns bytes.
 * Every decision that is not a serialization — which record, whether the caller
 * may read it, whether the original bytes exist — lives in the service above it.
 */
export type SerializationFormat = 'mrc' | 'xml' | 'json';

export type Serialized = {
  readonly bytes: Uint8Array;
  /** Exactly what goes in the `Content-Type` header. */
  readonly contentType: string;
  /** The extension a browser should save it under. */
  readonly extension: string;
};

/**
 * `application/marc` is the IANA registration for ISO 2709 and is what the
 * repo's own storage layer already declares (`allowed-types.ts`).
 * `application/marcxml+xml` is LC's registration for the slim schema.
 * MARC-in-JSON has no registration at all, so `application/json` it is —
 * inventing `application/marc+json` would be a name nothing else speaks.
 */
const CONTENT_TYPE: Record<SerializationFormat, string> = {
  mrc: 'application/marc',
  xml: 'application/marcxml+xml; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

/**
 * Serialize one record.
 *
 * ## UTF-8, always, and it is not a shortcut
 *
 * `writeIso2709` takes an encoding and this passes none, so it defaults to
 * UTF-8 and `writeLeader` stamps Leader/09 = 'a' to say so. MARC-8 is NOT
 * offered, and that is a fact about this build rather than a preference: the
 * MARC-8 encoder ships two graphic sets, Basic Latin and Extended Latin/ANSEL,
 * so a Greek record — the ordinary case for this product — raises
 * `marc8-unencodable` and cannot be honestly emitted. Offering an encoding that
 * silently fails on the majority of a Greek catalogue would be worse than not
 * offering it. The original MARC-8 bytes of an imported record are still
 * recoverable, exactly once and exactly as they arrived, through
 * `?fidelity=source`.
 *
 * ## The JSON form is Ross Singer's, not ours
 *
 * The stored `{t, i, s}` shape is a storage detail chosen because at 5M records
 * the key names are ~15 % of the JSONB. Every MARC tool that speaks JSON speaks
 * MARC-in-JSON, so that is what leaves the building — `toMarcJson` is the
 * translation, and it is the same one the codec's own cross-format identity test
 * proves equivalent to the XML and the binary.
 *
 * ## THROWS, and the caller must decide
 *
 * `writeIso2709` refuses rather than corrupts: a field over 9,999 bytes, a
 * record over 99,999, a separator byte inside a value, a tag that is not three
 * characters. Each message names MARCXML as the answer, which is true — the XML
 * writer has none of those ceilings. A single-record route turns that into a
 * 409; the whole-catalogue export counts it and keeps going.
 */
export function serializeRecord(record: MarcRecord, format: SerializationFormat): Serialized {
  if (format === 'mrc') {
    return { bytes: writeIso2709(record), contentType: CONTENT_TYPE.mrc, extension: 'mrc' };
  }
  if (format === 'xml') {
    const doc =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<record xmlns="${MARCXML_NAMESPACE}">\n${writeMarcXmlRecord(record, '  ', 1)}\n</record>\n`;
    return { bytes: encode(doc), contentType: CONTENT_TYPE.xml, extension: 'xml' };
  }
  return {
    bytes: encode(`${JSON.stringify(toMarcJson(record), null, 2)}\n`),
    contentType: CONTENT_TYPE.json,
    extension: 'json',
  };
}

/** The Content-Type a stored `source_format` should be served as. */
export function contentTypeForSourceFormat(sourceFormat: string): string {
  if (sourceFormat === 'marcxml') return CONTENT_TYPE.xml;
  if (sourceFormat === 'marc_json') return CONTENT_TYPE.json;
  return CONTENT_TYPE.mrc;
}

/** Which `?fidelity=source` extension a stored `source_format` can answer. */
export function extensionForSourceFormat(sourceFormat: string): SerializationFormat | null {
  if (sourceFormat === 'iso2709') return 'mrc';
  if (sourceFormat === 'marcxml') return 'xml';
  if (sourceFormat === 'marc_json') return 'json';
  return null;
}

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * A write-behind for BINARY output, deliberately not `export-processors.ts`'s
 * `BufferedWriter`.
 *
 * That one is a STRING buffer — `private buf = ''` and `this.buf += s` — which
 * is exactly right for CSV and JSON and destroys ISO 2709. Appending bytes to a
 * JS string decodes them as UTF-8 with replacement characters and re-encodes on
 * write, so a MARC-8-derived byte becomes U+FFFD (3 bytes where there was 1) and
 * the leader's own `00-04` byte count — which the reader uses to find the next
 * record — stops matching the bytes that follow it. The file would parse as one
 * corrupt record, silently.
 *
 * So: `Buffer` chunks, concatenated at the same 64 KiB threshold, awaiting
 * `drain` the same way, and capturing the stream's `error` so a full disk fails
 * one export instead of killing the worker.
 */
export class ByteWriter {
  private chunks: Uint8Array[] = [];
  private queued = 0;
  private failure: Error | null = null;
  private written = 0;

  constructor(
    private readonly out: NodeJS.WritableStream,
    private readonly threshold = 64 * 1024,
  ) {
    this.out.on('error', (err: Error) => {
      this.failure = err;
    });
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.throwIfFailed();
    this.chunks.push(bytes);
    this.queued += bytes.length;
    if (this.queued >= this.threshold) await this.flush();
  }

  async close(): Promise<number> {
    await this.flush();
    this.throwIfFailed();
    return this.written;
  }

  private async flush(): Promise<void> {
    if (this.queued === 0) return;
    const buf = Buffer.concat(this.chunks, this.queued);
    this.chunks = [];
    this.queued = 0;
    this.written += buf.length;
    if (!this.out.write(buf)) {
      await new Promise<void>((resolve, reject) => {
        const ok = () => {
          this.out.off('error', bad);
          resolve();
        };
        const bad = (err: Error) => {
          this.out.off('drain', ok);
          reject(err);
        };
        this.out.once('drain', ok);
        this.out.once('error', bad);
      });
    }
    this.throwIfFailed();
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }
}

/**
 * The writer's refusals, as an answer a cataloguer can act on.
 *
 * `writeIso2709` refuses rather than corrupts, and every one of its messages
 * already names MARCXML as the way out — which is TRUE and is the only useful
 * thing to say. A 500 here would be wrong twice over: the record is fine, and
 * the caller has a working alternative one character away.
 *
 * 409 rather than 400: the request is well formed and the record is stored. What
 * cannot happen is this particular representation of it.
 */
export function marcWriteToHttp(err: unknown, format: SerializationFormat): unknown {
  if (!(err instanceof MarcError)) return err;
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: `catalog.${err.code}`,
    marcCode: err.code,
    format,
    message: `${err.message} The record itself is unaffected and .xml can carry it.`,
  });
}
