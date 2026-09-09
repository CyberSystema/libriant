import { Injectable } from '@nestjs/common';
import { projectBib, type BibProjection, type MarcRecord } from '@libriant/marc';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';

/**
 * Writes the relational projection, inside the caller's transaction.
 *
 * §2 requires the projection to be "recomputed by a pure function inside the
 * same transaction as every write", so that a record and its projection can
 * never be observed disagreeing. `projectBib` is that pure function and lives in
 * `packages/marc`; everything here is the persistence of its output and nothing
 * else. No decision about what a MARC field MEANS is taken in this file — if one
 * ever is, it is a second answer to a question `packages/marc` already answers,
 * and the OPAC and the export endpoint will disagree about the same record.
 *
 * ## The six columns this service must never write
 *
 * `bib_records` holds thirty-four columns and SIX OF THEM ARE NOT THE
 * PROJECTOR'S: `item_count` and `available_count` are counts over `items`,
 * `suppressed_from_opac` is staff state, `custom_fields` is tenant-defined,
 * `cover_asset_ref` comes from an upload, and `legacy_json` is phase 19's
 * copy-forward provenance — written once and unreconstructible after
 * `v1_archive` is dropped. A `INSERT … ON CONFLICT DO UPDATE` that assigned the
 * excluded row wholesale would destroy all six on every single-subfield edit:
 * it would zero the OPAC availability of every record a cataloguer touched,
 * un-suppress records staff had hidden, and throw away the only copy of the 1.0
 * row — and it would fail no test unless one was written for it.
 *
 * The defence is structural rather than remembered. {@link ownedColumns} builds
 * ONE object holding exactly the projector-owned columns, and that same object
 * is spread into the create and passed as the whole of the update. The six are
 * not in it, and there is no second object an update could accidentally use, so
 * "write them by accident" is not a thing this code can express. Prisma's typed
 * `update` then refuses a column name that does not exist, which a raw
 * `ON CONFLICT` column list would not.
 *
 * `material_type_id` and `work_cluster_id` are in the same protected set for a
 * different reason: nothing computes them yet (see the model docblocks), and
 * leaving a column out of the update is how a projector says "not mine".
 *
 * ## Why the satellites are deleted and re-inserted
 *
 * `bib_identifiers` and `bib_classifications` have no natural key — deliberately
 * so, since §5 says of the identifiers "none is a uniqueness constraint" and §3
 * explains that a set and its volumes, a reprint, and endemic publisher ISBN
 * reuse in small Greek presses all legitimately share one. With no key there is
 * nothing to match rows on, so a diff-and-patch would have to invent one. Both
 * tables hold a handful of rows per record and the projector owns every row in
 * them, so replacing the set is both the correct and the cheap answer.
 */
@Injectable()
export class BibProjectionService {
  /**
   * Recompute and store the projection of one record.
   *
   * Takes the record the caller already holds rather than re-reading
   * `marc_record_contents`. That is not only a saved round trip: re-reading
   * would fetch the document from TOAST on every write, and would read the
   * PREVIOUS state on the create path, where the row does not exist yet.
   *
   * Non-bibliographic kinds return without touching anything. An authority,
   * holdings or classification record has no bibliographic projection, and a
   * `bib_records` row for one would appear in the OPAC.
   */
  async project(
    tx: TxV2,
    input: {
      recordId: string;
      kind: string;
      record: MarcRecord;
      now: Date;
    },
  ): Promise<{ anomalyCount: number }> {
    if (input.kind !== 'bibliographic') return { anomalyCount: 0 };

    const { projection, anomalies } = projectBib(input.record);
    const owned = {
      ...ownedColumns(projection),
      projectionAnomalies: anomalies as unknown as object[],
      updatedAt: input.now,
    };

    await tx.bibRecord.upsert({
      where: { bibId: input.recordId },
      // `createdAt` only here. On an update the projection keeps the moment it
      // first existed, which is what a "records added this month" count reads —
      // and what an edit would otherwise reset for the whole back catalogue the
      // first time a batch job touched it.
      create: { bibId: input.recordId, createdAt: input.now, ...owned },
      update: owned,
    });

    // Order matters only in that both must happen inside this transaction. The
    // delete cannot orphan anything: both tables cascade from `bib_records`,
    // which exists by the line above.
    await tx.bibIdentifier.deleteMany({ where: { bibId: input.recordId } });
    if (projection.identifiers.length > 0) {
      await tx.bibIdentifier.createMany({
        data: projection.identifiers.map((i) => ({
          bibId: input.recordId,
          scheme: i.scheme,
          value: i.value,
          valueNorm: i.valueNorm,
          valid: i.valid,
          cancelled: i.cancelled,
          sourceTag: i.sourceTag,
        })),
      });
    }

    await tx.bibClassification.deleteMany({ where: { bibId: input.recordId } });
    if (projection.classifications.length > 0) {
      await tx.bibClassification.createMany({
        data: projection.classifications.map((c) => ({
          bibId: input.recordId,
          scheme: c.scheme,
          value: c.value,
          sortKey: c.sortKey,
          sourceTag: c.sourceTag,
        })),
      });
    }

    return { anomalyCount: anomalies.length };
  }
}

/**
 * The projector-owned columns of `bib_records`, and NOTHING else.
 *
 * Written out field by field rather than spread from the projection, so that
 * adding a field to `BibProjection` does not silently start writing a column,
 * and so that the six columns named in the class docblock cannot appear here by
 * accident: there is nowhere to put them. The return type is the object literal
 * itself, which is what makes Prisma reject a renamed column at compile time.
 *
 * `languageCodes` is copied into a mutable array because Prisma's generated
 * input types do not accept `readonly string[]`, and the projection is readonly
 * all the way down on purpose.
 */
function ownedColumns(p: BibProjection) {
  return {
    title: p.title,
    titleNonfilingSkip: p.titleNonfilingSkip,
    sortTitle: p.sortTitle,
    statementOfResp: p.statementOfResp,
    mainEntryDisplay: p.mainEntryDisplay,
    mainEntryNorm: p.mainEntryNorm,
    edition: p.edition,
    publisher: p.publisher,
    publicationPlace: p.publicationPlace,
    publicationYear: p.publicationYear,
    publicationYearEnd: p.publicationYearEnd,
    languageCode: p.languageCode,
    languageCodes: [...p.languageCodes],
    countryCode: p.countryCode,
    contentTypeCode: p.contentTypeCode,
    mediaTypeCode: p.mediaTypeCode,
    carrierTypeCode: p.carrierTypeCode,
    extent: p.extent,
    physicalDescription: p.physicalDescription,
    seriesStatement: p.seriesStatement,
    summary: p.summary,
    matchKey: p.matchKey,
    searchText: p.searchText,
    browseAuthor: p.browseAuthor,
  };
}

/**
 * The columns `ownedColumns` is forbidden to produce.
 *
 * Exported so the integration test can assert the list rather than restate it,
 * and so that a future column added to `bib_records` has one obvious place to be
 * classified. A name in both this array and `ownedColumns` is a bug the test
 * catches; a name in neither is a column nobody has decided about.
 */
export const NOT_THE_PROJECTORS = [
  'coverAssetRef',
  'customFields',
  'suppressedFromOpac',
  'itemCount',
  'availableCount',
  'legacyJson',
  'materialTypeId',
  'workClusterId',
] as const;

/** For the test above: the names `ownedColumns` actually writes. */
export function projectorOwnedColumnNames(): readonly string[] {
  return Object.keys(
    ownedColumns({
      title: '',
      titleNonfilingSkip: 0,
      sortTitle: '',
      statementOfResp: null,
      mainEntryDisplay: null,
      mainEntryNorm: null,
      edition: null,
      publisher: null,
      publicationPlace: null,
      publicationYear: null,
      publicationYearEnd: null,
      languageCode: null,
      languageCodes: [],
      countryCode: null,
      contentTypeCode: null,
      mediaTypeCode: null,
      carrierTypeCode: null,
      extent: null,
      physicalDescription: null,
      seriesStatement: null,
      summary: null,
      matchKey: '',
      searchText: '',
      browseAuthor: null,
      identifiers: [],
      classifications: [],
    }),
  );
}
