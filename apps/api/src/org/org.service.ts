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
/**
 * An item type, for the picker that puts a copy on a shelf (2.0 phase 20k).
 *
 * `POST /t/:slug/items` requires `itemTypeId` and nothing listed them, so
 * add-a-copy could not be repointed at all: the only known value was the seeded
 * `itype-book`, and `item-defaults.ts` is explicit that a seed is a renameable
 * row rather than a default. A library that renamed it would have had a screen
 * that could not add a copy.
 */
export type PatronCategoryRow = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly nameI18n: unknown;
  /** NULL is "no minimum", not zero. */
  readonly minAgeYears: number | null;
  readonly canBeProxy: boolean;
  readonly sortOrder: number;
  readonly archivedAt: Date | null;
};

export type ItemTypeRow = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly nameI18n: unknown;
  readonly archivedAt: Date | null;
};

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

  /**
   * The categories a patron can be enrolled under (2.0 phase 20m).
   *
   * The counterpart of {@link itemTypes}, and it exists for the same reason:
   * `POST /t/:slug/patrons` takes a `patronCategoryId` and nothing listed the
   * categories, so an enrolment form could not offer the choice and could not
   * safely assume one. `pcat-general` is what the upgrade assigns every migrated
   * member and what the defaults seed, but `item-defaults.ts` makes the same
   * point about `itype-book` that applies here: it is a renameable row, not a
   * constant, so a screen must not hard-code it.
   *
   * ORDERED BY `sort_order` FIRST, unlike the item types. A category list is
   * shown to a librarian enrolling somebody, and the order a library puts its
   * categories in — adult, child, staff, institution — is a statement about how
   * often each is chosen. `code` is the tiebreak so the order is total.
   *
   * `min_age_years` and `can_be_proxy` ride along because an enrolment form is
   * exactly where they matter: a category with a minimum age is one a form can
   * warn about before the API refuses the row.
   */
  async patronCategories(
    tenant: TenantContext,
    opts: { includeArchived?: boolean } = {},
  ): Promise<{ items: PatronCategoryRow[] }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const rows = await client.patronCategory.findMany({
      where: opts.includeArchived === true ? {} : { archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        nameI18n: true,
        minAgeYears: true,
        canBeProxy: true,
        sortOrder: true,
        archivedAt: true,
      },
    });
    return { items: rows };
  }

  /**
   * The item types a copy can be given (2.0 phase 20k).
   *
   * Short, like the two above and for the same reason: every caller is a
   * picker. The loan rules that hang off an item type belong to the rules
   * matrix editor, which is a different screen.
   */
  async itemTypes(
    tenant: TenantContext,
    opts: { includeArchived?: boolean } = {},
  ): Promise<{ items: ItemTypeRow[] }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const rows = await client.itemType.findMany({
      where: opts.includeArchived === true ? {} : { archivedAt: null },
      orderBy: [{ code: 'asc' }],
      select: { id: true, code: true, name: true, nameI18n: true, archivedAt: true },
    });
    return { items: rows };
  }
}
