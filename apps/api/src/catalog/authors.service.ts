import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@libriant/db-tenant';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { classifySearchTerm, normalizeText } from './normalize.js';

/** Prisma's unique-constraint violation. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

export type AuthorDto = {
  id: string;
  fullName: string;
  sortName: string;
  isOrganization: boolean;
  birthYear: number | null;
  deathYear: number | null;
  notes: string | null;
  customFields: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

export type ListAuthorsOptions = {
  /** Fuzzy match on `sortName` (lowercased + accent-folded by writers). */
  q?: string;
  after?: string;
  limit?: number;
  includeArchived?: boolean;
};

export type ListAuthorsResult = {
  items: AuthorDto[];
  nextCursor: string | null;
  /**
   * Present ONLY when the caller's `q` was too short to be indexed and the page
   * was therefore answered empty without querying (performance-12). Additive:
   * every existing consumer reads `items` / `nextCursor` and is unaffected.
   */
  minQueryChars?: number;
};

@Injectable()
export class AuthorsService {
  constructor(@Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService) {}

  async list(tenant: TenantContext, opts: ListAuthorsOptions = {}): Promise<ListAuthorsResult> {
    const client = this.tenantPrisma.getClient(tenant);
    const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
    const where: Prisma.AuthorWhereInput = {};
    if (!opts.includeArchived) where.archivedAt = null;
    // performance-12, the same floor `BooksService.list` applies and for the
    // same reason. `sortName LIKE '%q%'` can only be answered by
    // `authors_sortname_trgm` once the pattern yields a full trigram, i.e.
    // from three characters; below that the planner has nothing to seek with
    // and reads the whole table. The finding named `books_search_trgm` and
    // `members_search_trgm`; authors is the third table in this directory with
    // the identical shape, reachable from the same URL-driven DataTable search
    // box and from the author picker, so it gets the same treatment rather
    // than waiting to be found again.
    //
    // BE HONEST ABOUT THE SIZE. Measured on the audit's 20,000-author fixture,
    // a non-matching two-character term is `Seq Scan on authors, Buffers:
    // shared hit=246, 1.88 ms` — and at that size a THREE-character term also
    // seq-scans (246 buffers), because the planner does not reach for the GIN
    // index on a table this small. So the win here is not "the index takes
    // over at three", it is "the query is not run at all below three": 246
    // buffers per keystroke that a staff member can hold down, on a shared
    // Postgres, becomes zero. The 1,915x index crossover the finding measured
    // is the catalogue's (13,407 buffers vs 7 at 400,000 titles); an authors
    // table only reaches it once a library's name list is large.
    const term = classifySearchTerm(opts.q);
    if (term.kind === 'short') {
      return { items: [], nextCursor: null, minQueryChars: term.minChars };
    }
    if (term.kind === 'term') where.sortName = { contains: term.value };
    const rows = await client.author.findMany({
      where,
      orderBy: [{ sortName: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(opts.after ? { cursor: { id: opts.after }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => this.toDto(r));
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  }

  async get(tenant: TenantContext, id: string): Promise<AuthorDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const row = await client.author.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Author not found.');
    return this.toDto(row);
  }

  async create(
    tenant: TenantContext,
    input: {
      fullName: string;
      isOrganization?: boolean;
      birthYear?: number;
      deathYear?: number;
      notes?: string;
      customFields?: Record<string, unknown>;
    },
  ): Promise<AuthorDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const sortName = normalizeText(input.fullName);

    // RETURN THE EXISTING AUTHOR RATHER THAN FAILING.
    //
    // `authors_sortname_unique_active` makes the accent-folded name the natural
    // key, which is what makes the importer's deduplication real. But a
    // librarian typing "ΓΙΩΡΓΟΣ ΣΕΦΕΡΗΣ" when "Γιώργος Σεφέρης" already exists
    // folds to the same sortName, and a bare create then raised a Prisma error
    // that HttpExceptionFilter — which is @Catch() and sees neither an
    // HttpException nor a client status — re-skinned as a 500 with a support
    // code. Adding the constraint without this turned an ordinary action into
    // an incident.
    //
    // Returning the existing row is what the finding asks for and what the
    // importer already does: two people typing the same name mean one author.
    const existing = await client.author.findFirst({
      where: { sortName, archivedAt: null },
    });
    if (existing) return this.toDto(existing);

    const created = await this.createRow(client, input, sortName);
    return this.toDto(created);
  }

  /**
   * The insert itself, with the race the lookup above cannot close.
   *
   * Two requests can both find nothing and both insert. The constraint is the
   * real arbiter — so catch its violation and return the row the winner wrote,
   * rather than handing the loser a 500 for doing exactly what the other did.
   */
  private async createRow(
    client: ReturnType<TenantPrismaService['getClient']>,
    input: {
      fullName: string;
      isOrganization?: boolean;
      birthYear?: number;
      deathYear?: number;
      notes?: string;
      customFields?: Record<string, unknown>;
    },
    sortName: string,
  ) {
    try {
      return await client.author.create({
        data: {
          fullName: input.fullName,
          sortName,
          isOrganization: input.isOrganization ?? false,
          birthYear: input.birthYear ?? null,
          deathYear: input.deathYear ?? null,
          notes: input.notes ?? null,
          customFields: (input.customFields ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code !== PRISMA_UNIQUE_VIOLATION) throw err;
      const winner = await client.author.findFirst({ where: { sortName, archivedAt: null } });
      if (winner) return winner;
      // The constraint fired but the row is not there — an archived collision,
      // or the winner was rolled back. Rethrow rather than invent a result.
      throw err;
    }
  }

  async update(
    tenant: TenantContext,
    id: string,
    input: {
      fullName?: string;
      isOrganization?: boolean;
      birthYear?: number;
      deathYear?: number;
      notes?: string;
      customFields?: Record<string, unknown>;
      archived?: boolean;
    },
  ): Promise<AuthorDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.author.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Author not found.');
    const data: Prisma.AuthorUpdateInput = {};
    if (input.fullName !== undefined) {
      data.fullName = input.fullName;
      data.sortName = normalizeText(input.fullName);
    }
    if (input.isOrganization !== undefined) data.isOrganization = input.isOrganization;
    if (input.birthYear !== undefined) data.birthYear = input.birthYear;
    if (input.deathYear !== undefined) data.deathYear = input.deathYear;
    if (input.notes !== undefined) data.notes = input.notes;
    if (input.customFields !== undefined) {
      data.customFields = input.customFields as Prisma.InputJsonValue;
    }
    if (input.archived !== undefined) data.archivedAt = input.archived ? new Date() : null;
    // A RENAME ONTO AN EXISTING NAME IS A CONFLICT, NOT A CRASH.
    //
    // Same constraint, same 500: renaming an author to a name another active
    // author already folds to raised a raw Prisma error that the exception
    // filter turned into "something went wrong on our end" with a support code.
    // The librarian's actual situation — two records for one person — is a
    // thing they can act on, and the message has to say so.
    let updated;
    try {
      updated = await client.author.update({ where: { id }, data });
    } catch (err) {
      if ((err as { code?: string }).code !== PRISMA_UNIQUE_VIOLATION) throw err;
      throw new ConflictException({
        code: 'catalog.authorNameTaken',
        message:
          'Another author already has that name. Names are matched ignoring accents and case, so ' +
          '"Γιώργος Σεφέρης" and "ΓΙΩΡΓΟΣ ΣΕΦΕΡΗΣ" count as the same. Merge the two records or ' +
          'choose a different name.',
      });
    }
    return this.toDto(updated);
  }

  async archive(tenant: TenantContext, id: string): Promise<AuthorDto> {
    return this.update(tenant, id, { archived: true });
  }

  /** Used by BooksService to verify supplied author IDs exist + are active. */
  async requireExist(tenant: TenantContext, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const client = this.tenantPrisma.getClient(tenant);
    const rows = await client.author.findMany({
      where: { id: { in: ids }, archivedAt: null },
      select: { id: true },
    });
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) {
      throw new NotFoundException(
        `These authors don't exist (or were archived): ${missing.join(', ')}.`,
      );
    }
  }

  private toDto(row: {
    id: string;
    fullName: string;
    sortName: string;
    isOrganization: boolean;
    birthYear: number | null;
    deathYear: number | null;
    notes: string | null;
    customFields: unknown;
    createdAt: Date;
    updatedAt: Date;
    archivedAt: Date | null;
  }): AuthorDto {
    return {
      id: row.id,
      fullName: row.fullName,
      sortName: row.sortName,
      isOrganization: row.isOrganization,
      birthYear: row.birthYear,
      deathYear: row.deathYear,
      notes: row.notes,
      customFields: (row.customFields as Record<string, unknown>) ?? {},
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
    };
  }
}
