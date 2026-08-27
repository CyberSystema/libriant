import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { BookCopyStatus, Prisma, TenantPrismaClient } from '@libriant/db-tenant';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { FieldDefinitionsService } from '../customization/field-definitions.service.js';
import { QuotaService } from '../customization/quota.service.js';
import { EffectivePlanService, isUnlimitedInt } from '../plans/effective-plan.service.js';
import { validateRecordOrThrow } from '../customization/dynamic-validator.js';
import { AuthorsService } from './authors.service.js';
import { buildSearchText, classifySearchTerm, digitsOnly, normalizeText } from './normalize.js';
import { decodeCursor, encodeCursor } from '../platform/query.js';

export type BookAuthorLink = { authorId: string; order: number; role: string | null };

export type BookDto = {
  id: string;
  title: string;
  subtitle: string | null;
  sortTitle: string;
  isbn13: string | null;
  isbn10: string | null;
  publisher: string | null;
  publicationYear: number | null;
  language: string | null;
  edition: string | null;
  numPages: number | null;
  description: string | null;
  coverAssetRef: string | null;
  classification: string | null;
  customFields: Record<string, unknown>;
  authors: Array<{
    authorId: string;
    fullName: string;
    sortName: string;
    order: number;
    role: string | null;
  }>;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

export type BookWithCopiesDto = BookDto & {
  copies: Array<{
    id: string;
    barcode: string;
    status: BookCopyStatus;
    shelfLocation: string | null;
    archivedAt: Date | null;
  }>;
  copyCounts: { total: number; available: number };
};

export type ListBooksOptions = {
  q?: string;
  authorId?: string;
  yearFrom?: number;
  yearTo?: number;
  after?: string;
  limit?: number;
  includeArchived?: boolean;
};

export type ListBooksResult = {
  items: BookDto[];
  nextCursor: string | null;
  /**
   * Present ONLY when the caller's `q` was too short to be indexed and the
   * page was therefore answered empty without querying (performance-12).
   * Additive: every existing consumer reads `items` / `nextCursor` and is
   * unaffected.
   */
  minQueryChars?: number;
};

@Injectable()
export class BooksService {
  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(AuthorsService) private readonly authors: AuthorsService,
    @Inject(FieldDefinitionsService) private readonly fieldDefs: FieldDefinitionsService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(EffectivePlanService) private readonly plans: EffectivePlanService,
  ) {}

  /**
   * Is there a real `max_books` ceiling to enforce for this tenant, or is the
   * limit the "no ceiling" sentinel?
   *
   * performance-05. `QuotaService.enforceWithinTx` takes
   * `pg_advisory_xact_lock('quota:<tenant>:max_books:')` and THEN runs
   * `count(*) FROM books WHERE "archivedAt" IS NULL`, held under a lock that
   * serialises the whole library's cataloguing session behind it. That count
   * used to be a full scan, because nothing indexed the predicate — measured on
   * a 400,000-title catalogue, on the literal statement Prisma emits:
   *
   *   Aggregate … Seq Scan on books  Buffers: shared hit=32 read=10494
   *                                  Execution Time: 61.893 ms
   *
   * In the SHIPPED configuration (`BILLING_ENABLED=false`) every int feature
   * resolves to `UNLIMITED_INT`, so that scan and that lock were being paid to
   * compare a number against `Number.MAX_SAFE_INTEGER`. There is no ceiling to
   * race for, so there is nothing to serialise and nothing to count: skip both.
   *
   * Read BEFORE the transaction opens, deliberately: `getEffectivePlan` is a
   * Redis-cached read, and doing it inside would put a network round trip
   * inside the lock window this exists to shrink.
   *
   * When the limit IS finite — the posture the launch cohort moves into the day
   * subscriptions are switched on — the enforcement path below is unchanged and
   * the count still runs inside the lock, but it is no longer a scan: migration
   * 20260827093000_books_active_count_index adds
   * `books_active_idx ON books (id) WHERE "archivedAt" IS NULL`, and the same
   * statement becomes `Index Only Scan … Buffers: shared hit=1536,
   * Execution Time: 23.835 ms`. The predicate is provable there — Prisma emits
   * `"archivedAt" IS NULL` verbatim, with no parameter and no cast — which is
   * why a partial index works here and could not for the `loans` status
   * predicate; the migration comment carries that comparison.
   */
  private async maxBooksCeilingApplies(tenantId: string): Promise<boolean> {
    return !isUnlimitedInt(await this.plans.getInt(tenantId, 'max_books'));
  }

  async list(tenant: TenantContext, opts: ListBooksOptions = {}): Promise<ListBooksResult> {
    const client = this.tenantPrisma.getClient(tenant);
    const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
    const where: Prisma.BookWhereInput = {};
    if (!opts.includeArchived) where.archivedAt = null;
    // performance-12: the server-side floor on search-term length. The client
    // used to be the only thing standing between a two-letter term and a full
    // scan of the catalogue, and only the Combobox had one — the catalogue
    // screen goes through DataTable's URL-driven search, which does not. An
    // empty page (with `minQueryChars` so the UI can say "keep typing") is
    // returned rather than an unfiltered one: handing back the whole catalogue
    // for "ab" reads as a broken filter.
    const term = classifySearchTerm(opts.q);
    if (term.kind === 'short') {
      return { items: [], nextCursor: null, minQueryChars: term.minChars };
    }
    if (term.kind === 'term') where.searchText = { contains: term.value };
    if (opts.authorId) where.authors = { some: { authorId: opts.authorId } };
    if (opts.yearFrom !== undefined)
      where.publicationYear = { ...(where.publicationYear as object), gte: opts.yearFrom };
    if (opts.yearTo !== undefined)
      where.publicationYear = { ...(where.publicationYear as object), lte: opts.yearTo };

    // performance-03. This used to be `cursor: { id: opts.after }, skip: 1`,
    // which Prisma renders as an OR of correlated subselects — Postgres cannot
    // use that as a btree start key, so it walked `books_sortTitle_idx` from
    // the beginning of the range and discarded every row before the cursor.
    // On a 400,000-title catalogue, page 1 is 0.87 ms and the page at depth
    // 200,000 is 106.90 ms with `Rows Removed by Filter: 200001`.
    //
    // The `gte` is the whole fix: it is the start key the planner can seek to,
    // and it is only expressible because the cursor token carries the last
    // row's `sortTitle` and not just its id. The OR beside it is the exact
    // boundary — `gte` alone would repeat the rows that tie on `sortTitle`.
    // Same page, 0.87 ms, `Rows Removed by Filter: 1`.
    const after = await this.decodeListCursor(client, opts.after);
    if (after) {
      where.AND = [
        { sortTitle: { gte: after.sortTitle } },
        {
          OR: [
            { sortTitle: { gt: after.sortTitle } },
            { sortTitle: after.sortTitle, id: { gt: after.id } },
          ],
        },
      ];
    }
    const rows = await client.book.findMany({
      where,
      orderBy: [{ sortTitle: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      include: this.includeAuthors(),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((r) => this.toDto(r));
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor([last.sortTitle, last.id]) : null,
    };
  }

  /**
   * Turn an `?after=` token back into the two sort values {@link list} pages on.
   *
   * Accepts a bare book id as well as our own token, for the reason spelled out
   * on `decodeCursor`: `after` used to BE an id, the controller documents it as
   * one, and a librarian scrolling the catalogue through a deploy should not be
   * thrown a 400. A cursor row that has since been deleted resolves to `null`,
   * which restarts them at page 1.
   */
  private async decodeListCursor(
    client: TenantPrismaClient,
    after: string | undefined,
  ): Promise<{ sortTitle: string; id: string } | null> {
    if (!after) return null;
    const parts = decodeCursor(after, 2);
    if (parts) {
      const [sortTitle, id] = parts;
      return typeof sortTitle === 'string' && typeof id === 'string' ? { sortTitle, id } : null;
    }
    return client.book.findUnique({
      where: { id: after },
      select: { sortTitle: true, id: true },
    });
  }

  async get(tenant: TenantContext, id: string): Promise<BookWithCopiesDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const row = await client.book.findUnique({
      where: { id },
      include: {
        ...this.includeAuthors(),
        copies: {
          where: { archivedAt: null },
          orderBy: { barcode: 'asc' },
          select: { id: true, barcode: true, status: true, shelfLocation: true, archivedAt: true },
        },
      },
    });
    if (!row) throw new NotFoundException('Book not found.');
    const base = this.toDto(row);
    const copies = row.copies.map((c) => ({
      id: c.id,
      barcode: c.barcode,
      status: c.status,
      shelfLocation: c.shelfLocation,
      archivedAt: c.archivedAt,
    }));
    return {
      ...base,
      copies,
      copyCounts: {
        total: copies.length,
        available: copies.filter((c) => c.status === 'available').length,
      },
    };
  }

  async create(
    tenant: TenantContext,
    input: {
      title: string;
      subtitle?: string;
      isbn13?: string;
      isbn10?: string;
      publisher?: string;
      publicationYear?: number;
      language?: string;
      edition?: string;
      numPages?: number;
      description?: string;
      coverAssetRef?: string;
      classification?: string;
      authors?: Array<{ authorId: string; order?: number; role?: string }>;
      customFields?: Record<string, unknown>;
    },
  ): Promise<BookWithCopiesDto> {
    // 1. Validate customFields against active field definitions for `book`.
    const defs = await this.fieldDefs.loadActiveForValidation(tenant, 'book');
    const cleanedCustom = validateRecordOrThrow(defs, input.customFields ?? {}, {
      unknownFields: 'reject',
    });

    // 2. Verify author ids exist + are active.
    const authorLinks = (input.authors ?? []).map((a, i) => ({
      authorId: a.authorId,
      order: a.order ?? i,
      role: a.role ?? null,
    }));
    await this.authors.requireExist(
      tenant,
      authorLinks.map((a) => a.authorId),
    );

    // 3. Compute sortTitle + searchText from the canonical payload.
    const sortTitle = normalizeText(input.title);
    const isbn13 = sanitizeIsbn13(input.isbn13);
    const isbn10 = sanitizeIsbn10(input.isbn10);
    const authorRows = authorLinks.length
      ? await this.tenantPrisma.getClient(tenant).author.findMany({
          where: { id: { in: authorLinks.map((a) => a.authorId) } },
          select: { id: true, fullName: true },
        })
      : [];
    const authorNames = authorRows.map((a) => a.fullName);
    const searchText = buildSearchText([
      input.title,
      input.subtitle,
      ...authorNames,
      input.publisher,
      isbn13,
      isbn10,
      input.publicationYear,
    ]);

    const client = this.tenantPrisma.getClient(tenant);
    const ceilingApplies = await this.maxBooksCeilingApplies(tenant.id);
    try {
      // Enforce `max_books` and insert in ONE transaction, serialized by a
      // per-tenant advisory lock, so parallel creates can't both pass the
      // quota check and push the tenant past its plan ceiling. This is the ONLY
      // authority for `max_books` now, and deliberately so: the route used to
      // also carry `@RequiresQuota('max_books')`, which made QuotaInterceptor
      // run QUOTA_COUNTERS.max_books — the SAME count — before this method was
      // entered, so every create paid for two of them and the racy pre-check
      // decided nothing this transaction did not decide again. The decorator is
      // gone from books.controller.ts (which says so at the create handler) and
      // the interceptor now short-circuits on an unlimited ceiling anyway.
      const created = await client.$transaction(async (tx) => {
        if (ceilingApplies) {
          await this.quota.enforceWithinTx(tx, {
            tenantId: tenant.id,
            featureKey: 'max_books',
            count: () => tx.book.count({ where: { archivedAt: null } }),
          });
        }
        return tx.book.create({
          data: {
            title: input.title,
            subtitle: input.subtitle ?? null,
            sortTitle,
            searchText,
            isbn13,
            isbn10,
            publisher: input.publisher ?? null,
            publicationYear: input.publicationYear ?? null,
            language: input.language ?? null,
            edition: input.edition ?? null,
            numPages: input.numPages ?? null,
            description: input.description ?? null,
            coverAssetRef: input.coverAssetRef ?? null,
            classification: input.classification ?? null,
            customFields: cleanedCustom as Prisma.InputJsonValue,
            authors: {
              create: authorLinks.map((a) => ({
                authorId: a.authorId,
                order: a.order,
                role: a.role,
              })),
            },
          },
          include: {
            ...this.includeAuthors(),
            copies: true,
          },
        });
      });
      return this.toWithCopiesDto(created);
    } catch (err) {
      throw this.translateDbError(err);
    }
  }

  async update(
    tenant: TenantContext,
    id: string,
    input: {
      title?: string;
      subtitle?: string | null;
      isbn13?: string | null;
      isbn10?: string | null;
      publisher?: string | null;
      publicationYear?: number | null;
      language?: string | null;
      edition?: string | null;
      numPages?: number | null;
      description?: string | null;
      coverAssetRef?: string | null;
      classification?: string | null;
      authors?: Array<{ authorId: string; order?: number; role?: string }>;
      customFields?: Record<string, unknown>;
      archived?: boolean;
    },
  ): Promise<BookWithCopiesDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.book.findUnique({
      where: { id },
      include: this.includeAuthors(),
    });
    if (!existing) throw new NotFoundException('Book not found.');

    // Validate customFields (partial mode: allow omitted required fields,
    // but still validate the values that ARE provided).
    let cleanedCustom: Record<string, unknown> | undefined;
    if (input.customFields !== undefined) {
      const defs = await this.fieldDefs.loadActiveForValidation(tenant, 'book');
      cleanedCustom = validateRecordOrThrow(defs, input.customFields, {
        unknownFields: 'reject',
        partial: true,
      });
    }

    let authorLinks: Array<{ authorId: string; order: number; role: string | null }> | undefined;
    if (input.authors !== undefined) {
      authorLinks = input.authors.map((a, i) => ({
        authorId: a.authorId,
        order: a.order ?? i,
        role: a.role ?? null,
      }));
      await this.authors.requireExist(
        tenant,
        authorLinks.map((a) => a.authorId),
      );
    }

    // Recompute search/sort if title/subtitle/authors/publisher/isbn changed.
    const titleAfter = input.title ?? existing.title;
    const subtitleAfter = input.subtitle === undefined ? existing.subtitle : input.subtitle;
    const isbn13After =
      input.isbn13 === undefined ? existing.isbn13 : sanitizeIsbn13(input.isbn13 ?? undefined);
    const isbn10After =
      input.isbn10 === undefined ? existing.isbn10 : sanitizeIsbn10(input.isbn10 ?? undefined);
    const publisherAfter = input.publisher === undefined ? existing.publisher : input.publisher;
    const publicationYearAfter =
      input.publicationYear === undefined ? existing.publicationYear : input.publicationYear;
    const authorsAfter =
      authorLinks ??
      existing.authors.map((l) => ({ authorId: l.authorId, order: l.order, role: l.role }));
    const authorNamesAfter = authorLinks
      ? (
          await client.author.findMany({
            where: { id: { in: authorLinks.map((a) => a.authorId) } },
            select: { fullName: true },
          })
        ).map((a) => a.fullName)
      : existing.authors.map((l) => l.author.fullName);

    const sortTitle = normalizeText(titleAfter);
    const searchText = buildSearchText([
      titleAfter,
      subtitleAfter,
      ...authorNamesAfter,
      publisherAfter,
      isbn13After,
      isbn10After,
      publicationYearAfter,
    ]);

    const data: Prisma.BookUpdateInput = { sortTitle, searchText };
    if (input.title !== undefined) data.title = input.title;
    if (input.subtitle !== undefined) data.subtitle = input.subtitle;
    if (input.isbn13 !== undefined) data.isbn13 = isbn13After;
    if (input.isbn10 !== undefined) data.isbn10 = isbn10After;
    if (input.publisher !== undefined) data.publisher = input.publisher;
    if (input.publicationYear !== undefined) data.publicationYear = input.publicationYear;
    if (input.language !== undefined) data.language = input.language;
    if (input.edition !== undefined) data.edition = input.edition;
    if (input.numPages !== undefined) data.numPages = input.numPages;
    if (input.description !== undefined) data.description = input.description;
    if (input.coverAssetRef !== undefined) data.coverAssetRef = input.coverAssetRef;
    if (input.classification !== undefined) data.classification = input.classification;
    if (cleanedCustom !== undefined) {
      data.customFields = {
        ...((existing.customFields as Record<string, unknown>) ?? {}),
        ...cleanedCustom,
      } as Prisma.InputJsonValue;
    }
    if (input.archived !== undefined) {
      data.archivedAt = input.archived ? new Date() : null;
    }
    // Un-archiving consumes a max_books seat just like a create — enforce it
    // (otherwise archive → create → un-archive is an unlimited bypass).
    const restoring = input.archived === false && existing.archivedAt != null;
    // Same reasoning as `create` — see maxBooksCeilingApplies. Resolved before
    // the transaction opens so an un-archive under an unlimited ceiling never
    // takes the lock or runs the count.
    const enforceOnRestore = restoring && (await this.maxBooksCeilingApplies(tenant.id));

    try {
      const updated = await client.$transaction(async (tx) => {
        if (enforceOnRestore) {
          await this.quota.enforceWithinTx(tx, {
            tenantId: tenant.id,
            featureKey: 'max_books',
            count: () => tx.book.count({ where: { archivedAt: null } }),
          });
        }
        // Replace author links wholesale when supplied.
        if (authorLinks) {
          await tx.bookAuthor.deleteMany({ where: { bookId: id } });
          if (authorLinks.length) {
            await tx.bookAuthor.createMany({
              data: authorLinks.map((a) => ({
                bookId: id,
                authorId: a.authorId,
                order: a.order,
                role: a.role,
              })),
            });
          }
        }
        return tx.book.update({
          where: { id },
          data,
          include: {
            ...this.includeAuthors(),
            copies: {
              where: { archivedAt: null },
              orderBy: { barcode: 'asc' },
              select: {
                id: true,
                barcode: true,
                status: true,
                shelfLocation: true,
                archivedAt: true,
              },
            },
          },
        });
      });
      return this.toWithCopiesDto(updated as never);
    } catch (err) {
      throw this.translateDbError(err);
    }

    // Silence unused-var warning when only the side-effect branch ran.
    void authorsAfter;
  }

  async archive(tenant: TenantContext, id: string): Promise<BookWithCopiesDto> {
    return this.update(tenant, id, { archived: true });
  }

  // -------- helpers -------------------------------------------------------

  private includeAuthors() {
    return {
      authors: {
        orderBy: { order: 'asc' as const },
        include: {
          author: { select: { fullName: true, sortName: true } },
        },
      },
    } as const;
  }

  private toDto(row: {
    id: string;
    title: string;
    subtitle: string | null;
    sortTitle: string;
    isbn13: string | null;
    isbn10: string | null;
    publisher: string | null;
    publicationYear: number | null;
    language: string | null;
    edition: string | null;
    numPages: number | null;
    description: string | null;
    coverAssetRef: string | null;
    classification: string | null;
    customFields: unknown;
    createdAt: Date;
    updatedAt: Date;
    archivedAt: Date | null;
    authors: Array<{
      authorId: string;
      order: number;
      role: string | null;
      author: { fullName: string; sortName: string };
    }>;
  }): BookDto {
    return {
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      sortTitle: row.sortTitle,
      isbn13: row.isbn13,
      isbn10: row.isbn10,
      publisher: row.publisher,
      publicationYear: row.publicationYear,
      language: row.language,
      edition: row.edition,
      numPages: row.numPages,
      description: row.description,
      coverAssetRef: row.coverAssetRef,
      classification: row.classification,
      customFields: (row.customFields as Record<string, unknown>) ?? {},
      authors: row.authors.map((l) => ({
        authorId: l.authorId,
        fullName: l.author.fullName,
        sortName: l.author.sortName,
        order: l.order,
        role: l.role,
      })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
    };
  }

  private toWithCopiesDto(row: {
    id: string;
    title: string;
    subtitle: string | null;
    sortTitle: string;
    isbn13: string | null;
    isbn10: string | null;
    publisher: string | null;
    publicationYear: number | null;
    language: string | null;
    edition: string | null;
    numPages: number | null;
    description: string | null;
    coverAssetRef: string | null;
    classification: string | null;
    customFields: unknown;
    createdAt: Date;
    updatedAt: Date;
    archivedAt: Date | null;
    authors: Array<{
      authorId: string;
      order: number;
      role: string | null;
      author: { fullName: string; sortName: string };
    }>;
    copies: Array<{
      id: string;
      barcode: string;
      status: BookCopyStatus;
      shelfLocation: string | null;
      archivedAt: Date | null;
    }>;
  }): BookWithCopiesDto {
    const base = this.toDto(row);
    return {
      ...base,
      copies: row.copies.map((c) => ({
        id: c.id,
        barcode: c.barcode,
        status: c.status,
        shelfLocation: c.shelfLocation,
        archivedAt: c.archivedAt,
      })),
      copyCounts: {
        total: row.copies.length,
        available: row.copies.filter((c) => c.status === 'available').length,
      },
    };
  }

  /**
   * Translate raw Prisma errors into the right HTTP exception.
   *
   * Prisma surfaces CHECK-constraint violations as a
   * `PrismaClientUnknownRequestError` with NO `code` field — the
   * constraint name lives in the wrapped message. Unique violations
   * come as `PrismaClientKnownRequestError` with `code = 'P2002'`. We
   * handle both by reading whichever signal each form carries.
   */
  private translateDbError(err: unknown): Error {
    // Let deliberate HTTP errors (e.g. the 402 from the in-transaction quota
    // gate, or a 409 conflict) propagate untouched.
    if (err instanceof HttpException) return err;
    if (typeof err !== 'object' || err === null) {
      return err instanceof Error ? err : new Error(String(err));
    }
    const code = (err as { code?: string }).code;
    const message = (err as { message?: string }).message ?? '';
    if (code === 'P2002') {
      // The only uniqueness on this surface is the per-tenant partial-unique
      // index on a copy's barcode (unique among non-archived copies), so a
      // P2002 here is a duplicate barcode — say so instead of a vague
      // "these details" (CAT-005). `target` names the offending index/column.
      const target = String((err as { meta?: { target?: unknown } }).meta?.target ?? '');
      if (/barcode/i.test(target) || /barcode/i.test(message)) {
        return new ConflictException(
          'That barcode is already used by another copy. Each copy needs a unique barcode.',
        );
      }
      return new ConflictException('That conflicts with an existing record.');
    }
    if (/books_isbn13_shape/i.test(message)) {
      return new BadRequestException('ISBN-13 must be exactly 13 digits.');
    }
    if (/books_isbn10_shape/i.test(message)) {
      return new BadRequestException('ISBN-10 must be 10 digits (or end with X).');
    }
    // Generic check-violation — surface the constraint name so a librarian
    // (or a support agent reading the log) can find the cause.
    const m = message.match(/violates check constraint "([^"]+)"/);
    if (m) {
      return new BadRequestException(
        `The database rejected the value (${m[1]}). Please double-check the highlighted fields.`,
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}

function sanitizeIsbn13(input: string | undefined): string | null {
  const v = digitsOnly(input);
  if (!v) return null;
  return v;
}

function sanitizeIsbn10(input: string | undefined): string | null {
  if (!input) return null;
  const v = input.replace(/[^0-9Xx]/g, '');
  return v.length ? v : null;
}
