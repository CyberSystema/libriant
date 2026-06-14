import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { BookCopyStatus, Prisma } from '@libriant/db-tenant';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { FieldDefinitionsService } from '../customization/field-definitions.service.js';
import { validateRecordOrThrow } from '../customization/dynamic-validator.js';

export type CopyDto = {
  id: string;
  bookId: string;
  barcode: string;
  status: BookCopyStatus;
  shelfLocation: string | null;
  conditionNotes: string | null;
  acquiredAt: Date | null;
  priceCents: number | null;
  customFields: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

/**
 * Status transitions a library can perform directly through this service.
 *
 *   available  →  reserved | lost | damaged | withdrawn   (manual)
 *   reserved   →  available | lost | damaged | withdrawn  (manual)
 *   lost       →  available                               (was returned)
 *   damaged    →  available | withdrawn
 *   withdrawn  →  available                               (un-withdraw)
 *
 * Note: `on_loan` is intentionally NOT a self-service transition — it is
 * controlled by the Loans service (Step 13). Trying to set it through
 * this endpoint returns 400. Same the other direction (clearing `on_loan`
 * by hand is a return, not an admin action).
 */
const ALLOWED_TRANSITIONS: Record<BookCopyStatus, readonly BookCopyStatus[]> = {
  available: ['reserved', 'lost', 'damaged', 'withdrawn'],
  reserved: ['available', 'lost', 'damaged', 'withdrawn'],
  on_loan: [],
  lost: ['available'],
  damaged: ['available', 'withdrawn'],
  withdrawn: ['available'],
};

@Injectable()
export class CopiesService {
  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(FieldDefinitionsService) private readonly fieldDefs: FieldDefinitionsService,
  ) {}

  async create(
    tenant: TenantContext,
    bookId: string,
    input: {
      barcode: string;
      shelfLocation?: string;
      conditionNotes?: string;
      acquiredAt?: string;
      priceCents?: number;
      customFields?: Record<string, unknown>;
    },
  ): Promise<CopyDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const book = await client.book.findUnique({
      where: { id: bookId },
      select: { id: true, archivedAt: true },
    });
    if (!book) throw new NotFoundException('Book not found.');
    if (book.archivedAt) {
      throw new BadRequestException("Can't add copies to an archived book — restore it first.");
    }

    const defs = await this.fieldDefs.loadActiveForValidation(tenant, 'book_copy');
    const cleanedCustom = validateRecordOrThrow(defs, input.customFields ?? {}, {
      unknownFields: 'reject',
    });

    try {
      const created = await client.bookCopy.create({
        data: {
          bookId,
          barcode: input.barcode,
          shelfLocation: input.shelfLocation ?? null,
          conditionNotes: input.conditionNotes ?? null,
          acquiredAt: input.acquiredAt ? new Date(input.acquiredAt) : null,
          priceCents: input.priceCents ?? null,
          customFields: cleanedCustom as Prisma.InputJsonValue,
        },
      });
      return this.toDto(created);
    } catch (err) {
      throw this.translateDbError(err);
    }
  }

  async update(
    tenant: TenantContext,
    id: string,
    input: {
      barcode?: string;
      status?: BookCopyStatus;
      shelfLocation?: string | null;
      conditionNotes?: string | null;
      acquiredAt?: string | null;
      priceCents?: number | null;
      customFields?: Record<string, unknown>;
      archived?: boolean;
    },
  ): Promise<CopyDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.bookCopy.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Copy not found.');

    if (input.status && input.status !== existing.status) {
      const allowed = ALLOWED_TRANSITIONS[existing.status];
      if (!allowed.includes(input.status)) {
        throw new BadRequestException(
          existing.status === 'on_loan'
            ? 'This copy is currently checked out — return it through Loans first.'
            : input.status === 'on_loan'
              ? 'Loans are managed via the Loans area, not directly on the copy.'
              : `Can't change status from ${existing.status} → ${input.status}.`,
        );
      }
    }

    // Archiving bypasses the status-transition guard above, so block it
    // explicitly for an on-loan copy — otherwise a copy could be soft-deleted
    // while its loan stays active, leaving the loan permanently un-returnable.
    if (input.archived === true && existing.status === 'on_loan') {
      throw new BadRequestException(
        'This copy is currently checked out — return it through Loans before archiving.',
      );
    }

    let cleanedCustom: Record<string, unknown> | undefined;
    if (input.customFields !== undefined) {
      const defs = await this.fieldDefs.loadActiveForValidation(tenant, 'book_copy');
      cleanedCustom = validateRecordOrThrow(defs, input.customFields, {
        unknownFields: 'reject',
        partial: true,
      });
    }

    const data: Prisma.BookCopyUpdateInput = {};
    if (input.barcode !== undefined) data.barcode = input.barcode;
    if (input.status !== undefined) data.status = input.status;
    if (input.shelfLocation !== undefined) data.shelfLocation = input.shelfLocation;
    if (input.conditionNotes !== undefined) data.conditionNotes = input.conditionNotes;
    if (input.acquiredAt !== undefined) {
      data.acquiredAt = input.acquiredAt === null ? null : new Date(input.acquiredAt);
    }
    if (input.priceCents !== undefined) data.priceCents = input.priceCents;
    if (cleanedCustom !== undefined) {
      data.customFields = {
        ...((existing.customFields as Record<string, unknown>) ?? {}),
        ...cleanedCustom,
      } as Prisma.InputJsonValue;
    }
    if (input.archived !== undefined) {
      data.archivedAt = input.archived ? new Date() : null;
    }

    // Restoring a lost copy to available must also close the still-open lost
    // loan. The lost loan has returnedAt = NULL, so it occupies the "one active
    // loan per copy" slot — leaving it open makes the next checkout fail with a
    // P2002. (loans_status_returned_consistency forces status='returned' when
    // returnedAt is set.)
    const restoringFromLost = existing.status === 'lost' && input.status === 'available';

    try {
      if (restoringFromLost) {
        const updated = await client.$transaction(async (tx) => {
          const u = await tx.bookCopy.update({ where: { id }, data });
          await tx.loan.updateMany({
            where: { copyId: id, status: 'lost', returnedAt: null },
            data: { status: 'returned', returnedAt: new Date() },
          });
          return u;
        });
        return this.toDto(updated);
      }
      const updated = await client.bookCopy.update({ where: { id }, data });
      return this.toDto(updated);
    } catch (err) {
      throw this.translateDbError(err);
    }
  }

  async archive(tenant: TenantContext, id: string): Promise<CopyDto> {
    return this.update(tenant, id, { archived: true });
  }

  private toDto(row: {
    id: string;
    bookId: string;
    barcode: string;
    status: BookCopyStatus;
    shelfLocation: string | null;
    conditionNotes: string | null;
    acquiredAt: Date | null;
    priceCents: number | null;
    customFields: unknown;
    createdAt: Date;
    updatedAt: Date;
    archivedAt: Date | null;
  }): CopyDto {
    return {
      id: row.id,
      bookId: row.bookId,
      barcode: row.barcode,
      status: row.status,
      shelfLocation: row.shelfLocation,
      conditionNotes: row.conditionNotes,
      acquiredAt: row.acquiredAt,
      priceCents: row.priceCents,
      customFields: (row.customFields as Record<string, unknown>) ?? {},
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
    };
  }

  private translateDbError(err: unknown): Error {
    if (typeof err === 'object' && err !== null && 'code' in err) {
      const code = (err as { code: string }).code;
      if (code === 'P2002') {
        return new ConflictException(
          'Another copy with this barcode already exists. Archive the old one first if you want to re-use the barcode.',
        );
      }
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
