import { createHash } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  applyOps,
  contentHash,
  diff,
  HASH_EXCLUDED_TAGS,
  MarcError,
  schemaForRecord,
  shippedSchema,
  toNfc,
  validateDelta,
  type MarcDiff,
  type MarcOp,
  type MarcRecord,
  type ValidationIssue,
} from '@libriant/marc';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';

import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import { changeActorOf, setChangeActor } from '../tenancy/tenant-actor-guc.js';
import { acquireLocks, lockKey } from '../platform/locks.js';
import { stamp005 } from './marc-005.js';
import { BibProjectionService } from './bib-projection.service.js';

/**
 * The single `write()`.
 *
 * §2 fixes the order and it is not a suggestion:
 *
 *   advisory lock → hash precondition → applyOps → NFC → 005 stamp →
 *   validateDelta → hash → version → audit
 *
 * ## Three concurrency mechanisms, and they are not interchangeable
 *
 * **The advisory lock** gives mutual exclusion for the milliseconds of the save.
 * It must be the FIRST statement of the transaction, before any read. Measured
 * on the real tables: taking it AFTER the read gives 2 winners at two-way and
 * 25 at twenty-five-way — identical to having no lock at all, because both
 * readers complete before either lock is requested. That is also the natural
 * left-to-right reading of the line above, which is why it is written down here
 * and enforced by `acquireLocks` being called first.
 *
 * **The compare-and-swap** — `expectedContentHash` in the UPDATE's WHERE — is
 * what detects staleness and produces the 409. The lock alone does not:
 * measured, lock-first-then-write-with-no-predicate serialises two writers and
 * lets BOTH commit, losing one edit silently.
 *
 * Both, then, and at READ COMMITTED. Not belt-and-braces: the CAS cannot
 * prevent a deadlock (measured, two writers touching `marc_record_contents` and
 * `marc_records` in opposite orders inside one transaction produce `40P01`), and
 * the lock cannot detect staleness. Raising the isolation level instead
 * "works" and is wrong for this criterion — REPEATABLE READ and SERIALIZABLE
 * both yield one winner, but the loser gets `40001`, a retry-shaped error
 * carrying neither the current record nor the diff the acceptance criterion
 * requires.
 *
 * **The record lock** (`marc_record_locks`) is a third thing entirely — a
 * human's intent to hold a record open in an editor for ten minutes — and it is
 * deferred to phase 10b. It must never gate this method: an import, an overlay,
 * a merge and a batch job all have to be able to write a record a cataloguer has
 * open.
 *
 * ## Raw SQL is `lbr2.`-qualified, always
 *
 * The v2 client is built with the adapter's `{ schema: 'lbr2' }` option, which
 * makes the MODEL api schema-aware and does nothing for raw statements —
 * measured: `SELECT … FROM marc_records` through that client throws `relation
 * "marc_records" does not exist`. Every hand-written statement below says
 * `lbr2.`.
 */

/** What a write is: a set of path ops against a known base state. */
export type WriteInput = {
  readonly recordId: string;
  readonly ops: readonly MarcOp[];
  /**
   * The hash the caller believes it is editing, as hex.
   *
   * Optional only for a create. On an edit its absence is a lost-update waiting
   * to happen, so the controller requires it.
   */
  readonly expectedContentHash?: string;
  readonly changeKind?: 'edit' | 'import' | 'overlay' | 'batch' | 'merge' | 'restore';
  readonly changeSummary?: string;
  /** `unchecked` replays a batch whose preconditions were already checked. */
  readonly unchecked?: boolean;
};

/** One row of a record's history, as the API renders it. */
export type VersionSummary = {
  readonly version: number;
  /** Hex. Echoed back as `expectedContentHash` to edit from this state. */
  readonly contentHash: string;
  readonly changeKind: string;
  readonly changeSummary: string | null;
  readonly changedTags: readonly string[];
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly createdAt: Date;
};

export type WriteResult = {
  readonly recordId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly rowVersion: string;
  readonly record: MarcRecord;
  /** Empty when the edit changed nothing that the store records. */
  readonly changedTags: readonly string[];
  readonly verdict: MarcDiff['verdict'];
  readonly issues: readonly ValidationIssue[];
  readonly needsReview: boolean;
};

const HEX = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * A record without its 005, for diffing.
 *
 * `contentHash` already excludes 005 (`HASH_EXCLUDED_TAGS` in
 * `packages/marc/src/canonical.ts`) because it is a transaction timestamp: it
 * changes on EVERY write by definition, so a hash that included it would make
 * every record differ from itself.
 *
 * A diff has the same problem and it is more visible. `diff()` knows nothing
 * about 005 and reports it as an ordinary field change, so without this every
 * version-history row would read "changed 005, 245" and every field-level diff
 * would show a spurious second entry — on every edit, forever. Worse, a save
 * that changed nothing would come back `verdict: 'changed'` and write a version
 * row, which is exactly what §2 says must not happen: "a save that changes
 * nothing writes no version but an export always carries a current transaction
 * timestamp".
 *
 * So the two exclusions are the same decision applied twice, and they must stay
 * in step: if `HASH_EXCLUDED_TAGS` ever grows, this follows it.
 */
const withoutStamp = (r: MarcRecord): MarcRecord => ({
  ...r,
  fields: r.fields.filter((f) => !HASH_EXCLUDED_TAGS.has(f.t)),
});

/** The difference a cataloguer means, ignoring the transaction timestamp. */
const contentDiff = (before: MarcRecord, after: MarcRecord): MarcDiff =>
  diff(withoutStamp(before), withoutStamp(after));

/** Leader/05, derived from status rather than stored twice. */
function recordStatusCode(kind: 'create' | 'edit' | 'delete'): string {
  return kind === 'create' ? 'n' : kind === 'delete' ? 'd' : 'c';
}

/**
 * The leader with /05 set, and the bytes §2 says a writer always emits.
 *
 * ## /09, and why it was a real defect
 *
 * This function used to leave Leader/09 — the character coding scheme — exactly
 * as it arrived, while `writeIso2709` forces it from the EXPORT encoding
 * ("Set from the EXPORT, never copied from the source", iso2709.ts). Nothing
 * noticed while every record was typed into the editor, because a record created
 * here carries `charset_code = 'a'` and a leader whose /09 the caller happened
 * to send as `'a'` too.
 *
 * Phase 11b makes it reachable and measurable. A Greek ABEKT or Aleph export
 * declares MARC-8 with `/09 = ' '`. Stored unchanged, that leader disagrees with
 * `marc_records.charset_code`, which is `'a'`; and `canonicalLeader` keeps
 * positions 5..11, so /09 is INSIDE the hash. Measured on the real codec:
 *
 *     stored          contentHash c28e3d69cc9bc8b0…
 *     export→re-parse contentHash fd682577fc5ef1f2…   NOT EQUAL
 *
 * — for exactly the files this product exists to import. So the stored leader's
 * /09 is set from the charset the record is STORED in, which is UTF-8 for every
 * record this build writes, and the original byte survives where every other
 * original leader byte survives: in `source_blob`.
 */
function leaderForWrite(
  leader: string,
  kind: 'create' | 'edit' | 'delete',
  charsetCode = 'a',
): string {
  const b = leader.padEnd(24, ' ').slice(0, 24).split('');
  b[5] = recordStatusCode(kind);
  // The stored encoding, not the source's. See the docblock.
  b[9] = charsetCode;
  // §2, "on write": always emit /10='2', /11='2', /20-23='4500'. /00-04 and
  // /12-16 are recomputed by the serializer, which is the only place that knows
  // the byte length; storing them is meaningless and they are zeroed in the
  // canonical form the hash is taken over.
  b[10] = '2';
  b[11] = '2';
  b[20] = '4';
  b[21] = '5';
  b[22] = '0';
  b[23] = '0';
  return b.join('');
}

/**
 * SHA-256 of the source bytes, for `marc_record_contents.source_blob_sha256`.
 *
 * `node:crypto` rather than `contentHash` from `@libriant/marc`: that one hashes
 * the CANONICAL JSON of a parsed record excluding 005, which is a different fact
 * about a different object. This is a checksum of the bytes as they arrived, so
 * that a library can prove years later that what it holds is what it was sent.
 * `packages/marc` cannot use `node:crypto` at all (its tsconfig is `types: []`),
 * which is why this lives here.
 */
const sha256 = (bytes: Uint8Array): Uint8Array => createHash('sha256').update(bytes).digest();

/**
 * Turn Prisma's unique-violation into the 409 a caller can act on.
 *
 * Returns `null` when the error is anything else, so the caller rethrows the
 * original rather than swallowing it — a catch that turned every failure into a
 * 409 would hide the next real bug on this path.
 */
function duplicateControlNumber(err: unknown, controlNumber?: string): ConflictException | null {
  const e = err as { code?: string; meta?: unknown; message?: string };
  if (e?.code !== 'P2002') return null;
  // The WHOLE meta, not `meta.target`. Prisma 7 with a driver adapter reports
  // the constraint at `meta.driverAdapterError.cause.constraint.fields` and
  // leaves `target` undefined — measured — so a check against one path is a
  // check that silently stops working on a client upgrade. The message is a
  // second net for the same reason.
  const evidence = `${JSON.stringify(e.meta ?? '')} ${e.message ?? ''}`;
  if (!evidence.includes('control_number')) return null;
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'catalog.duplicateControlNumber',
    message:
      `This library already holds a record with control number ${JSON.stringify(controlNumber ?? '')}. ` +
      'A record number is unique per kind, so the same file cannot be loaded twice without ' +
      'overlay rules — which are phase 30.',
    controlNumber: controlNumber ?? null,
  });
}

/** The value of a control field, or null. */
function controlValueOf(record: MarcRecord, tag: string): string | null {
  const f = record.fields.find((x) => x.t === tag && 'v' in x);
  const v = f && 'v' in f ? f.v.trim() : '';
  return v.length > 0 ? v : null;
}

/** A leader position, or null when it is a space — the MARC "not specified". */
const leaderCode = (leader: string, at: number): string | null => {
  const c = leader[at];
  return c === undefined || c === ' ' ? null : c;
};

/**
 * The three type columns `marc_records` has held open since phase 9.
 *
 * `record_type_code` (Leader/06), `bib_level_code` (Leader/07) and
 * `encoding_level` (Leader/17) had no writer at all — which made
 * `marc_records_type_idx ON (kind, record_type_code, bib_level_code)` an index
 * over two permanently NULL columns. They are pure functions of the leader, so
 * there is no reason for them to be null except that nothing had ever put a real
 * record in. Phase 11b does.
 */
function typeCodesOf(leader: string) {
  return {
    recordTypeCode: leaderCode(leader, 6),
    bibLevelCode: leaderCode(leader, 7),
    encodingLevel: leaderCode(leader, 17),
  };
}

@Injectable()
export class BibWriteService {
  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
    @Inject(BibProjectionService) private readonly projection: BibProjectionService,
  ) {}

  /**
   * The definition a record is measured against.
   *
   * `shippedSchema` throws a plain Error — not a `MarcError` — for every profile
   * except `marc21/bibliographic`, and three of the four `marc_record_kind`
   * labels have no definition in this build. Handled explicitly so an authority
   * record fails with a sentence rather than a stack trace.
   */
  private schemaFor(
    record: MarcRecord,
    kind: string,
    schema: string,
  ): ReturnType<typeof schemaForRecord> {
    const profile = `${schema === 'unimarc' ? 'unimarc' : 'marc21'}/${kind}`;
    try {
      return schemaForRecord(shippedSchema(profile), record);
    } catch {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'catalog.noDefinition',
        message:
          `This build ships no format definition for ${profile}, so a ${kind} record cannot be ` +
          'validated and will not be written. Only MARC 21 bibliographic records are supported ' +
          'until phase 45 vendors the others.',
        profile,
      });
    }
  }

  /**
   * Read a record and its document, or throw.
   *
   * Deliberately two selects rather than an include: `marc_record_contents`
   * carries `source_blob`, and the 1:1 split exists precisely so that nothing
   * drags the document through a query that did not ask for it.
   */
  private async load(
    tx: TxV2,
    recordId: string,
  ): Promise<{
    row: {
      id: string;
      leader: string;
      contentHash: Uint8Array<ArrayBuffer>;
      currentVersion: number;
      kind: string;
      schema: string;
      status: string;
      deletedAt: Date | null;
    };
    record: MarcRecord;
  }> {
    const row = await tx.marcRecord.findUnique({
      where: { id: recordId },
      select: {
        id: true,
        leader: true,
        contentHash: true,
        currentVersion: true,
        kind: true,
        schema: true,
        status: true,
        deletedAt: true,
      },
    });
    if (!row || row.deletedAt) {
      throw new NotFoundException(`No catalogue record ${recordId}.`);
    }
    const contents = await tx.marcRecordContent.findUnique({
      where: { recordId },
      select: { content: true },
    });
    if (!contents) {
      // The 1:1 is enforced by a foreign key, so this is a corrupted record
      // rather than a missing one, and it must not be silently treated as empty.
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'catalog.recordIncomplete',
        message: `Record ${recordId} has no stored document. It cannot be edited.`,
      });
    }
    return {
      row: row as never,
      record: { leader: row.leader, fields: contents.content as unknown as MarcRecord['fields'] },
    };
  }

  /**
   * The 409 body: the current record, and a diff against what the caller held.
   *
   * The caller sends only `expectedContentHash`, never the base document, so the
   * base is recovered from the version row carrying that hash — which is what
   * `marc_record_versions_hash_idx` exists for. When retention has already
   * pruned that snapshot the basis is reported as `unknown` rather than
   * substituting `diff(current, current)`, which would return `verdict:
   * 'identical'` with an empty field list and satisfy a careless reading of
   * "returns a diff" while telling the cataloguer nothing.
   */
  private async staleConflict(tx: TxV2, recordId: string, expectedHex: string): Promise<never> {
    const { row, record } = await this.load(tx, recordId);
    const held = await tx.marcRecordVersion.findFirst({
      where: { recordId, contentHash: new Uint8Array(Buffer.from(expectedHex, 'hex')) },
      orderBy: { version: 'desc' },
      select: { version: true, leader: true, content: true },
    });
    const basis = held ? 'held-version' : 'unknown';
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'catalog.recordChanged',
      message:
        'This record changed while you were editing it. Nothing was saved. Review the ' +
        'differences and try again.',
      currentContentHash: HEX(row.contentHash),
      currentVersion: row.currentVersion,
      record,
      basis,
      diff: held
        ? contentDiff(
            { leader: held.leader, fields: held.content as unknown as MarcRecord['fields'] },
            record,
          )
        : null,
    });
  }

  /**
   * Create a record.
   *
   * Separate from `write()` because there is nothing to lock, nothing to
   * compare against, and `validateDelta(null, after)` treats everything as
   * introduced — which is right: whoever creates a record introduced all of it.
   */
  async create(
    tenant: TenantContext,
    actor: TenantActor,
    input: {
      record: MarcRecord;
      kind?: 'bibliographic' | 'authority' | 'holdings' | 'classification';
      schema?: 'marc21' | 'unimarc';
      controlNumber?: string;
      /**
       * Where this record came from, when it came from bytes.
       *
       * PURELY ADDITIVE, and omitted by the editor — which is why the defaults
       * below still say `manual`. It is the first writer these seven columns
       * have had since phase 9 created them, and it is the whole reason
       * `?fidelity=source` can promise anything: without a blob there are no
       * original bytes to serve, and the promise would be a fallback dressed up
       * as a guarantee.
       *
       * `sourceBlobSha256` is deliberately NOT a parameter. It is computed here
       * from the blob, so the two cannot disagree — a caller that passed a hash
       * of something else would produce a row whose own checksum is a lie, and
       * nothing downstream could tell.
       */
      source?: {
        format: 'iso2709' | 'marcxml' | 'marc_json';
        encoding: string;
        normalization: string;
        blob: Uint8Array;
        roundtrips: boolean;
        anomalies: readonly unknown[];
      };
    },
  ): Promise<WriteResult> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const kind = input.kind ?? 'bibliographic';
    const schema = input.schema ?? 'marc21';
    const now = new Date();

    // NFC first, then the stamp, exactly as on the edit path — and NFC is not
    // optional here even though nothing would notice: `canonicalJson` folds to
    // NFC internally, so an un-normalised record hashes IDENTICALLY to its
    // normalised twin. The only symptom of skipping it is mixed normalisation in
    // the stored JSONB and in every export, which is why the test asserts the
    // stored bytes rather than the hash.
    const normalised = toNfc(input.record);
    // `charsetCode` is 'a' for everything this build stores: the document is
    // JSONB and JSONB is Unicode. It is threaded through rather than hard-coded
    // at both ends so the stored leader and the stored column cannot disagree —
    // which they did until phase 11b, invisibly, for every MARC-8 import.
    const charsetCode = 'a';
    const stamped = stamp005(
      { ...normalised, leader: leaderForWrite(normalised.leader, 'create', charsetCode) },
      now.getTime(),
    );
    const definition = this.schemaFor(stamped, kind, schema);
    const validation = validateDelta(null, stamped, definition);
    const hash = Buffer.from(await contentHash(stamped));
    // Computed HERE, from the blob, rather than accepted from the caller: a
    // checksum a caller supplies is a checksum of whatever the caller hashed,
    // and a row whose own checksum is a lie is undetectable afterwards.
    const sourceHash = input.source ? Buffer.from(sha256(input.source.blob)) : null;

    const created = await client
      .$transaction(
        async (tx) => {
          await setChangeActor(tx, changeActorOf(actor));
          const row = await tx.marcRecord.create({
            data: {
              kind,
              schema,
              status: 'complete',
              leader: stamped.leader,
              contentHash: hash,
              currentVersion: 1,
              recordStatusCode: recordStatusCode('create'),
              charsetCode,
              // Leader/06, /07 and /17. Three columns phase 9 created and nothing
              // has ever written — which left `marc_records_type_idx ON (kind,
              // record_type_code, bib_level_code)` an index over two permanently
              // NULL columns. They are pure functions of the leader; the only
              // reason they were null is that nothing had put a real record in.
              ...typeCodesOf(stamped.leader),
              controlNumber: input.controlNumber ?? null,
              // 003, the agency whose number 001 is. Meaningless without it: an
              // OCLC number and a local accession number are both digits, and
              // phase 44's OCLC normalization cannot tell them apart otherwise.
              controlNumberSource: controlValueOf(stamped, '003'),
              // 008/00-05 is derived from created_at and NEVER rewritten after
              // this moment — every "titles added this year" statistic and the ISO
              // 2789 return depend on it.
              dateEntered: yymmdd(now),
              needsReview: validation.blocking.length > 0,
              createdByUserId: actor.userId,
              updatedByUserId: actor.userId,
              createdAt: now,
              updatedAt: now,
            },
            select: { id: true, publicNo: true, rowVersion: true },
          });
          await tx.marcRecordContent.create({
            data: {
              recordId: row.id,
              content: stamped.fields as never,
              // `manual` when nobody said otherwise, which is the editor. The
              // provenance block is what an ingest passes; see the input type.
              sourceFormat: input.source?.format ?? 'manual',
              sourceEncoding: input.source?.encoding ?? null,
              sourceNormalization: input.source?.normalization ?? null,
              sourceBlob: input.source ? Buffer.from(input.source.blob) : null,
              sourceBlobSha256: sourceHash,
              // TRUE for a typed record, because there are no source bytes to fail
              // to reproduce. False is a fact about an importer, measured at
              // ingest and never recomputed.
              sourceRoundtrips: input.source?.roundtrips ?? true,
              anomalies: (input.source?.anomalies ?? []) as never,
              updatedAt: now,
            },
          });
          await tx.marcRecordVersion.create({
            data: {
              recordId: row.id,
              version: 1,
              leader: stamped.leader,
              content: stamped.fields as never,
              contentHash: hash,
              changeKind: 'create',
              changedTags: stamped.fields.map((f) => f.t),
              actorKind: actor.actorType,
              actorId: actor.actorId,
              createdAt: now,
            },
          });

          // The projection, on the CREATE path too.
          //
          // Worth saying out loud because an earlier draft of this method had the
          // hook only in `writeCore`, and nothing failed: a newly catalogued
          // record simply did not exist for the OPAC, for facets, for browse or
          // for any report until somebody happened to edit it. Every test passed,
          // because every test that looked at a projection created its record and
          // then edited it.
          await this.projection.project(tx, { recordId: row.id, kind, record: stamped, now });

          return row;
        },
        { isolationLevel: 'ReadCommitted' },
      )
      .catch((err: unknown) => {
        // A duplicate 001 is a CONFLICT, not a server error.
        //
        // `marc_records_control_number_unique_active ON (kind, control_number)
        // WHERE control_number IS NOT NULL AND deleted_at IS NULL` is a deliberate
        // constraint, and until phase 11b nothing hit it: the editor mints no 001.
        // An ingest hits it the moment a library loads a file it already loaded,
        // which is the single most common thing that happens to an import — and it
        // escaped as a 500 with a support code, telling the librarian nothing.
        throw duplicateControlNumber(err, input.controlNumber) ?? err;
      });

    await this.audit.record(tenant, actor, {
      action: 'catalog.record.created',
      targetType: 'marc_record',
      targetId: created.id,
      after: { publicNo: String(created.publicNo), version: 1 },
    });

    return {
      recordId: created.id,
      version: 1,
      contentHash: HEX(hash),
      rowVersion: String(created.rowVersion),
      record: stamped,
      changedTags: stamped.fields.map((f) => f.t),
      verdict: 'changed',
      issues: validation.introduced,
      needsReview: validation.blocking.length > 0,
    };
  }

  /**
   * Apply ops to an existing record.
   *
   * Everything between the lock and the commit is one transaction, and the CAS
   * is the only statement that decides whether it happened.
   */
  /**
   * Apply ops to an existing record.
   *
   * A thin wrapper over {@link writeCore}: the ops are one way of producing the
   * next state, and `restore` is another. Everything after "produce the next
   * record" — the lock, the CAS, the stamp, the validation, the version row — is
   * shared, so there is exactly one write path and not two that drift.
   */
  async write(tenant: TenantContext, actor: TenantActor, input: WriteInput): Promise<WriteResult> {
    return this.writeCore(tenant, actor, {
      recordId: input.recordId,
      expectedContentHash: input.expectedContentHash,
      changeKind: input.changeKind ?? 'edit',
      changeSummary: input.changeSummary,
      produce: (base) => applyOps(base, input.ops, { unchecked: input.unchecked }),
    });
  }

  /**
   * THE write. Everything that changes a stored record goes through here.
   *
   * `produce` turns the base state into the intended next state and is the ONLY
   * thing that varies between an edit and a restore. It runs inside the
   * transaction, after the lock and after the precondition, so it always sees
   * the state that is about to be replaced.
   */
  private async writeCore(
    tenant: TenantContext,
    actor: TenantActor,
    opts: {
      recordId: string;
      expectedContentHash?: string;
      changeKind: NonNullable<WriteInput['changeKind']>;
      changeSummary?: string;
      produce: (base: MarcRecord) => MarcRecord;
    },
  ): Promise<WriteResult> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const recordId = opts.recordId;
    const now = new Date();

    const outcome = await client.$transaction(
      async (tx) => {
        // 1. THE LOCK, FIRST. Before any read. See the class docblock.
        await acquireLocks(tx, [lockKey('bib', recordId)]);
        await setChangeActor(tx, changeActorOf(actor));

        // 2. Read the base state, now that nobody else can be mid-write.
        const { row, record } = await this.load(tx, recordId);
        const currentHex = HEX(row.contentHash);
        if (opts.expectedContentHash && opts.expectedContentHash !== currentHex) {
          await this.staleConflict(tx, recordId, opts.expectedContentHash);
        }

        // 3. Produce, normalise, stamp — in that order, per §2.
        let produced: MarcRecord;
        try {
          produced = opts.produce(record);
        } catch (err) {
          throw marcErrorToHttp(err);
        }
        const normalised = toNfc(produced);
        // Stamp first, WITHOUT touching the leader, and ask whether anything
        // actually changed. Only then set Leader/05.
        //
        // Doing it the other way round — the obvious way — makes a save that
        // changed nothing change the leader from 'n' (new) to 'c' (corrected),
        // which IS a change, so the record is no longer identical to itself and
        // a version row is written. §2 is explicit that must not happen: "a save
        // that changes nothing writes no version but an export always carries a
        // current transaction timestamp". Leader/05 describes the record's
        // lifecycle, not whether somebody pressed Save.
        const candidate = stamp005(normalised, now.getTime());
        const provisional = contentDiff(record, candidate);
        const stamped =
          provisional.verdict === 'identical'
            ? candidate
            : { ...candidate, leader: leaderForWrite(candidate.leader, 'edit') };

        // 4. Validate the EDIT, not the record. Only introduced errors block.
        const definition = this.schemaFor(stamped, row.kind, row.schema);
        const validation = validateDelta(record, stamped, definition);
        if (validation.blocking.length > 0) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'catalog.validationFailed',
            message:
              'This edit would introduce errors that were not there before, so nothing was ' +
              'saved. Faults the record already had are not counted.',
            blocking: validation.blocking,
          });
        }

        // 5. The new hash, and whether this is a change the store records.
        const hash = new Uint8Array(await contentHash(stamped));
        // Re-diff against the FINAL record: the leader may have moved since the
        // provisional pass, and the version row records what was actually
        // written.
        const change =
          provisional.verdict === 'identical' ? provisional : contentDiff(record, stamped);
        const nextVersion =
          change.verdict === 'identical' ? row.currentVersion : row.currentVersion + 1;

        // 6. THE CAS. `content_hash` in the WHERE is what makes exactly one of
        //    two concurrent writers win. `updateMany` because Prisma's `update`
        //    throws P2025 on no-match, and a 0-row result is the outcome being
        //    asked about rather than an error.
        //    ONE STATEMENT, and that is not a micro-optimisation. Every UPDATE
        //    on marc_records fires the changelog trigger, so splitting the CAS
        //    and the row_version bump into two statements writes TWO change
        //    events for one edit — and every consumer then processes the record
        //    twice. Measured: the first version of this did exactly that.
        //
        //    Raw SQL because `row_version = nextval(...)` cannot be expressed
        //    through `updateMany`, and the bump is NOT optional: the phase-9
        //    decision to give `marc_record_contents` no changelog trigger rests
        //    on "every content write bumps the parent's row_version in the same
        //    transaction", and row_version is the total order the feed, the
        //    search index and every offline replica read in.
        const cas = await tx.$queryRaw<{ row_version: bigint }[]>`
          UPDATE marc_records
             SET leader = ${stamped.leader},
                 content_hash = ${Buffer.from(hash)},
                 current_version = ${nextVersion},
                 record_status_code = ${recordStatusCode('edit')},
                 needs_review = ${validation.after.issues.length > 0},
                 updated_by_user_id = ${actor.userId},
                 updated_at = ${now},
                 row_version = pg_catalog.nextval('record_version_seq')
           WHERE id = ${recordId}
             AND content_hash = ${Buffer.from(row.contentHash)}
             AND deleted_at IS NULL
          RETURNING row_version`;
        if (cas.length === 0) {
          await this.staleConflict(tx, recordId, currentHex);
        }
        const bumped = cas;

        await tx.marcRecordContent.update({
          where: { recordId },
          data: {
            content: stamped.fields as never,
            // The original bytes are no longer what this record says. Keeping
            // them would let `?fidelity=source` serve a document that does not
            // exist any more, which is worse than serving none.
            sourceBlob: null,
            sourceBlobSha256: null,
            updatedAt: now,
          },
        });

        // 8. A version row only when something changed. §2: "a save that changes
        //    nothing writes no version but an export always carries a current
        //    transaction timestamp" — so 005 and updated_at moved above even in
        //    the identical case, and only this is skipped.
        if (change.verdict !== 'identical') {
          await tx.marcRecordVersion.create({
            data: {
              recordId,
              version: nextVersion,
              leader: stamped.leader,
              content: stamped.fields as never,
              contentHash: hash,
              changeKind: opts.changeKind,
              changeSummary: opts.changeSummary ?? null,
              changedTags: [...change.changedTags],
              actorKind: actor.actorType,
              actorId: actor.actorId,
              createdAt: now,
            },
          });
        }

        // 9. THE PROJECTION. §2 requires it to be recomputed "inside the same
        //    transaction as every write", so that a record and its projection
        //    can never be observed disagreeing. Here, not after the commit:
        //    a projection written afterwards is a second transaction that can
        //    fail on its own, and the window between them is exactly long
        //    enough for the OPAC to render the previous title.
        //
        //    Unconditional, including when the verdict is `identical`. A save
        //    that changed nothing still re-derives the projection, which is what
        //    makes a re-save the manual repair for a record the projector has
        //    since learned to read better.
        await this.projection.project(tx, { recordId, kind: row.kind, record: stamped, now });

        return {
          version: nextVersion,
          hash,
          record: stamped,
          change,
          validation,
          rowVersion: bumped[0]?.row_version ?? 0n,
        };
      },
      { isolationLevel: 'ReadCommitted' },
    );

    await this.audit.record(tenant, actor, {
      action: opts.changeKind === 'restore' ? 'catalog.record.restored' : 'catalog.record.edited',
      targetType: 'marc_record',
      targetId: recordId,
      after: {
        version: outcome.version,
        verdict: outcome.change.verdict,
        changedTags: [...outcome.change.changedTags],
      },
    });

    return {
      recordId,
      version: outcome.version,
      contentHash: HEX(outcome.hash),
      rowVersion: String(outcome.rowVersion),
      record: outcome.record,
      changedTags: outcome.change.changedTags,
      verdict: outcome.change.verdict,
      issues: outcome.validation.introduced,
      needsReview: outcome.validation.after.issues.length > 0,
    };
  }
  /**
   * Every version of a record, newest first.
   *
   * The document is deliberately NOT selected. A version list is rendered as a
   * sidebar of twenty rows and the documents behind them are ~1.6 KB each; the
   * 1:1 split exists so a list can be a list.
   *
   * The return type is written out rather than inferred because the inferred one
   * names generated enum types from inside `node_modules`, which TypeScript
   * refuses to emit. Hex rather than bytes is also the better API: a hash is an
   * opaque token a client echoes back as `expectedContentHash`, and JSON has no
   * bytes.
   */
  async versions(tenant: TenantContext, recordId: string): Promise<VersionSummary[]> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const rows = await client.marcRecordVersion.findMany({
      where: { recordId },
      orderBy: { version: 'desc' },
      select: {
        version: true,
        contentHash: true,
        changeKind: true,
        changeSummary: true,
        changedTags: true,
        actorKind: true,
        actorId: true,
        createdAt: true,
      },
    });
    return rows.map((r) => ({
      version: r.version,
      contentHash: HEX(r.contentHash),
      changeKind: String(r.changeKind),
      changeSummary: r.changeSummary,
      changedTags: r.changedTags,
      actorKind: String(r.actorKind),
      actorId: r.actorId,
      createdAt: r.createdAt,
    }));
  }

  /** The field-level difference between two stored versions. */
  async diffVersions(
    tenant: TenantContext,
    recordId: string,
    from: number,
    to: number,
  ): Promise<MarcDiff> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const rows = await client.marcRecordVersion.findMany({
      where: { recordId, version: { in: [from, to] } },
      select: { version: true, leader: true, content: true },
    });
    const at = (v: number) => {
      const row = rows.find((r) => r.version === v);
      if (!row) throw new NotFoundException(`Record ${recordId} has no version ${v}.`);
      return { leader: row.leader, fields: row.content as unknown as MarcRecord['fields'] };
    };
    return contentDiff(at(from), at(to));
  }

  /**
   * Restore a stored version.
   *
   * A restore is a FORWARD write, never a rewind: it reads version N, writes it
   * as the new current state, and creates a NEW version row. Rewinding
   * `current_version` and deleting the rows after it would destroy the record of
   * what was undone, which is the thing a version history is for.
   *
   * It is also why `packages/marc` has no `undo`/`invertAll` and must not grow
   * one: measured there, a naive reverse-and-invert restored 3,023 of 3,804
   * random multi-op batches and silently corrupted the rest. Undoing a batch is
   * a snapshot restore, which is this.
   */
  async restore(
    tenant: TenantContext,
    actor: TenantActor,
    recordId: string,
    version: number,
    expectedContentHash?: string,
  ): Promise<WriteResult> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const snapshot = await client.marcRecordVersion.findFirst({
      where: { recordId, version },
      select: { leader: true, content: true },
    });
    if (!snapshot) throw new NotFoundException(`Record ${recordId} has no version ${version}.`);

    // The snapshot IS the next state. Not expressed as ops, deliberately:
    // `packages/marc` has no `setLeader` op, and building a
    // delete-everything-then-insert-everything op list to reach a state we
    // already hold would be a second, longer way of saying the same thing —
    // with the ops themselves as an extra place to be wrong.
    //
    // `produce` ignores the base for exactly that reason. Everything else — the
    // lock, the precondition, NFC, the 005 stamp, validateDelta, the CAS, the
    // new version row — is the same code an edit runs, so a restore cannot
    // acquire different behaviour by accident.
    return this.writeCore(tenant, actor, {
      recordId,
      expectedContentHash,
      changeKind: 'restore',
      changeSummary: `Restored version ${version}`,
      produce: () => ({
        leader: snapshot.leader,
        fields: snapshot.content as unknown as MarcRecord['fields'],
      }),
    });
  }
}

/** 008/00-05 — yymmdd, UTC. */
function yymmdd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/**
 * A `MarcError` as an HTTP response.
 *
 * Keyed on `.code`, not on a subclass: `packages/marc` has exactly one exception
 * class and distinguishes cases with a string. `shippedSchema` and `loadSchema`
 * throw a plain `Error` instead, which is why the schema lookup is wrapped
 * separately rather than relying on this.
 */
function marcErrorToHttp(err: unknown): unknown {
  if (!(err instanceof MarcError)) return err;
  const stale = err.code === 'precondition-failed';
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: stale ? 'catalog.opPreconditionFailed' : `catalog.${err.code}`,
    message: stale
      ? 'One of these edits expected a value the record no longer has, so nothing was saved.'
      : err.message,
    marcCode: err.code,
  });
}
