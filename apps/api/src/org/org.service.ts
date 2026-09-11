import { Inject, Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/**
 * Branches and shelving locations, for everything that has to name one
 * (2.0 phase 20a).
 *
 * ## Why these are not paginated
 *
 * Every other list in this phase is keyset-paginated because it is over a table
 * that grows with the collection or the membership. These two are not: a branch
 * is a building and a shelving location is a run of shelving inside one. A large
 * Greek municipal service has perhaps a dozen of the first and a few dozen of the
 * second, and a consortium is modelled as separate tenants, not as ten thousand
 * branches.
 *
 * So they are returned whole, ordered, and that is the honest shape — a cursor on
 * a list that fits on one screen is ceremony, and worse, it invites a caller to
 * page a dropdown. The ordering is `(sort_order, code)`: `sort_order` is the
 * librarian's own arrangement, and `code` breaks the tie so the order is TOTAL.
 * Without that tiebreak two branches sharing a sort order come back in whatever
 * sequence the heap hands over, which is stable right up until a row is updated
 * and then silently is not — a dropdown that reorders itself between page loads.
 *
 * ## Archived rows
 *
 * Excluded by default, included on request. A branch that closed last year still
 * owns items and appears on old loans, so a staff screen filtering by branch has
 * to be able to ask for it; a "where should this go?" dropdown must not offer it.
 * Those are different questions and the caller says which one it is asking.
 */
export type BranchRow = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly nameI18n: unknown;
  readonly kind: string;
  readonly parentBranchId: string | null;
  readonly depth: number;
  /** IANA. The circ-5 fix: every due-date computation resolves through this. */
  readonly timezone: string;
  readonly currency: string;
  readonly circulates: boolean;
  readonly pickupLocation: boolean;
  readonly opacVisible: boolean;
  readonly staffOnly: boolean;
  readonly sortOrder: number;
  readonly archivedAt: Date | null;
};

export type ShelvingLocationRow = {
  readonly id: string;
  readonly branchId: string;
  readonly code: string;
  readonly name: string;
  readonly nameI18n: unknown;
  readonly opacName: string | null;
  readonly browsable: boolean;
  readonly opacVisible: boolean;
  readonly sortOrder: number;
  readonly archivedAt: Date | null;
};

@Injectable()
export class OrgService {
  constructor(@Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService) {}

  async branches(
    tenant: TenantContext,
    opts: { includeArchived?: boolean } = {},
  ): Promise<{ items: BranchRow[] }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const rows = await client.branch.findMany({
      where: opts.includeArchived === true ? {} : { archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      // Explicit, and short on purpose. The address, the geo point, the ISIL,
      // the settings blob and the custom fields all belong to the branch EDITOR,
      // which is a different screen from every caller of this one — a filter
      // dropdown, a pickup-branch picker, a transfer destination.
      select: {
        id: true,
        code: true,
        name: true,
        nameI18n: true,
        kind: true,
        parentBranchId: true,
        depth: true,
        timezone: true,
        currency: true,
        circulates: true,
        pickupLocation: true,
        opacVisible: true,
        staffOnly: true,
        sortOrder: true,
        archivedAt: true,
      },
    });
    return {
      items: rows.map((r) => ({ ...r, kind: String(r.kind), currency: r.currency.trim() })),
    };
  }

  async locations(
    tenant: TenantContext,
    opts: { branchId?: string; includeArchived?: boolean } = {},
  ): Promise<{ items: ShelvingLocationRow[] }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const rows = await client.shelvingLocation.findMany({
      where: {
        ...(opts.includeArchived === true ? {} : { archivedAt: null }),
        ...(opts.branchId !== undefined ? { branchId: opts.branchId } : {}),
      },
      // Branch first: a location code is unique within its branch, not across
      // the service, so "GEN" at the main library and "GEN" at the annexe are
      // two different shelves and must not interleave.
      orderBy: [{ branchId: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }],
      select: {
        id: true,
        branchId: true,
        code: true,
        name: true,
        nameI18n: true,
        opacName: true,
        browsable: true,
        opacVisible: true,
        sortOrder: true,
        archivedAt: true,
      },
    });
    return { items: rows };
  }
}
