import { randomUUID } from 'node:crypto';
import type { ImportEntityKind } from '@libriant/db-control';
import {
  marcFromBook,
  type V1Author,
  type V1Book,
} from '@libriant/db-tenant/upgrade/marc-from-book';
import type { TenantContext } from '../../tenancy/tenant-context.js';
import type { TenantActor } from '../../tenancy/tenant-actor.js';
import { BibWriteService } from '../../bib/bib-write.service.js';
import { ItemsService } from '../../items/items.service.js';
import { PatronsService } from '../../patrons/patrons.service.js';
import type { MappedRow, RowIssue } from '../mapping/row-mapper.js';
import type { EngineRowResult } from './import-engine.js';

/**
 * The bulk importer, writing into `lbr2` (2.0 phase 20c).
 *
 * ## What was wrong
 *
 * `import-engine.ts` writes seven 1.0 tables — books, authors, book_copies,
 * members, loans, reservations, fines — and it is the ONLY thing in the product
 * that does bulk ingest of anything but MARC. Phase 20b-iii archives all seven,
 * and §6 never mentions the importer; phase 35's "migration adapters" assumes it
 * survives. So a library migrating off ABEKT or Koha after the cutover would
 * have had eleven live routes writing into a schema that had moved.
 *
 * ## The design: route through the services, not around them
 *
 * Every kind below goes through the SAME service a librarian's click goes
 * through — `BibWriteService.create`, `ItemsService.create`,
 * `PatronsService.create`. Not raw inserts.
 *
 * That is the whole point. An imported record and a typed one are then
 * indistinguishable afterwards, because they were made the same way: the same
 * validation, the same audit rows, the same change events, the same projection
 * pass. A second write path would drift from the first, and the drift would be
 * invisible until somebody asked why an imported record had no version history.
 *
 * It also means this file is short. The 1.0 engine carries 1,756 lines because
 * it reimplements what the services do; this carries the mapping and nothing
 * else.
 *
 * ## Authors stop being an entity
 *
 * 1.0 has an `authors` table, a `book_authors` join, and `author` as an import
 * kind. 2.0 has none of them: a contributor lives inside the MARC record as a
 * 100 or 700 field, and there is no authority store until phase 45. So an
 * `author` import has no destination and is refused BY NAME rather than
 * silently accepted into nothing — and the authors that matter arrive attached
 * to their book, which is how `marcFromBook` already takes them.
 *
 * ## MARC synthesis is not written twice
 *
 * `marcFromBook` is phase 19b's, written for the upgrade's copy-forward and
 * exported from `@libriant/db-tenant`. It already turns a 1.0-shaped book plus
 * its authors into a MARC record with the right 008, the right non-filing
 * indicators, ISO 639-2/B language codes and validated ISBNs. An importer that
 * synthesised its own MARC would be a second implementation whose only job is
 * to agree with the first.
 *
 * ## What this phase does NOT do, and why the line is here
 *
 * `loan`, `reservation` and `fine` are refused, naming phase 20d. The line is
 * not arbitrary — it is the dependency order. All three REFERENCE a copy, a
 * record or a patron, so none of them can be imported until these three kinds
 * work, and a library migrating in loads them in exactly this sequence.
 *
 * They also need a decision this phase should not make quietly. Routing them
 * through the services means `CheckoutService` refuses a historical loan for a
 * patron who is blocked today, and `FeesService` posts a double-entry journal
 * for a fine that was settled in the old system two years ago. 2.0 has an
 * override path for the first — "clear or override every blocking reason" — so
 * a bulk import would record an override per row, which is arguably correct and
 * certainly auditable. That is a product decision with a paper trail attached,
 * and it deserves to be made deliberately rather than inherited from whichever
 * service was convenient.
 */
export type EngineV2Context = {
  readonly tenant: TenantContext;
  readonly actor: TenantActor;
  readonly duplicateMode: 'skip' | 'update' | 'error';
  readonly dryRun: boolean;
  /** 040 $a / 003. The library's own MARC organisation code. */
  readonly orgCode: string;
};

/** The kinds this phase can write. The rest are named refusals. */
export const V2_SUPPORTED_KINDS: readonly ImportEntityKind[] = ['book', 'book_copy', 'member'];

export class ImportEngineV2 {
  constructor(
    private readonly kind: ImportEntityKind,
    private readonly ctx: EngineV2Context,
    private readonly bibs: BibWriteService,
    private readonly items: ItemsService,
    private readonly patrons: PatronsService,
  ) {}

  /**
   * The runner's entry point: gate the row, then write it.
   *
   * The same three steps `ImportEngine.processRow` takes, for the same reasons
   * — a row the mapper already rejected never reaches a service, and a database
   * error becomes an issue on that row rather than the end of a 4,000-row
   * import.
   *
   * CUSTOM FIELDS ARE REFUSED RATHER THAN DROPPED. 1.0 validates them here
   * against `field_definitions` and stores them on the row. 2.0 has the table
   * and no service that writes to it, so a mapped custom field has nowhere to
   * go — and an importer that silently discarded a column the librarian
   * deliberately mapped would lose data with no trace anywhere. The row fails
   * by name instead.
   */
  async processRow(row: MappedRow): Promise<EngineRowResult> {
    const issues: RowIssue[] = [...row.issues];
    if (issues.some((i) => i.severity === 'error')) {
      return { rowNumber: row.rowNumber, outcome: 'error', issues };
    }

    const custom = Object.keys(row.customFields);
    if (custom.length > 0) {
      return this.error(
        row,
        issues,
        custom[0]!,
        `2.0 has no writer for custom fields yet, so ${custom.join(', ')} would be dropped ` +
          'silently. Unmap the column and import it once the field surface lands.',
      );
    }

    try {
      return await this.commit(row, issues);
    } catch (err) {
      issues.push(this.dbIssue(err));
      return { rowNumber: row.rowNumber, outcome: 'error', issues };
    }
  }

  async commit(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    switch (this.kind) {
      case 'book':
        return this.commitBook(row, issues);
      case 'book_copy':
        return this.commitCopy(row, issues);
      case 'member':
        return this.commitMember(row, issues);
      case 'author':
        return this.refuse(
          row,
          issues,
          'author',
          'A contributor is a 100 or 700 field inside the MARC record in 2.0, not a row of its ' +
            'own — there is no authority store until phase 45. Import the authors on the book ' +
            'rows instead; the columns are read from there.',
        );
      default:
        return this.refuse(
          row,
          issues,
          this.kind,
          `Importing ${this.kind} into the 2.0 schema is phase 20d. It references a record, a ` +
            'copy or a patron, so it cannot be loaded before those are — which is also the order ' +
            'a migration runs in.',
        );
    }
  }

  // -------------------------------------------------------------------------

  private async commitBook(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    const v = row.values;
    // THE 001 IS NOT THE RECORD'S OWN ID HERE, and that is the one place this
    // diverges from the upgrade deliberately.
    //
    // The copy-forward sets 001 to the existing cuid because every permalink,
    // audit target and offline replica already points at it. An imported record
    // has no such history — nothing refers to it yet — and its id is minted by
    // Prisma's `@default(cuid())` at insert, so it is not knowable before the
    // write. So the control number is the SOURCE's, when the file carries one,
    // and otherwise a generated one; either way it is unique per kind, which is
    // what `marc_records_control_number_unique_active` asks of it.
    const controlNumber = this.str(v['sourceId']) ?? this.str(v['id']) ?? randomUUID();
    const now = new Date();
    const book: V1Book = {
      id: controlNumber,
      title: this.str(v['title']) ?? '',
      subtitle: this.str(v['subtitle']),
      isbn13: this.str(v['isbn13']),
      isbn10: this.str(v['isbn10']),
      publisher: this.str(v['publisher']),
      publicationYear: this.num(v['publicationYear']),
      language: this.str(v['language']),
      edition: this.str(v['edition']),
      numPages: this.num(v['numPages']),
      description: this.str(v['description']),
      classification: this.str(v['classification']),
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    if (book.title.length === 0) {
      return this.error(row, issues, 'title', 'A record with no title cannot be catalogued.');
    }

    // Authors arrive on the book row, in order, main entry first. `order: 0` is
    // the 100; the rest become 700s, which is `marcFromBook`'s own rule.
    const authors: V1Author[] = this.authorsFrom(v);

    const { record, issues: synth } = marcFromBook(book, authors, this.ctx.orgCode);
    for (const s of synth) {
      // EVERY synthesis issue is a WARNING, including `invalid_source`.
      //
      // The first version of this made a bad source value an error, and that was
      // wrong: `marcFromBook` does not report a problem it has not already
      // handled. A failing ISBN check digit goes into 020 $z instead of $a —
      // which is exactly what $z means in MARC, "invalid ISBN" — so the record
      // is correct and the bad number is preserved where a cataloguer can see
      // it. The upgrade takes the same position: it writes the note to
      // `upgrade_exceptions` and carries the book forward.
      //
      // Rejecting the row would throw away a good title, author and publisher
      // over one mistyped digit, on the import where the library has least
      // ability to go back and fix the source.
      issues.push({
        field: s.column,
        code: `marc.${s.kind}`,
        severity: 'warning',
        message: s.note,
      });
    }
    if (this.ctx.dryRun) {
      return { rowNumber: row.rowNumber, outcome: 'imported', issues };
    }

    // `SynthesisedRecord.fields` types `i` as optional because a control field
    // has no indicator, while `MarcField` splits the two shapes into a union.
    // The cast is sound and checked: every one of the nine data-field pushes in
    // `marcFromBook` sets `i`, and none of the control-field pushes does — the
    // looser type is the synthesiser's convenience, not a different invariant.
    // `toMarcRecord` in bib.dto.ts does the same for the same reason.
    const written = await this.bibs.create(this.ctx.tenant, this.ctx.actor, {
      record: record as unknown as Parameters<BibWriteService['create']>[2]['record'],
      kind: 'bibliographic',
      schema: 'marc21',
      controlNumber,
    });
    return {
      rowNumber: row.rowNumber,
      outcome: 'imported',
      issues,
      entityId: written.recordId,
    };
  }

  private async commitCopy(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    const v = row.values;
    const barcode = this.str(v['barcode']);
    if (barcode === null) {
      return this.error(
        row,
        issues,
        'barcode',
        'A copy needs a barcode: it is the only thing a scanner can find it by, and 2.0 makes it ' +
          'the natural key.',
      );
    }
    const bibId = row.refs['bookId'] ?? this.str(v['bookId']);
    if (bibId === null || bibId === undefined) {
      return this.error(row, issues, 'bookId', 'A copy must name the record it is a copy of.');
    }
    if (this.ctx.dryRun) {
      return { rowNumber: row.rowNumber, outcome: 'imported', issues };
    }

    const created = await this.items.create(this.ctx.tenant, this.ctx.actor, {
      bibId,
      barcode,
      itemTypeId: this.str(v['itemTypeId']) ?? DEFAULT_ITEM_TYPE,
      owningBranchId: this.str(v['branchId']) ?? DEFAULT_BRANCH,
      permanentLocationId: this.str(v['locationId']) ?? DEFAULT_LOCATION,
    } as never);
    return {
      rowNumber: row.rowNumber,
      outcome: 'imported',
      issues,
      entityId: (created as { id: string }).id,
    };
  }

  private async commitMember(row: MappedRow, issues: RowIssue[]): Promise<EngineRowResult> {
    const v = row.values;
    const fullName = this.str(v['fullName']);
    if (fullName === null) {
      return this.error(row, issues, 'fullName', 'A patron record needs a name.');
    }
    if (this.ctx.dryRun) {
      return { rowNumber: row.rowNumber, outcome: 'imported', issues };
    }
    const created = await this.patrons.create(this.ctx.tenant, this.ctx.actor, {
      fullName,
      ...(this.str(v['email']) === null ? {} : { email: this.str(v['email']) as string }),
      ...(this.str(v['phone']) === null ? {} : { phone: this.str(v['phone']) as string }),
      ...(this.str(v['memberNumber']) === null
        ? {}
        : { patronNumber: this.str(v['memberNumber']) as string }),
    } as never);
    return {
      rowNumber: row.rowNumber,
      outcome: 'imported',
      issues,
      entityId: (created as { id: string }).id,
    };
  }

  // -------------------------------------------------------------------------

  /**
   * Authors from the book row.
   *
   * 1.0 accepts `author`, `author2`… and a semicolon list; both shapes reach
   * here as mapped values, and order decides the main entry. A row with none is
   * not an error — a great many records have no 1XX at all, and MARC says so.
   */
  private authorsFrom(v: Record<string, unknown>): V1Author[] {
    const names: string[] = [];
    const single = this.str(v['author']);
    if (single !== null)
      names.push(
        ...single
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    for (let i = 2; i <= 6; i += 1) {
      const extra = this.str(v[`author${i}`]);
      if (extra !== null) names.push(extra);
    }
    return names.map((fullName, order) => ({
      // Never stored: `marcFromBook` carries an author's id into $0 so a later
      // authority pass can find the original row. An imported author has no
      // original row, so this is a placeholder and phase 45 will match on the
      // name like it will for every other unlinked heading.
      id: randomUUID(),
      fullName,
      isOrganization: false,
      birthYear: null,
      deathYear: null,
      order,
      role: null,
    }));
  }

  /** A kind 2.0 has no home for. Named, so the operator knows what to do next. */
  private refuse(
    row: MappedRow,
    issues: RowIssue[],
    field: string,
    message: string,
  ): EngineRowResult {
    issues.push({ field, code: 'import.kindNotSupported', message, severity: 'error' });
    return { rowNumber: row.rowNumber, outcome: 'error', issues };
  }

  /** A row this kind cannot use. */
  private error(
    row: MappedRow,
    issues: RowIssue[],
    field: string,
    message: string,
  ): EngineRowResult {
    issues.push({ field, code: 'import.rowInvalid', message, severity: 'error' });
    return { rowNumber: row.rowNumber, outcome: 'error', issues };
  }

  /**
   * A database error, as an issue on the row that caused it.
   *
   * Not `import-engine.ts`'s `dbIssue`: that one names `books.isbn13` and
   * `authors.sortName` by hand, and 2.0 has neither table. The unique keys a
   * 2.0 import collides with are `items.barcode`, `patron_cards.barcode_norm`
   * and `marc_records_control_number_unique_active`, so the target Prisma
   * reports is more use to a librarian than any wording written in advance —
   * and an unrecognised error keeps its own message rather than being flattened
   * into "something went wrong".
   */
  private dbIssue(err: unknown): RowIssue {
    const message = (err as { message?: string }).message ?? String(err);
    if ((err as { code?: string }).code === 'P2002') {
      const target = (err as { meta?: { target?: unknown } }).meta?.target;
      const named = Array.isArray(target)
        ? target.join(', ')
        : typeof target === 'string'
          ? target
          : null;
      return {
        field: null,
        code: 'duplicate',
        severity: 'error',
        message:
          named === null
            ? "Another record in this library already holds one of this row's unique values."
            : `Another record in this library already holds this row's ${named}.`,
      };
    }
    return { field: null, code: 'db_error', severity: 'error', message };
  }

  private str(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t.length === 0 ? null : t;
  }

  private num(v: unknown): number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === 'string' && v.trim().length > 0) {
      const n = Number(v);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    return null;
  }
}

/**
 * The provisioning defaults a copy falls back to.
 *
 * An import that named no branch, location or item type used to be impossible —
 * 1.0 had none of those concepts. 2.0 requires all three, and every tenant has
 * exactly one of each from `seedItemDefaults`, so falling back to them is what
 * lets a two-column CSV of barcodes still load. A library with several branches
 * maps the column and the fallback never fires.
 */
const DEFAULT_BRANCH = 'branch-main';
const DEFAULT_LOCATION = 'loc-general';
const DEFAULT_ITEM_TYPE = 'itype-book';
