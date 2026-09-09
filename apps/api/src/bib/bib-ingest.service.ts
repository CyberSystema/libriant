import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  ANOMALY,
  readIso2709Record,
  splitIso2709,
  writeIso2709,
  type MarcAnomaly,
  type MarcRecord,
} from '@libriant/marc';
import { BibWriteService } from './bib-write.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import { CATALOG_INGEST_DEADLINE_MS, CATALOG_INGEST_MAX_RECORDS } from './bib.constants.js';

/**
 * MARC in. The first thing in this product that ever wrote a source byte.
 *
 * ## It goes through `create()`, one record at a time, on purpose
 *
 * A bulk writer that INSERTed straight into `lbr2.marc_records` would be several
 * times faster and would silently reproduce the exact defect phase 11a shipped
 * and fixed: a record with no projection, invisible to the OPAC, to facets, to
 * browse and to every report, with every test still green. `create()` is the one
 * method that knows to write the projection, the version row, the two satellites,
 * the change event and the audit row, and it is called here unchanged.
 *
 * The cost of that discipline is measured rather than assumed: 2.54 ms per
 * record with each record in its own transaction, against 1.17 ms batched ten to
 * a transaction. A 2.2x speedup is real, and it is not worth a second
 * construction site for the projection tuple — which is what the batched shape
 * would be until phase 37 needs one for its own reasons.
 *
 * One transaction per record also buys the failure model this route needs: a
 * file with one unparseable record loads the other 999, and the response says
 * which one failed and why. A single transaction would lose the file.
 *
 * ## Synchronous, bounded, and not a queue
 *
 * See `bib.constants.ts` for the numbers and what each was measured against.
 * The short version: this is the PRIMITIVE. Phase 30 (copy cataloguing), 35
 * (migration adapters) and 37 (batch edit) each need bulk MARC and each brings
 * its own queue, progress model and resume semantics; building one of them here
 * means building it twice and deleting most of it at 35.
 */
const logger = new Logger('BibIngest');

export type IngestRecordResult = {
  /** Position in the submitted chunk, so a client can resume or retry precisely. */
  readonly index: number;
  readonly ok: boolean;
  readonly recordId?: string;
  readonly publicNo?: string;
  readonly contentHash?: string;
  readonly controlNumber?: string | null;
  /** Whether the codec can reproduce the submitted bytes exactly. */
  readonly roundtrips?: boolean;
  readonly anomalies?: readonly MarcAnomaly[];
  readonly needsReview?: boolean;
  /** Present only when `ok` is false. */
  readonly code?: string;
  readonly message?: string;
};

export type IngestResult = {
  /** Records found in the submitted bytes. */
  readonly total: number;
  /** Records this request actually attempted. */
  readonly processed: number;
  /** True when a cap or the deadline stopped it early. */
  readonly truncated: boolean;
  readonly created: number;
  readonly failed: number;
  readonly results: readonly IngestRecordResult[];
};

@Injectable()
export class BibIngestService {
  constructor(@Inject(BibWriteService) private readonly writes: BibWriteService) {}

  async ingestIso2709(
    tenant: TenantContext,
    actor: TenantActor,
    bytes: Uint8Array,
  ): Promise<IngestResult> {
    if (bytes.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'catalog.ingestEmpty',
        message: 'The request body is empty. Send raw ISO 2709 bytes as application/marc.',
      });
    }

    // Subarray VIEWS into the caller's buffer, not copies — which is what makes
    // keeping every record's original bytes for `source_blob` free.
    const slices = splitIso2709(bytes);
    if (slices.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'catalog.ingestUnreadable',
        message:
          'No ISO 2709 record was found in the body. A MARC file begins with a 24-byte leader ' +
          'whose first five characters are the record length.',
      });
    }

    const parsed = slices.map((slice) => readIso2709Record(slice));

    // A CHUNK CUT IN THE WRONG PLACE IS REFUSED, WHOLE.
    //
    // `splitIso2709` deliberately tolerates an exporter that omits the final
    // record terminator — real ones do, and refusing would make their files
    // unreadable. That tolerance has a sharp edge for a chunked upload: a client
    // that split its file at an arbitrary byte offset hands us a truncated last
    // record, which parses into something plausible and stores silently. The
    // library would then hold a record that is half of one book.
    //
    // A missing terminator on the LAST slice is exactly that signal, and it is
    // cheap to act on: `pnpm catalog:import` splits with this same function, so
    // a correctly chunked upload never trips it.
    const last = parsed[parsed.length - 1];
    if (last && last.anomalies.some((a) => a.code === ANOMALY.missingRecordTerminator)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'catalog.ingestTruncated',
        message:
          'The last record in this chunk has no record terminator, which means the file was cut ' +
          'inside a record. Split with splitIso2709 (pnpm catalog:import does) so a boundary ' +
          'always falls between records. Nothing was written.',
        records: slices.length,
      });
    }

    const attempt = Math.min(slices.length, CATALOG_INGEST_MAX_RECORDS);
    const deadline = Date.now() + CATALOG_INGEST_DEADLINE_MS;
    const results: IngestRecordResult[] = [];
    let created = 0;
    let failed = 0;
    let processed = 0;

    for (let i = 0; i < attempt; i += 1) {
      // Checked BETWEEN records, never inside one: a record is written or it is
      // not, and the caller resumes from `processed`.
      if (Date.now() > deadline && i > 0) break;
      const slice = slices[i]!;
      const p = parsed[i]!;
      processed += 1;
      // Computed once. Measured at 28 ms per 1,000 records, which is nothing
      // beside the write — but it is a whole second serialization pass and
      // there is no reason to do it twice.
      const rt = roundtrips(p.record, slice);
      const cn = controlNumber(p.record);
      try {
        const written = await this.writes.create(tenant, actor, {
          record: p.record,
          // DERIVED FROM LEADER/06, not defaulted to bibliographic. A .mrc file
          // routinely carries authority and holdings records beside the bibs,
          // and storing one as bibliographic is worse than refusing it: the
          // projector short-circuits on kind, so a mislabelled authority record
          // gets a BIBLIOGRAPHIC projection and appears in the OPAC as a book
          // called "Καζαντζάκης, Νίκος".
          kind: kindFromLeader(p.record.leader),
          controlNumber: cn,
          source: {
            format: 'iso2709',
            encoding: encodingOf(p.record.leader, p.anomalies),
            normalization: normalizationOf(p.record),
            blob: slice,
            roundtrips: rt,
            anomalies: p.anomalies,
          },
        });
        created += 1;
        results.push({
          index: i,
          ok: true,
          recordId: written.recordId,
          contentHash: written.contentHash,
          controlNumber: cn ?? null,
          roundtrips: rt,
          anomalies: p.anomalies,
          needsReview: written.needsReview,
        });
      } catch (err) {
        failed += 1;
        // `getResponse()` is how a Nest HttpException carries its body; every
        // refusal `create()` raises is one of those, and the body is the thing
        // worth putting in the result array. Anything else — a Prisma error, a
        // bug — falls back to its message, which is why `oneLine` exists.
        const body =
          typeof (err as { getResponse?: unknown }).getResponse === 'function'
            ? ((err as { getResponse: () => unknown }).getResponse() as {
                code?: string;
                message?: string;
              })
            : undefined;
        results.push({
          index: i,
          ok: false,
          code: body?.code ?? 'catalog.ingestFailed',
          message: body?.message ?? oneLine(err),
        });
        // One bad record must not end the file, and it must not be silent
        // either: the response carries it, and so does the log, because a
        // 1,000-record response body is not somewhere an operator looks.
        logger.warn(`tenant=${tenant.slug} record ${i}: ${body?.code ?? oneLine(err)}`);
      }
    }

    return {
      total: slices.length,
      processed,
      truncated: processed < slices.length,
      created,
      failed,
      results,
    };
  }
}

/**
 * MARC 21 Leader/06 says what KIND of record this is.
 *
 * `z` is the authority type. `u`, `v`, `x` and `y` are the holdings types.
 * `w` is classification. Everything else — the language material, the maps, the
 * music, the mixed materials — is bibliographic. This is the whole mapping and
 * it is the one MARC 21 publishes; there is no judgement in it.
 *
 * Note the consequence, which is deliberate: an authority record in a .mrc file
 * is REFUSED by `create()` with `catalog.noDefinition`, because this build ships
 * no authority Avram definition until phase 45. That is the right failure — it
 * is one line in the per-record result array saying so, rather than a wrong
 * record in the catalogue.
 */
function kindFromLeader(
  leader: string,
): 'bibliographic' | 'authority' | 'holdings' | 'classification' {
  const t = leader[6];
  if (t === 'z') return 'authority';
  if (t === 'u' || t === 'v' || t === 'x' || t === 'y') return 'holdings';
  if (t === 'w') return 'classification';
  return 'bibliographic';
}

/** 001, the record's own number in the system that produced it. */
function controlNumber(record: MarcRecord): string | undefined {
  const f = record.fields.find((x) => x.t === '001' && 'v' in x);
  const v = f && 'v' in f ? f.v.trim() : '';
  return v.length > 0 ? v : undefined;
}

/**
 * What the SOURCE said it was encoded in, not what we stored it as.
 *
 * Leader/09 `'a'` is Unicode; anything else is MARC-8, which is how the format
 * spells it. Recorded because it is the only durable answer to "why does this
 * record have replacement characters in it": this build's MARC-8 decoder ships
 * Basic Latin and ANSEL only, so a Greek or Cyrillic MARC-8 record decodes to
 * U+FFFD with an anomaly, and `source_blob` is then the only surviving truth.
 */
function encodingOf(leader: string, anomalies: readonly MarcAnomaly[]): string {
  const declared = leader[9] === 'a' ? 'utf-8' : 'marc-8';
  const lossy = anomalies.some(
    (a) =>
      a.code === ANOMALY.marc8UnsupportedCharset ||
      a.code === ANOMALY.marc8UnmappedByte ||
      a.code === ANOMALY.invalidUtf8,
  );
  return lossy ? `${declared}+lossy` : declared;
}

/**
 * Which Unicode normal form the record ARRIVED in.
 *
 * §5's UAX #15 row says content is stored NFC and the original bytes verbatim,
 * and phase 11b is where "the original" acquires a meaning. NACO and MARC-8
 * conversion both produce NFD, so a record that arrived decomposed and is stored
 * composed is not corrupt — but it is not byte-identical either, and this is the
 * column that says so without anyone having to re-derive it from the blob.
 *
 * `mixed` is a real answer, not a hedge: a record with an NFC title and an NFD
 * subject heading exists, and calling it either one would be a guess.
 */
function normalizationOf(record: MarcRecord): string {
  const text = record.fields
    .map((f) => ('v' in f ? f.v : f.s.map((sf) => Object.values(sf)[0] ?? '').join('')))
    .join('');
  // `String.prototype.normalize` rather than the codec's `toNfc`: this
  // CLASSIFIES the text it is given, it does not transform a record. The codec's
  // helpers rebuild a whole MarcRecord, which is the wrong tool for a question
  // about what arrived.
  const isNfc = text.normalize('NFC') === text;
  const isNfd = text.normalize('NFD') === text;
  // A record of pure ASCII is both, and 'nfc' is the honest label: it is what
  // the store holds and what an export emits.
  if (isNfc) return 'nfc';
  if (isNfd) return 'nfd';
  return 'mixed';
}

/**
 * Whether `serialize(parse(bytes)) === bytes`, MEASURED.
 *
 * §2: "`source_roundtrips` records at import whether `serialize(parse(blob)) ===
 * blob`" — and it is recorded rather than assumed because it is false for a real
 * fraction of real exporters. Measured on the phase-7 corpus: 86 % of records
 * round-trip byte-for-byte, 100 % of the conforming ones, and every failure is a
 * declared quirk of the emitting system rather than a codec defect.
 *
 * ON THE RAW PARSE, before NFC and before the 005 stamp. Both of those change
 * bytes by design — the stamp alone guarantees a difference — so computing this
 * after them would record `false` for every record in every file and the column
 * would carry no information at all.
 *
 * A record the writer REFUSES (a field over 9,999 bytes, a separator byte in a
 * value) does not round-trip either, and that is the same fact: these bytes
 * cannot be regenerated, so the blob is the only copy.
 */
function roundtrips(record: MarcRecord, source: Uint8Array): boolean {
  try {
    const out = writeIso2709(record);
    if (out.length !== source.length) return false;
    for (let i = 0; i < out.length; i += 1) if (out[i] !== source[i]) return false;
    return true;
  } catch {
    return false;
  }
}

const oneLine = (err: unknown) => String((err as Error)?.message ?? err).split('\n')[0] ?? 'failed';
