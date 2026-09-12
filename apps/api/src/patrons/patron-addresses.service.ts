import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/**
 * Where a library posts a letter (2.0 phase 20b-ii).
 *
 * ## The table existed and nothing could reach it
 *
 * 1.0 carries `addressLine1`, `addressLine2`, `city`, `postalCode` and `country`
 * as five columns on `members`, and its update writes them. 2.0 moved them to
 * `patron_addresses` — with a kind, a validity range and an undeliverable
 * marker — and then built no route that reads or writes it. `deskSummary` does
 * not include it either. So a 2.0 library had nowhere to record where a reader
 * lives, and overdue notices that post a letter had nothing to post to.
 *
 * ## Every design question is answered by the schema, not by this service
 *
 * SEVERAL, not one: `patron_address_kind` is `home | postal | work | term_time |
 * other`, which is a student with a term-time address and a home one, and a
 * reader whose post goes to a PO box.
 *
 * EXACTLY ONE PRIMARY, and the model says why it is an index and not a rule
 * here: "enforced by a partial unique index rather than by the service — the
 * service is what would forget." `patron_addresses_one_primary` is
 * `UNIQUE (patron_id) WHERE is_primary`.
 *
 * That makes promoting an address a two-statement job in ONE transaction:
 * demote the incumbent, then promote. Doing it the other way round raises 23505
 * against the index, and doing it in two transactions leaves a window with no
 * primary address at all — which is the window a notice job would run in.
 *
 * `undeliverable_at` and `undeliverable_reason` are not decoration. The model
 * records that they feed `PatronBlockCode.address_unconfirmed`, "the block a
 * library needs before it posts a fourth letter to a house nobody lives in".
 * Marking an address undeliverable is therefore its own operation rather than a
 * field on a patch: it is a fact learned from a returned envelope, not an edit.
 */
export type PatronAddress = {
  readonly id: string;
  readonly patronId: string;
  readonly kind: string;
  readonly isPrimary: boolean;
  readonly line1: string | null;
  readonly line2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
  readonly undeliverableAt: Date | null;
  readonly undeliverableReason: string | null;
  readonly validFrom: Date | null;
  readonly validTo: Date | null;
};

export type AddressInput = {
  readonly kind?: string;
  readonly isPrimary?: boolean;
  readonly line1?: string | null;
  readonly line2?: string | null;
  readonly city?: string | null;
  readonly region?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string | null;
  readonly validFrom?: string | null;
  readonly validTo?: string | null;
};

/** The single capability {@link PatronAddressesService.demoteIncumbent} needs. */
type DemotesAddresses = {
  patronAddress: {
    updateMany: (args: {
      where: { patronId: string; isPrimary: boolean };
      data: { isPrimary: boolean; updatedAt: Date };
    }) => Promise<unknown>;
  };
};

@Injectable()
export class PatronAddressesService {
  constructor(@Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService) {}

  async list(tenant: TenantContext, patronId: string): Promise<{ items: PatronAddress[] }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    await this.assertPatron(tenant, patronId);
    const rows = await client.patronAddress.findMany({
      where: { patronId },
      // Primary first: it is the one a notice uses and the one a clerk reads
      // off the screen, and a list that buried it under three others would
      // invite posting to the wrong one.
      orderBy: [{ isPrimary: 'desc' }, { kind: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map((r) => this.toDto(r)) };
  }

  async create(
    tenant: TenantContext,
    patronId: string,
    input: AddressInput,
  ): Promise<PatronAddress> {
    const client = this.tenantPrisma.getClientV2(tenant);
    await this.assertPatron(tenant, patronId);
    this.assertNotEmpty(input);

    return client.$transaction(async (tx) => {
      // FIRST address is primary whether or not the caller said so. A patron
      // with addresses and no primary is a patron a notice job silently skips.
      const existing = await tx.patronAddress.count({ where: { patronId } });
      const wantsPrimary = input.isPrimary === true || existing === 0;
      if (wantsPrimary) await this.demoteIncumbent(tx, patronId);

      const row = await tx.patronAddress.create({
        data: {
          patronId,
          kind: (input.kind ?? 'home') as never,
          isPrimary: wantsPrimary,
          line1: input.line1 ?? null,
          line2: input.line2 ?? null,
          city: input.city ?? null,
          region: input.region ?? null,
          postalCode: input.postalCode ?? null,
          country: input.country ?? 'GR',
          validFrom: input.validFrom === undefined ? null : this.day(input.validFrom),
          validTo: input.validTo === undefined ? null : this.day(input.validTo),
          updatedAt: new Date(),
        } as never,
      });
      return this.toDto(row);
    });
  }

  async update(
    tenant: TenantContext,
    patronId: string,
    addressId: string,
    input: AddressInput,
  ): Promise<PatronAddress> {
    const client = this.tenantPrisma.getClientV2(tenant);
    return client.$transaction(async (tx) => {
      const existing = await tx.patronAddress.findFirst({ where: { id: addressId, patronId } });
      if (existing === null) {
        throw new NotFoundException(`No address ${addressId} for patron ${patronId}.`);
      }

      // THE TWO STATEMENTS, IN THIS ORDER, IN ONE TRANSACTION. Promoting first
      // raises 23505 against `patron_addresses_one_primary`; doing it in two
      // transactions leaves a window with no primary at all, which is exactly
      // when a notice job would read it.
      if (input.isPrimary === true && !existing.isPrimary) {
        await this.demoteIncumbent(tx, patronId);
      }
      if (input.isPrimary === false && existing.isPrimary) {
        throw new BadRequestException(
          'A patron keeps one primary address. Promote another address instead of demoting this ' +
            'one, or the library has nowhere to post a letter.',
        );
      }

      const data: Record<string, unknown> = { updatedAt: new Date() };
      for (const k of [
        'kind',
        'line1',
        'line2',
        'city',
        'region',
        'postalCode',
        'country',
      ] as const) {
        if (input[k] !== undefined) data[k] = input[k];
      }
      if (input.isPrimary !== undefined) data['isPrimary'] = input.isPrimary;
      if (input.validFrom !== undefined) data['validFrom'] = this.day(input.validFrom);
      if (input.validTo !== undefined) data['validTo'] = this.day(input.validTo);

      const row = await tx.patronAddress.update({
        where: { id: addressId },
        data: data as never,
      });
      return this.toDto(row);
    });
  }

  /**
   * Record that post to this address came back.
   *
   * Its own operation rather than a field on the patch, because it is a fact
   * learned from a returned envelope rather than an edit somebody made — and
   * because it is what `PatronBlockCode.address_unconfirmed` reads. Clearing it
   * is the same call with `undeliverable: false`, which is what a clerk does
   * after confirming the address at the desk.
   */
  async setUndeliverable(
    tenant: TenantContext,
    patronId: string,
    addressId: string,
    undeliverable: boolean,
    reason: string | null,
  ): Promise<PatronAddress> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const existing = await client.patronAddress.findFirst({ where: { id: addressId, patronId } });
    if (existing === null) {
      throw new NotFoundException(`No address ${addressId} for patron ${patronId}.`);
    }
    const row = await client.patronAddress.update({
      where: { id: addressId },
      data: {
        undeliverableAt: undeliverable ? new Date() : null,
        undeliverableReason: undeliverable ? reason : null,
        updatedAt: new Date(),
      },
    });
    return this.toDto(row);
  }

  async remove(tenant: TenantContext, patronId: string, addressId: string): Promise<void> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const existing = await client.patronAddress.findFirst({ where: { id: addressId, patronId } });
    if (existing === null) {
      throw new NotFoundException(`No address ${addressId} for patron ${patronId}.`);
    }
    // The last one may go — a library that has no address for a reader is a
    // real state, and refusing would leave a wrong address on file because it
    // was the only one. Deleting the PRIMARY while others remain is refused,
    // because the result would be a patron with addresses and no primary.
    if (existing.isPrimary) {
      const others = await client.patronAddress.count({
        where: { patronId, id: { not: addressId } },
      });
      if (others > 0) {
        throw new BadRequestException(
          'This is the primary address. Promote another one first, or the patron would be left ' +
            'with addresses and no primary — which a notice job skips silently.',
        );
      }
    }
    await client.patronAddress.delete({ where: { id: addressId } });
  }

  // -------------------------------------------------------------------------

  /**
   * Clear whichever address currently holds primary.
   *
   * Typed against the one method it uses rather than the whole transaction
   * client: the two callers pass a `$transaction` handle whose full type is a
   * generated Prisma union, and naming it here would drag that union across the
   * module boundary for a single `updateMany`.
   */
  private async demoteIncumbent(tx: DemotesAddresses, patronId: string): Promise<void> {
    await tx.patronAddress.updateMany({
      where: { patronId, isPrimary: true },
      data: { isPrimary: false, updatedAt: new Date() },
    });
  }

  private async assertPatron(tenant: TenantContext, patronId: string): Promise<void> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const patron = await client.patron.findUnique({
      where: { id: patronId },
      select: { id: true, erasedAt: true },
    });
    if (patron === null) throw new NotFoundException(`No patron with id ${patronId}.`);
    if (patron.erasedAt !== null) {
      throw new BadRequestException(
        'This patron was erased under Article 17. An address is identifying data.',
      );
    }
  }

  /** An address with nothing in it is a row nobody can post to. */
  private assertNotEmpty(input: AddressInput): void {
    const hasSomething = [input.line1, input.city, input.postalCode].some(
      (v) => typeof v === 'string' && v.trim().length > 0,
    );
    if (!hasSomething) {
      throw new BadRequestException(
        'An address needs at least a street, a city or a postal code. A row with none of them ' +
          'cannot be posted to and would read as an address the library holds.',
      );
    }
  }

  private day(v: string | null | undefined): Date | null {
    return v === null || v === undefined ? null : new Date(`${v.slice(0, 10)}T00:00:00.000Z`);
  }

  private toDto(r: Record<string, unknown>): PatronAddress {
    return {
      id: String(r['id']),
      patronId: String(r['patronId']),
      kind: String(r['kind']),
      isPrimary: r['isPrimary'] === true,
      line1: (r['line1'] as string | null) ?? null,
      line2: (r['line2'] as string | null) ?? null,
      city: (r['city'] as string | null) ?? null,
      region: (r['region'] as string | null) ?? null,
      postalCode: (r['postalCode'] as string | null) ?? null,
      country: (r['country'] as string | null) ?? null,
      undeliverableAt: (r['undeliverableAt'] as Date | null) ?? null,
      undeliverableReason: (r['undeliverableReason'] as string | null) ?? null,
      validFrom: (r['validFrom'] as Date | null) ?? null,
      validTo: (r['validTo'] as Date | null) ?? null,
    };
  }
}
