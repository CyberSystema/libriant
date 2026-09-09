import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { Client as PgClient } from 'pg';
import {
  MarcError,
  writeIso2709,
  writeMarcXmlRecord,
  MARCXML_NAMESPACE,
  type MarcRecord,
} from '@libriant/marc';
import { ByteWriter } from '../bib/bib-serialize.js';
import { CATALOG_EXPORT_MAX_LISTED_REFUSALS, CATALOG_EXPORT_PAGE } from '../bib/bib.constants.js';

/**
 * The catalogue, as MARC, for a library that wants to leave — or to load its own
 * records into a union catalogue, a discovery layer or a backup.
 *
 * This is the half of §6 phase 11 that makes "MARC comes back out" true at
 * catalogue scale, and it is the answer to the sentence the marketing site
 * currently carries: "MARC goes into Libriant, it does not come out."
 *
 * ## It is not a database dump
 *
 * The other four export formats walk `pg_tables` and emit every row of every
 * table. This one walks `lbr2.marc_records` and emits one ISO 2709 record per
 * bibliographic record — because a `.mrc` file is the thing another system can
 * read, and a CSV of `marc_record_contents` is not.
 *
 * That also means it cannot reuse `withTableReader` / `createRowStreamer`: both
 * enumerate `schemaname = 'public'`, quote a single unqualified identifier, and
 * redact by 1.0 table name. It uses the keyset walk that
 * `bib-projection-verify.ts` established for the 2.0 world instead — one
 * statement per page, so record and document share a snapshot.
 *
 * ## Every refusal is accounted for, in the artifact
 *
 * `writeIso2709` refuses rather than corrupts: a field over 9,999 bytes (a real
 * multi-volume 505 contents note reaches that), a record over 99,999, a
 * separator byte inside a value. Each message names MARCXML as the answer, and
 * that is true — so a refused record is written to `oversize.xml` rather than
 * dropped, and `manifest.json` counts every record the export saw.
 *
 * A catalogue export that silently contained fewer records than the catalogue
 * is the worst thing this file could do: the library would discover it years
 * later, in another system, with no way to tell which records were lost. Hence
 * the zip, and hence the manifest.
 */
/**
 * The narrow slice of a pg client the walk needs.
 *
 * Injected rather than constructed so a unit test can answer the keyset query
 * from memory — see `catalog-marc.spec.ts`, which drives the real refusal
 * handling against records no real catalogue would hand you on demand.
 */
export type CatalogSource = {
  query<T>(text: string, params: unknown[]): Promise<{ rows: T[] }>;
};

export type CatalogExportResult = {
  /** Bibliographic records the walk saw. */
  readonly total: number;
  /** Records written to `catalogue.mrc`. */
  readonly written: number;
  /** Records ISO 2709 could not carry, written to `oversize.xml` instead. */
  readonly refused: number;
  readonly bytes: number;
  readonly refusals: readonly CatalogRefusal[];
};

export type CatalogRefusal = {
  readonly recordId: string;
  readonly controlNumber: string | null;
  /** The codec's own code: `field-too-long`, `record-too-long`, … */
  readonly code: string;
  readonly message: string;
};

type Row = {
  id: string;
  leader: string;
  control_number: string | null;
  content: unknown;
};

/**
 * Write one library's catalogue.
 *
 * `guard` is the export subsystem's own `ExportRunGuard`, passed in rather than
 * constructed here so the four-hour deadline and the 2 GiB disk reserve are the
 * same ones every other format runs under — a catalogue export that invented its
 * own limits would be the one export that can fill the volume.
 */
export async function writeCatalogMarc(opts: {
  /** An open reader, already inside its read-only transaction. */
  source: CatalogSource;
  mrcPath: string;
  xmlPath: string;
  /** Called between pages, so a stalled export is stopped by the shared guard. */
  assertHealthy: () => Promise<void> | void;
  onProgress?: (seen: number) => void;
}): Promise<CatalogExportResult> {
  const client = opts.source;

  const mrcStream = createWriteStream(opts.mrcPath);
  await once(mrcStream, 'open');
  const mrc = new ByteWriter(mrcStream);

  // The XML file is opened lazily: most catalogues refuse nothing, and an empty
  // `oversize.xml` in the archive would invite the reading that some records
  // were lost.
  let xmlStream: ReturnType<typeof createWriteStream> | null = null;
  let xml: ByteWriter | null = null;

  const refusals: CatalogRefusal[] = [];
  let total = 0;
  let written = 0;
  let refused = 0;
  let after = '';

  try {
    for (;;) {
      await opts.assertHealthy();
      const page = await client.query<Row>(
        `SELECT r.id, r.leader, r.control_number, c.content
           FROM lbr2.marc_records r
           JOIN lbr2.marc_record_contents c ON c.record_id = r.id
          WHERE r.kind = 'bibliographic'
            AND r.deleted_at IS NULL
            AND r.merged_into_id IS NULL
            AND r.id > $1
          ORDER BY r.id
          LIMIT $2`,
        [after, CATALOG_EXPORT_PAGE],
      );
      if (page.rows.length === 0) break;
      after = page.rows[page.rows.length - 1]!.id;

      for (const row of page.rows) {
        total += 1;
        const record: MarcRecord = {
          leader: row.leader,
          fields: row.content as MarcRecord['fields'],
        };
        try {
          // UTF-8. `writeLeader` stamps Leader/09 = 'a' to say so, which is what
          // makes the file loadable rather than mojibake at the far end. MARC-8
          // is not offered: this build encodes Basic Latin and ANSEL only, so a
          // Greek catalogue could not be honestly written in it.
          await mrc.write(writeIso2709(record));
          written += 1;
        } catch (err) {
          if (!(err instanceof MarcError)) throw err;
          refused += 1;
          if (!xml) {
            xmlStream = createWriteStream(opts.xmlPath);
            await once(xmlStream, 'open');
            xml = new ByteWriter(xmlStream);
            await xml.write(
              encode(
                `<?xml version="1.0" encoding="UTF-8"?>\n<collection xmlns="${MARCXML_NAMESPACE}">\n`,
              ),
            );
          }
          await xml.write(
            encode(`  <record>\n${writeMarcXmlRecord(record, '    ', 2)}\n  </record>\n`),
          );
          if (refusals.length < CATALOG_EXPORT_MAX_LISTED_REFUSALS) {
            refusals.push({
              recordId: row.id,
              controlNumber: row.control_number,
              code: err.code,
              message: err.message,
            });
          }
        }
      }
      opts.onProgress?.(total);
    }

    const mrcBytes = await mrc.close();
    let xmlBytes = 0;
    if (xml) {
      await xml.write(encode('</collection>\n'));
      xmlBytes = await xml.close();
    }
    await closeStream(mrcStream);
    if (xmlStream) await closeStream(xmlStream);

    return { total, written, refused, bytes: mrcBytes + xmlBytes, refusals };
  } finally {
    mrcStream.destroy();
    xmlStream?.destroy();
  }
}

/**
 * Open a read-only snapshot of one library and hand it to `body`.
 *
 * REPEATABLE READ and READ ONLY, the same envelope every other export reads
 * under: a catalogue that changed halfway through the walk would produce a file
 * that never existed. Separated from {@link writeCatalogMarc} so the walk itself
 * can be driven by a fake client in a unit test — the refusal classes are
 * exactly the behaviour worth testing without a database, and they are the ones
 * a real catalogue only exhibits once in ten thousand records.
 */
export async function withCatalogSource<T>(
  dbUrl: string,
  body: (source: CatalogSource) => Promise<T>,
): Promise<T> {
  const client = new PgClient({ connectionString: dbUrl, connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    // A library that has not been migrated to 2.0 has no catalogue to export,
    // and the walk would fail on `relation "lbr2.marc_records" does not exist` —
    // a message that reads like a bug in the exporter. Every tenant this product
    // provisions gets the schema, so this is a guard against the case that has
    // no other way to be reported.
    const present = await client.query<{ ok: boolean }>(
      `SELECT pg_catalog.to_regclass('lbr2.marc_records') IS NOT NULL AS ok`,
      [],
    );
    if (!present.rows[0]?.ok) {
      throw new Error(
        'This library has no 2.0 catalogue schema, so there is nothing to export as MARC. ' +
          'Run the tenant migration first.',
      );
    }
    await client.query('SET idle_in_transaction_session_timeout = 60000');
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    try {
      return await body(client as unknown as CatalogSource);
    } finally {
      // ROLLBACK, not COMMIT: nothing was written and a read-only transaction
      // has nothing to commit. Swallowed because the connection is closing
      // anyway and a failure here must not mask the real error.
      await client.query('ROLLBACK').catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * The account of what the export contains, as a file inside it.
 *
 * Written even when nothing was refused, because "0 refusals" is the assurance a
 * librarian is looking for and its absence is not the same statement.
 */
export function catalogManifest(result: CatalogExportResult, generatedAt: string): string {
  return `${JSON.stringify(
    {
      format: 'catalog_marc',
      version: 1,
      generatedAt,
      records: {
        total: result.total,
        inCatalogueMrc: result.written,
        inOversizeXml: result.refused,
      },
      encoding: 'utf-8',
      note:
        'catalogue.mrc holds one ISO 2709 record per bibliographic record, UTF-8, Leader/09 = a. ' +
        'Records ISO 2709 cannot carry — a field over 9,999 bytes, a record over 99,999, a ' +
        'separator byte inside a value — are in oversize.xml as MARCXML, which has no such ' +
        'limits. total = inCatalogueMrc + inOversizeXml, always.',
      refusalsListed: result.refusals.length,
      refusalsTruncated: result.refused > result.refusals.length,
      refusals: result.refusals,
    },
    null,
    2,
  )}\n`;
}

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

async function closeStream(s: ReturnType<typeof createWriteStream>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.end(() => resolve());
  });
}
