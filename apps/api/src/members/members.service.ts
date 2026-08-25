import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { MemberStatus, Prisma } from '@libriant/db-tenant';
import { controlDb } from '@libriant/db-control';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { FieldDefinitionsService } from '../customization/field-definitions.service.js';
import { QuotaService } from '../customization/quota.service.js';
import { validateRecordOrThrow } from '../customization/dynamic-validator.js';
import { buildSearchText, normalizeText } from '../catalog/normalize.js';
import { StorageService } from '../storage/storage.service.js';
import { buildMemberNumber, nextSequenceForYear } from './member-numbers.js';

export type MemberDto = {
  id: string;
  memberNumber: string;
  fullName: string;
  sortName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: Date | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  photoAssetRef: string | null;
  status: MemberStatus;
  staffNotes: string | null;
  joinedAt: Date;
  customFields: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  /** Non-NULL once {@link MembersService.erase} has tombstoned this row. */
  erasedAt: Date | null;
};

export type MemberWithCirculationDto = MemberDto & {
  circulation: {
    activeLoans: number;
    activeReservations: number;
    outstandingFinesCents: number;
    /**
     * How many separate outstanding fines make up that total.
     *
     * The amount alone cannot answer "is there anything to settle?" — €0.00
     * across two fines and no fines at all are the same number — and the desk
     * needs to know whether to offer a settle action at all. Both move the
     * moment a fine is paid or waived through `/t/:slug/fines/:id/*`; they are
     * aggregated live, never cached.
     */
    outstandingFinesCount: number;
  };
};

export type ListMembersOptions = {
  q?: string;
  status?: MemberStatus;
  after?: string;
  limit?: number;
  includeArchived?: boolean;
};

// ---------------------------------------------------------------------------
// Erasure (GDPR Art. 17) — privacy-legal-03
// ---------------------------------------------------------------------------

/**
 * What every free-text identifier on an erased member (and on the circulation
 * rows that outlive them) is overwritten with.
 *
 * Deliberately ONE locale-neutral token rather than «Διαγραμμένο μέλος» /
 * "Erased member": this layer has no locale, the row is read by both the Greek
 * and the English UI and by CSV exports, and a tombstone that reads like a name
 * is one export away from being mistaken for a real member. The web layer maps
 * this sentinel onto a localized label.
 */
export const ERASED_TOMBSTONE = '[erased]';

/**
 * The tombstoned membership number.
 *
 * The number is NOT left intact. It is a pseudonym, and a pseudonym that still
 * matches the library's paper card file re-identifies the person the moment
 * anyone looks the card up — which is exactly what Art. 17 forbids. Deriving it
 * from the row id makes a re-run of `erase()` compute the same value, which is
 * part of what lets the whole operation be safely repeated.
 *
 * SHAPE IS NOT COSMETIC. `members_member_number_format` (the init migration)
 * is `CHECK ("memberNumber" ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$')`, so the obvious
 * `ERASED-<cuid>` is rejected twice over — a cuid is lowercase, and 7 + 25
 * characters is past the 30-character ceiling. The first run of this code
 * against a real tenant database 500'd on exactly that (SQLSTATE 23514), with
 * the patron's row left fully intact. Hence: uppercase, alphanumerics only, and
 * the last 16 characters of the id, which is 23 characters in total.
 *
 * Collisions are not a correctness problem: the only unique index on the column
 * is `members_member_number_unique_active`, which is PARTIAL (non-archived rows
 * only), and an erased member is always archived.
 */
export const ERASED_MEMBER_NUMBER_PREFIX = 'ERASED-';

export function erasedMemberNumber(id: string): string {
  const suffix = id
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(-16);
  return `${ERASED_MEMBER_NUMBER_PREFIX}${suffix || '0'}`;
}

/** Replacement payload for the audit rows that used to hold identifiers. */
const AUDIT_REDACTION = JSON.stringify({ redacted: 'member.erased' });

/**
 * What an erasure actually did. Returned to the caller and worth keeping: a
 * librarian answering an Art. 12(3) request needs to be able to say what was
 * removed and what was kept, and "it said 200 OK" is not that.
 */
export type MemberErasureReceipt = {
  memberId: string;
  erasedAt: Date;
  /** True when the row was ALREADY erased and this call only re-swept. */
  alreadyErased: boolean;
  /**
   * Rows that deliberately survive, stripped of free text and now pointing at
   * a non-identifying stub. See the long comment on `erase()`.
   */
  kept: { loans: number; reservations: number; fines: number };
  /** Identifiers removed elsewhere by this call. */
  cleared: { auditEntries: number; outboxMessages: number; photo: boolean };
};

@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(FieldDefinitionsService) private readonly fieldDefs: FieldDefinitionsService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
    // Erasure has to delete the member's PHOTO, which is a face and lives on
    // the storage volume rather than in the database — see `erase()`.
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  /** Small JSON-safe snapshot of a member for audit before/after diffs. */
  private memberSnapshot(m: {
    memberNumber: string;
    fullName: string;
    status: MemberStatus;
    email: string | null;
    archivedAt: Date | null;
  }): Record<string, unknown> {
    return {
      memberNumber: m.memberNumber,
      fullName: m.fullName,
      status: m.status,
      email: m.email,
      archivedAt: m.archivedAt ? m.archivedAt.toISOString() : null,
    };
  }

  /** Audit a freshly-created member, then return its DTO (single create exit). */
  private async auditCreated(
    tenant: TenantContext,
    actor: TenantActor,
    created: Parameters<MembersService['toDto']>[0],
  ): Promise<MemberDto> {
    await this.audit.record(tenant, actor, {
      action: 'member.created',
      targetType: 'member',
      targetId: created.id,
      after: this.memberSnapshot(created),
    });
    return this.toDto(created);
  }

  async list(
    tenant: TenantContext,
    opts: ListMembersOptions = {},
  ): Promise<{ items: MemberDto[]; nextCursor: string | null }> {
    const client = this.tenantPrisma.getClient(tenant);
    const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
    const where: Prisma.MemberWhereInput = {};
    if (!opts.includeArchived) where.archivedAt = null;
    if (opts.status) where.status = opts.status;
    if (opts.q) where.searchText = { contains: normalizeText(opts.q) };

    const rows = await client.member.findMany({
      where,
      orderBy: [{ sortName: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(opts.after ? { cursor: { id: opts.after }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => this.toDto(r));
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  }

  /**
   * Resolve a scanned/typed membership number → the member. Member numbers are
   * unique among non-archived members, so this matches at most one. Drives
   * scan-to-checkout (search by `q` doesn't cover the number). 404 when nothing
   * matches; the caller surfaces a friendly "not found".
   */
  async getByMemberNumber(tenant: TenantContext, memberNumber: string): Promise<MemberDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const row = await client.member.findFirst({ where: { memberNumber, archivedAt: null } });
    if (!row) throw new NotFoundException('No member with that number.');
    return this.toDto(row);
  }

  async get(tenant: TenantContext, id: string): Promise<MemberWithCirculationDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const row = await client.member.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Member not found.');
    const [activeLoans, activeReservations, outstanding] = await Promise.all([
      // "Active" = the copy is physically still with the member. Lost loans
      // also have `returnedAt IS NULL` but they're closed business — the
      // copy is gone, the fine is tracked separately, and they shouldn't
      // block archive.
      client.loan.count({ where: { memberId: id, status: 'active' } }),
      client.reservation.count({
        where: { memberId: id, status: { in: ['queued', 'ready'] } },
      }),
      client.fine.aggregate({
        where: { memberId: id, status: 'outstanding' },
        _sum: { amountCents: true },
        _count: true,
      }),
    ]);
    return {
      ...this.toDto(row),
      circulation: {
        activeLoans,
        activeReservations,
        outstandingFinesCents: outstanding._sum.amountCents ?? 0,
        outstandingFinesCount: outstanding._count,
      },
    };
  }

  async create(
    tenant: TenantContext,
    input: {
      memberNumber?: string;
      fullName: string;
      sortName?: string;
      email?: string;
      phone?: string;
      dateOfBirth?: string;
      addressLine1?: string;
      addressLine2?: string;
      city?: string;
      postalCode?: string;
      country?: string;
      staffNotes?: string;
      customFields?: Record<string, unknown>;
    },
    actor: TenantActor,
  ): Promise<MemberDto> {
    // 1. Custom fields validation.
    const defs = await this.fieldDefs.loadActiveForValidation(tenant, 'member');
    const cleanedCustom = validateRecordOrThrow(defs, input.customFields ?? {}, {
      unknownFields: 'reject',
    });

    // 2. Compute sortName + searchText.
    const sortName = input.sortName ? normalizeText(input.sortName) : normalizeText(input.fullName);
    const searchText = buildSearchText([
      input.fullName,
      sortName,
      input.email,
      input.phone,
      input.city,
    ]);

    // 3. Decide on memberNumber. If supplied, use it (uniqueness check via
    //    DB partial unique index). Otherwise auto-generate, retrying on
    //    races for up to 3 attempts.
    const client = this.tenantPrisma.getClient(tenant);
    const year = new Date().getUTCFullYear();
    const baseData = {
      fullName: input.fullName,
      sortName,
      searchText,
      email: input.email ?? null,
      phone: input.phone ?? null,
      dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city ?? null,
      postalCode: input.postalCode ?? null,
      country: input.country ?? null,
      staffNotes: input.staffNotes ?? null,
      customFields: cleanedCustom as Prisma.InputJsonValue,
    } as const;

    // Enforce `max_members` and insert in ONE transaction, serialized by a
    // per-tenant advisory lock, so parallel creates can't both pass the quota
    // check and push the tenant past its plan ceiling. The lock also
    // serializes member-number assignment, but the retry loop stays as a
    // belt-and-braces guard against any residual sequence race.
    const createWithQuota = (memberNumber: string) =>
      client.$transaction(async (tx) => {
        await this.quota.enforceWithinTx(tx, {
          tenantId: tenant.id,
          featureKey: 'max_members',
          count: () =>
            tx.member.count({ where: { archivedAt: null, status: { not: 'archived' } } }),
        });
        return tx.member.create({ data: { ...baseData, memberNumber } });
      });

    if (input.memberNumber) {
      try {
        const created = await createWithQuota(input.memberNumber);
        return this.auditCreated(tenant, actor, created);
      } catch (err) {
        throw this.translateCreateError(err);
      }
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const seq = await nextSequenceForYear(client, year);
      const memberNumber = buildMemberNumber(year, seq);
      try {
        const created = await createWithQuota(memberNumber);
        return this.auditCreated(tenant, actor, created);
      } catch (err) {
        lastErr = err;
        if (!this.isUniqueViolation(err)) {
          throw this.translateCreateError(err);
        }
        this.logger.debug(
          `Member-number race on ${memberNumber} (attempt ${attempt + 1}); retrying.`,
        );
      }
    }
    throw this.translateCreateError(lastErr ?? new Error('Member-number generation gave up.'));
  }

  async update(
    tenant: TenantContext,
    id: string,
    input: {
      memberNumber?: string;
      fullName?: string;
      sortName?: string;
      email?: string | null;
      phone?: string | null;
      dateOfBirth?: string | null;
      addressLine1?: string | null;
      addressLine2?: string | null;
      city?: string | null;
      postalCode?: string | null;
      country?: string | null;
      staffNotes?: string | null;
      customFields?: Record<string, unknown>;
      archived?: boolean;
    },
    actor: TenantActor,
  ): Promise<MemberDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.member.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Member not found.');

    let cleanedCustom: Record<string, unknown> | undefined;
    if (input.customFields !== undefined) {
      const defs = await this.fieldDefs.loadActiveForValidation(tenant, 'member');
      cleanedCustom = validateRecordOrThrow(defs, input.customFields, {
        unknownFields: 'reject',
        partial: true,
      });
    }

    // Recompute sortName + searchText if any contributing field changed.
    const fullNameAfter = input.fullName ?? existing.fullName;
    const sortNameAfter =
      input.sortName !== undefined
        ? normalizeText(input.sortName)
        : input.fullName !== undefined
          ? normalizeText(input.fullName)
          : existing.sortName;
    const emailAfter = input.email === undefined ? existing.email : input.email;
    const phoneAfter = input.phone === undefined ? existing.phone : input.phone;
    const cityAfter = input.city === undefined ? existing.city : input.city;
    const searchText = buildSearchText([
      fullNameAfter,
      sortNameAfter,
      emailAfter,
      phoneAfter,
      cityAfter,
    ]);

    const data: Prisma.MemberUpdateInput = { sortName: sortNameAfter, searchText };
    if (input.memberNumber !== undefined) data.memberNumber = input.memberNumber;
    if (input.fullName !== undefined) data.fullName = input.fullName;
    if (input.email !== undefined) data.email = input.email;
    if (input.phone !== undefined) data.phone = input.phone;
    if (input.dateOfBirth !== undefined) {
      data.dateOfBirth = input.dateOfBirth === null ? null : new Date(input.dateOfBirth);
    }
    if (input.addressLine1 !== undefined) data.addressLine1 = input.addressLine1;
    if (input.addressLine2 !== undefined) data.addressLine2 = input.addressLine2;
    if (input.city !== undefined) data.city = input.city;
    if (input.postalCode !== undefined) data.postalCode = input.postalCode;
    if (input.country !== undefined) data.country = input.country;
    if (input.staffNotes !== undefined) data.staffNotes = input.staffNotes;
    if (cleanedCustom !== undefined) {
      data.customFields = {
        ...((existing.customFields as Record<string, unknown>) ?? {}),
        ...cleanedCustom,
      } as Prisma.InputJsonValue;
    }
    let restoring = false;
    if (input.archived !== undefined) {
      if (input.archived) {
        // Restore-only via this flag (legacy path); the dedicated archive()
        // method runs the active-loans safety check before archiving.
        throw new BadRequestException(
          'Use DELETE /members/:id to archive (we check for active loans first). PATCH archived=true is reserved for restoring.',
        );
      }
      // archived: false → restore
      if (existing.archivedAt) {
        data.archivedAt = null;
        data.status = 'active';
        restoring = true;
      }
    }

    try {
      const updated = restoring
        ? await client.$transaction(async (tx) => {
            // Un-archiving consumes a max_members seat exactly like a create —
            // enforce it so archive → create → un-archive isn't a free bypass.
            await this.quota.enforceWithinTx(tx, {
              tenantId: tenant.id,
              featureKey: 'max_members',
              count: () =>
                tx.member.count({ where: { archivedAt: null, status: { not: 'archived' } } }),
            });
            return tx.member.update({ where: { id }, data });
          })
        : await client.member.update({ where: { id }, data });
      await this.audit.record(tenant, actor, {
        action: 'member.updated',
        targetType: 'member',
        targetId: id,
        before: this.memberSnapshot(existing),
        after: this.memberSnapshot(updated),
      });
      return this.toDto(updated);
    } catch (err) {
      throw this.translateCreateError(err);
    }
  }

  /**
   * Set status to `active` or `suspended`. Archiving lives on the
   * dedicated `archive()` path so we can run the loans safety check.
   * Refuses `archived` here; clients must use DELETE.
   */
  async setStatus(
    tenant: TenantContext,
    id: string,
    input: { status: 'active' | 'suspended'; reason?: string },
    actor: TenantActor,
  ): Promise<MemberDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.member.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Member not found.');
    if (existing.archivedAt) {
      throw new BadRequestException(
        'This member is archived. Restore them first (PATCH archived=false).',
      );
    }
    const noteAddition =
      input.reason && input.reason.trim().length
        ? `\n[${new Date().toISOString()}] status → ${input.status}: ${input.reason.trim()}`
        : '';
    const updated = await client.member.update({
      where: { id },
      data: {
        status: input.status,
        staffNotes: noteAddition ? (existing.staffNotes ?? '') + noteAddition : undefined,
      },
    });
    await this.audit.record(tenant, actor, {
      action: 'member.status_changed',
      targetType: 'member',
      targetId: id,
      before: { status: existing.status },
      after: { status: updated.status, reason: input.reason?.trim() || null },
    });
    return this.toDto(updated);
  }

  /**
   * Archive a member. Refuses when there are open loans or active
   * reservations: the librarian must close them first. Outstanding fines
   * are flagged but do not block archive — collecting them is a separate
   * back-office flow.
   */
  async archive(tenant: TenantContext, id: string, actor: TenantActor): Promise<MemberDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.member.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Member not found.');
    if (existing.archivedAt) {
      return this.toDto(existing);
    }

    // members-1: do the open-business check and the archive write in ONE
    // transaction, serialized with the checkout path by a member-scoped
    // advisory lock, so a loan can't be created between the check and the
    // archive (which would leave an archived member holding an active loan).
    const updated = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`member:${id}`}, 0))`;
      const activeLoans = await tx.loan.count({ where: { memberId: id, status: 'active' } });
      const activeReservations = await tx.reservation.count({
        where: { memberId: id, status: { in: ['queued', 'ready'] } },
      });
      if (activeLoans > 0 || activeReservations > 0) {
        throw new BadRequestException({
          statusCode: 400,
          message: `Can't archive a member with open business. Resolve these first.`,
          activeLoans,
          activeReservations,
        });
      }
      return tx.member.update({
        where: { id },
        data: { archivedAt: new Date(), status: 'archived' },
      });
    });
    await this.audit.record(tenant, actor, {
      action: 'member.archived',
      targetType: 'member',
      targetId: id,
      before: this.memberSnapshot(existing),
      after: this.memberSnapshot(updated),
    });
    return this.toDto(updated);
  }

  /**
   * GDPR Art. 17 erasure — the real one. **Irreversible.**
   *
   * privacy-legal-03: `DELETE /members/:id` archives, and archiving keeps every
   * single column — name, e-mail, date of birth, home address, photo, staff
   * notes, custom fields. The DPA promises the library "tools to … delete
   * Controller Personal Data directly", so a Greek library receiving an Art. 17
   * request from a patron (or a parent acting for a child) had nothing to use.
   * The verifier's repro was exactly that: create a member with name/e-mail/DoB/
   * address, call DELETE, read all four back intact.
   *
   * WHAT IS DESTROYED
   *   - Every direct identifier on the member row: memberNumber, fullName,
   *     sortName, searchText, email, phone, dateOfBirth, addressLine1/2, city,
   *     postalCode, country, staffNotes, customFields, photoAssetRef.
   *   - The photo FILE on the storage volume, not just the reference to it.
   *   - The free text on the circulation rows that survive: `notes` and
   *     `customFields` on every Loan / Reservation / Fine, and `Fine.reason`.
   *     Erased in one table and intact in another is not erased, and a librarian
   *     absolutely does type "phoned Maria's mother" into a loan note.
   *   - The identifier payloads in the tenant audit_log. `memberSnapshot()`
   *     writes `{memberNumber, fullName, status, email, archivedAt}` into
   *     beforeJson/afterJson on every create/update/archive, so erasing only the
   *     live row leaves a full name and e-mail in the history.
   *   - Control-plane `email_outbox` rows addressed to them: a member notice is
   *     the patron's address plus the title of the book they borrowed, and it
   *     sits in the SHARED control plane.
   *
   * WHAT DELIBERATELY SURVIVES, AND WHY
   *   - The member ROW itself, as a non-identifying stub. Loan, Reservation and
   *     Fine all have `onDelete: Restrict` FKs to it; a hard DELETE would either
   *     be refused by Postgres or take the library's whole circulation history
   *     with it. The stub keeps those FKs resolvable and identifies nobody: a
   *     cuid, a tombstone number and no attributes.
   *   - Loan history (dates, copy, staff who handled it) — the library's own
   *     record of who had which book is what an inventory audit runs on, and it
   *     no longer points at a person.
   *   - Fines as FINANCIAL facts: amount, currency, status, timestamps and the
   *     loan link. Those have an independent legal basis (Art. 17(3)(b) —
   *     accounting/tax) that erasure does not override. Their free-text
   *     `reason` does NOT have that basis and is redacted with the rest.
   *   - Row timestamps (createdAt/joinedAt). The surviving loans carry dates
   *     anyway, and on their own they identify nobody.
   *   - One audit row, `member.erased`, holding only the target id and the
   *     timestamp. That is the accountability record (Art. 5(2)) proving the
   *     right was exercised; it carries no identifier, and a re-run does not
   *     redact it.
   *
   * REFUSES while there is open business — an active loan, a queued/ready hold,
   * or an outstanding fine. You cannot forget who has your book, and writing off
   * money owed has to be a decision someone makes, not a side effect of a
   * privacy request. The message names the counts so the librarian knows what to
   * clear first.
   *
   * SAFE TO REPEAT. Every step is idempotent and the whole thing is ordered so a
   * crash leaves work that a retry finishes: the outbox purge and the photo
   * delete happen BEFORE the row is tombstoned, because both are keyed on data
   * (the e-mail address, the asset ref) that the tombstone destroys — do them
   * after and a failed step can never be retried. Calling `erase()` again on an
   * already-erased member re-runs the sweeps and reports `alreadyErased`.
   *
   * The price of that ordering, stated plainly: if the transaction then fails —
   * a loan checked out in the microsecond before the lock, a database blip —
   * the patron's queued notices have already been deleted while their record is
   * still intact. That is the harmless direction (the hourly notification sweep
   * re-enqueues anything still due) and the other order is not: a member erased
   * with their e-mail still sitting in the shared control plane.
   */
  async erase(
    tenant: TenantContext,
    id: string,
    actor: TenantActor,
  ): Promise<MemberErasureReceipt> {
    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.member.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Member not found.');
    const alreadyErased = existing.erasedAt !== null;

    // Cheap pre-check before we start destroying things that live outside the
    // transaction (the photo file, the outbox rows). The authoritative check
    // runs again inside the transaction under the advisory lock below — this
    // one only stops us mangling a member we are about to refuse.
    if (!alreadyErased) await this.assertNoOpenBusiness(client, id);

    // 1. Control plane first. `toEmail` is the only handle we have on these
    //    rows and the tombstone erases it, so this cannot move after step 3.
    //    Delete rather than redact: they are transient notices to a person who
    //    has just asked to be forgotten, and a pending one must not go out.
    //    (A pending notice for a DIFFERENT member who shares the address is
    //    re-enqueued by the hourly sweep — the outbox is keyed on an
    //    idempotency key that no longer has a row.)
    let outboxMessages = 0;
    if (existing.email) {
      const purged = await controlDb.emailOutbox.deleteMany({
        where: { tenantId: tenant.id, toEmail: existing.email },
      });
      outboxMessages = purged.count;
    }

    // 2. The photo, before the ref is nulled — same reasoning. NOT swallowed:
    //    a face left on the volume is the worst residue of the lot, so a
    //    storage failure aborts the erasure with the row still intact and
    //    retryable, rather than reporting success over a file that is still
    //    there. `StorageService.delete` already tolerates a missing object.
    let photo = false;
    if (existing.photoAssetRef && !existing.photoAssetRef.startsWith('photos/placeholder')) {
      try {
        await this.storage.delete(tenant, existing.photoAssetRef);
        photo = true;
      } catch (err) {
        this.logger.error(
          `erase aborted for member ${id}: could not delete photo ${existing.photoAssetRef}: ${(err as Error).message}`,
        );
        throw new ServiceUnavailableException(
          'Could not delete this member’s photo from storage, so nothing was erased. Try again in a moment.',
        );
      }
    }

    // 3. The database half, in ONE transaction so no reader ever sees a member
    //    that is half-erased.
    const erasedAt = existing.erasedAt ?? new Date();
    const tombstone: Prisma.MemberUpdateInput = {
      memberNumber: erasedMemberNumber(id),
      fullName: ERASED_TOMBSTONE,
      sortName: ERASED_TOMBSTONE,
      // Empty, not the tombstone: a search for "erased" must not list every
      // erased member as if it were a name.
      searchText: '',
      email: null,
      phone: null,
      dateOfBirth: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      postalCode: null,
      country: null,
      photoAssetRef: null,
      staffNotes: null,
      customFields: {} as Prisma.InputJsonValue,
      status: 'archived',
      archivedAt: existing.archivedAt ?? erasedAt,
      erasedAt,
    };

    const counts = await client.$transaction(async (tx) => {
      // Same lock the archive path takes: without it a checkout committed
      // between the check and the write would leave an active loan hanging off
      // an erased member.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`member:${id}`}, 0))`;
      if (!alreadyErased) await this.assertNoOpenBusiness(tx, id);

      const loans = await tx.loan.updateMany({
        where: { memberId: id },
        data: { notes: null, customFields: {} as Prisma.InputJsonValue },
      });
      const reservations = await tx.reservation.updateMany({
        where: { memberId: id },
        data: { notes: null, customFields: {} as Prisma.InputJsonValue },
      });
      const fines = await tx.fine.updateMany({
        where: { memberId: id },
        data: {
          notes: null,
          // `reason` is free text ("Lost book replacement", but also whatever
          // an import mapped into it). The FINANCIAL record — amount, currency,
          // status, dates, loan link — is what the legal basis covers, not the
          // prose.
          reason: ERASED_TOMBSTONE,
          customFields: {} as Prisma.InputJsonValue,
        },
      });
      await tx.member.update({ where: { id }, data: tombstone });
      const auditEntries = await this.redactAuditTrail(tx, id, existing.email);
      return {
        loans: loans.count,
        reservations: reservations.count,
        fines: fines.count,
        auditEntries,
      };
    });

    // 4. The accountability record, written after the redaction so it is not
    //    itself redacted, and carrying NO identifier — only the fact and the
    //    time, which is all Art. 5(2) needs and all Art. 17 permits.
    //
    //    Skipped when this call was a re-sweep that found nothing left to
    //    clear: a librarian clicking twice, or a retry after a network drop,
    //    should not grow a pile of identical "erased" rows. A re-sweep that DID
    //    clear something (a notice that landed in the outbox after the first
    //    call) is a real event and is recorded.
    const clearedSomething = counts.auditEntries > 0 || outboxMessages > 0 || photo;
    if (!alreadyErased || clearedSomething) {
      await this.audit.record(tenant, actor, {
        action: 'member.erased',
        targetType: 'member',
        targetId: id,
        after: {
          erasedAt: erasedAt.toISOString(),
          loansKept: counts.loans,
          reservationsKept: counts.reservations,
          finesKept: counts.fines,
          ...(alreadyErased ? { resweep: true } : {}),
        },
      });
    }

    this.logger.log(
      `member ${id} erased in tenant ${tenant.slug}: kept ${counts.loans} loan(s), ` +
        `${counts.reservations} reservation(s), ${counts.fines} fine(s); ` +
        `redacted ${counts.auditEntries} audit row(s), ${outboxMessages} outbox row(s)`,
    );

    return {
      memberId: id,
      erasedAt,
      alreadyErased,
      kept: { loans: counts.loans, reservations: counts.reservations, fines: counts.fines },
      cleared: { auditEntries: counts.auditEntries, outboxMessages, photo },
    };
  }

  // -------- internals -----------------------------------------------------

  /**
   * Refuse to erase (or archive-then-erase) a member with open business.
   * Takes any client — the caller runs it once cheaply and once inside the
   * transaction, where the advisory lock makes the answer actually hold.
   */
  private async assertNoOpenBusiness(
    client: Pick<Prisma.TransactionClient, 'loan' | 'reservation' | 'fine'>,
    id: string,
  ): Promise<void> {
    const [activeLoans, activeReservations, fines] = await Promise.all([
      client.loan.count({ where: { memberId: id, status: 'active' } }),
      client.reservation.count({ where: { memberId: id, status: { in: ['queued', 'ready'] } } }),
      client.fine.aggregate({
        where: { memberId: id, status: 'outstanding' },
        _sum: { amountCents: true },
        _count: true,
      }),
    ]);
    const outstandingFines = fines._count;
    if (activeLoans > 0 || activeReservations > 0 || outstandingFines > 0) {
      throw new BadRequestException({
        statusCode: 400,
        message:
          "Can't erase a member with open business. Return the loans, cancel the holds and " +
          'settle or waive the fines first — erasure is irreversible.',
        activeLoans,
        activeReservations,
        outstandingFines,
        // The amount, not just the count: "1 outstanding fine" is the same
        // sentence for €0.20 and €200, and the two call for very different
        // conversations with the person asking to be forgotten. Whoever has to
        // decide between chasing the debt and writing it off needs the figure
        // in front of them, and the refusal is the only place it appears.
        outstandingFinesCents: fines._sum.amountCents ?? 0,
      });
    }
  }

  /**
   * Strip the identifier payloads out of this member's tenant audit trail,
   * keeping the rows themselves (who did what, when) so the library's audit
   * history stays continuous.
   *
   * Three passes, and the second is why this is raw SQL: the member-targeted
   * rows are found by (targetType, targetId), but any row whose JSON happens to
   * contain the e-mail address is also about this person, and Prisma cannot
   * express a substring match against a JSONB column's text form. The e-mail
   * needle is only ever applied when there IS one — `position('' in x)` returns
   * 1, so an empty needle would match and redact the ENTIRE audit log.
   *
   * The third pass is the member's FINES. `fine.paid` / `fine.waived` /
   * `fine.voided` rows are targeted at the fine, not at the member, so neither
   * of the first two passes reaches them — and a waiver carries the librarian's
   * own sentence about why ("her card was stolen in March"). That is free text
   * about a named individual sitting in a table erasure has just swept, and it
   * is precisely the kind of residue Art. 17 is about. The financial facts are
   * untouched: the fine rows keep amount, currency, status and dates, which is
   * what the Art. 17(3)(b) accounting basis actually covers.
   *
   * `member.erased` is excluded from every pass: it is the record that the
   * erasure happened, and a second call to `erase()` must not wipe it.
   *
   * Every pass skips rows that are ALREADY redacted. Not an optimisation: the
   * returned count feeds `clearedSomething` in `erase()`, so counting a re-swept
   * row would make every repeat call look like it did work and grow a fresh
   * `member.erased` audit row each time it ran.
   */
  private async redactAuditTrail(
    tx: Prisma.TransactionClient,
    id: string,
    email: string | null,
  ): Promise<number> {
    let redacted = await tx.$executeRaw`
      UPDATE "audit_log"
         SET "beforeJson" = CASE WHEN "beforeJson" IS NULL THEN NULL ELSE ${AUDIT_REDACTION}::jsonb END,
             "afterJson"  = CASE WHEN "afterJson"  IS NULL THEN NULL ELSE ${AUDIT_REDACTION}::jsonb END
       WHERE "targetType" = 'member'
         AND "targetId" = ${id}
         AND "action" <> 'member.erased'
         AND (("beforeJson" IS NOT NULL AND "beforeJson" <> ${AUDIT_REDACTION}::jsonb)
           OR ("afterJson"  IS NOT NULL AND "afterJson"  <> ${AUDIT_REDACTION}::jsonb))`;
    if (email && email.length > 0) {
      redacted += await tx.$executeRaw`
        UPDATE "audit_log"
           SET "beforeJson" = CASE WHEN "beforeJson" IS NULL THEN NULL ELSE ${AUDIT_REDACTION}::jsonb END,
               "afterJson"  = CASE WHEN "afterJson"  IS NULL THEN NULL ELSE ${AUDIT_REDACTION}::jsonb END
         WHERE "action" <> 'member.erased'
           AND (position(lower(${email}) in lower(COALESCE("beforeJson"::text, ''))) > 0
             OR position(lower(${email}) in lower(COALESCE("afterJson"::text, ''))) > 0)`;
    }
    redacted += await tx.$executeRaw`
      UPDATE "audit_log"
         SET "beforeJson" = CASE WHEN "beforeJson" IS NULL THEN NULL ELSE ${AUDIT_REDACTION}::jsonb END,
             "afterJson"  = CASE WHEN "afterJson"  IS NULL THEN NULL ELSE ${AUDIT_REDACTION}::jsonb END
       WHERE "targetType" = 'fine'
         AND "targetId" IN (SELECT "id" FROM "fines" WHERE "memberId" = ${id})
         AND (("beforeJson" IS NOT NULL AND "beforeJson" <> ${AUDIT_REDACTION}::jsonb)
           OR ("afterJson"  IS NOT NULL AND "afterJson"  <> ${AUDIT_REDACTION}::jsonb))`;
    return redacted;
  }

  private translateCreateError(err: unknown): Error {
    // Let deliberate HTTP errors (e.g. the 402 from the in-transaction quota
    // gate) propagate untouched.
    if (err instanceof HttpException) return err;
    if (this.isUniqueViolation(err)) {
      // CAT-005: the only unique index on members is `members_member_number_
      // unique_active` (member number, among non-archived rows). Email has a
      // plain index, never a unique one — so a dup here is always the number.
      return new ConflictException(
        'A member with this number already exists. Archive the old record first if you want to re-use the number.',
      );
    }
    if (typeof err === 'object' && err !== null) {
      const message = (err as { message?: string }).message ?? '';
      const m = message.match(/violates check constraint "([^"]+)"/);
      if (m) {
        return new BadRequestException(
          `The database rejected the value (${m[1]}). Please double-check the highlighted fields.`,
        );
      }
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  private isUniqueViolation(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const code = (err as { code?: string }).code;
    if (code === 'P2002') return true;
    const msg = (err as { message?: string }).message ?? '';
    return /duplicate key value violates unique constraint/i.test(msg);
  }

  private toDto(row: {
    id: string;
    memberNumber: string;
    fullName: string;
    sortName: string;
    email: string | null;
    phone: string | null;
    dateOfBirth: Date | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    postalCode: string | null;
    country: string | null;
    photoAssetRef: string | null;
    status: MemberStatus;
    staffNotes: string | null;
    joinedAt: Date;
    customFields: unknown;
    createdAt: Date;
    updatedAt: Date;
    archivedAt: Date | null;
    erasedAt?: Date | null;
  }): MemberDto {
    return {
      id: row.id,
      memberNumber: row.memberNumber,
      fullName: row.fullName,
      sortName: row.sortName,
      email: row.email,
      phone: row.phone,
      dateOfBirth: row.dateOfBirth,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      postalCode: row.postalCode,
      country: row.country,
      photoAssetRef: row.photoAssetRef,
      status: row.status,
      staffNotes: row.staffNotes,
      joinedAt: row.joinedAt,
      customFields: (row.customFields as Record<string, unknown>) ?? {},
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
      erasedAt: row.erasedAt ?? null,
    };
  }
}
