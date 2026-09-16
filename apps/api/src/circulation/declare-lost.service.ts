import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { TenantClockService } from '../policy/tenant-clock.service.js';
import { ItemStatusService } from '../items/item-status.service.js';
import { FeesService } from '../fees/fees.service.js';
import { acquireLocks, lockKey } from '../platform/locks.js';
import { changeActorOf, setChangeActor } from '../tenancy/tenant-actor-guc.js';

/**
 * The copy is not coming back (2.0 phase 20h).
 *
 * ## Why this exists now and not in phase 21
 *
 * §6 assigns declare-lost to phase 21, along with claims-returned, recall and
 * the transit desk. But phase 21 is in M3, AFTER the cutover — and the cutover
 * deletes `apps/api/src/loans`, which is where `POST /loans/:id/mark-lost`
 * lives. A library that upgrades and can no longer record a lost book has lost
 * a circulation capability, not a screen, and "it comes back in a few months"
 * is not an answer a librarian can give the reader standing in front of them.
 *
 * ## What it does, and what it deliberately leaves to 21
 *
 * It does what 1.0 does, through 2.0's machinery:
 *
 *   - the loan closes. `loans_closed_consistency` is
 *     `(closed_at IS NULL) = (status IN ('active','claims_returned',…))`, so a
 *     `lost` loan is a CLOSED loan — §3 split `closed_at` from `returned_at`
 *     precisely so it can close without a return and stop pinning the copy out
 *     of circulation for ever, which was 1.0's dead end.
 *   - the reader KEEPS their link. Anonymisation happens on RETURN, and the
 *     library is still trying to get this book back — severing it would leave
 *     nobody to ask. `CheckinService` draws the line in the same place.
 *   - the copy moves to `missing` through phase 15's single status writer.
 *     `item_status` has six values and `lost` is not one of them; `missing` is
 *     2.0's word for a copy the library has not got.
 *   - a replacement fee is raised THROUGH THE LEDGER when staff name an amount,
 *     so it is a real double-entry charge against the reader's account, linked
 *     to the loan and the copy — which 1.0's could not be.
 *
 * WHAT IS STILL PHASE 21: pricing the fee from `lost_item_fee_policies` via the
 * loan's pinned snapshot. 1.0 falls back to a single library-wide default when
 * staff name no amount; 2.0's answer is a policy resolution, and inventing a
 * cheaper one here would put a number nobody chose onto a reader's account.
 * Until then the amount is explicit or there is no charge, and the caller is
 * told which happened.
 */
@Injectable()
export class DeclareLostService {
  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
    @Inject(TenantClockService) private readonly clock: TenantClockService,
    @Inject(ItemStatusService) private readonly status: ItemStatusService,
    @Inject(FeesService) private readonly fees: FeesService,
  ) {}

  async declareLost(
    tenant: TenantContext,
    actor: TenantActor,
    loanId: string,
    input: { amountCents?: number | null; note?: string | null } = {},
  ): Promise<{
    loanId: string;
    itemId: string;
    feeId: string | null;
    charged: boolean;
    reason: string | null;
  }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    const loan = await client.loan.findUnique({
      where: { id: loanId },
      select: {
        id: true,
        itemId: true,
        patronId: true,
        bibId: true,
        status: true,
        closedAt: true,
        checkoutBranchId: true,
      },
    });
    if (loan === null) throw new NotFoundException(`No loan with id ${loanId}.`);
    if (loan.closedAt !== null) {
      throw new BadRequestException(
        loan.status === 'returned'
          ? 'This loan was already returned — the copy is not lost.'
          : `This loan is already closed (${loan.status}).`,
      );
    }

    const amountCents =
      input.amountCents === null || input.amountCents === undefined
        ? null
        : Math.trunc(input.amountCents);
    if (amountCents !== null && amountCents <= 0) {
      throw new BadRequestException(
        'A replacement charge must be a positive amount. Leave it out to record the loss without ' +
          'billing the reader.',
      );
    }

    await client.$transaction(
      async (tx) => {
        // patron (1) then item (3) — the ranked order `locks.ts` enforces.
        await acquireLocks(
          tx,
          loan.patronId === null
            ? [lockKey('item', loan.itemId)]
            : [lockKey('patron', loan.patronId), lockKey('item', loan.itemId)],
        );
        await setChangeActor(tx, changeActorOf(actor));

        // RE-READ UNDER THE LOCK. The probe above ran on the outer client, so a
        // checkin at the desk can have closed this loan in between — and a
        // declare-lost that raced a return would bill a reader for a book they
        // had just handed over.
        const still = await tx.loan.findFirst({
          where: { id: loanId, closedAt: null },
          select: { id: true },
        });
        if (still === null) {
          throw new BadRequestException(
            'This loan was closed at the desk while the form was open. Check the copy again.',
          );
        }

        await tx.loan.update({
          where: { id: loanId },
          data: {
            status: 'lost',
            declaredLostAt: now,
            closedAt: now,
            updatedAt: now,
          },
        });
        await tx.loanEvent.create({
          data: {
            loanId,
            kind: 'declared_lost',
            occurredAt: now,
            // BOTH, and they are different questions — phase 16 split them so a
            // backdated desk operation says when it happened as well as when it
            // was recorded. A declaration is made at the moment it is made:
            // nobody knows when the book actually went missing, and inventing a
            // date for it would be the one part of this row that is a guess.
            effectiveAt: now,
            branchId: loan.checkoutBranchId,
            actorUserId: actor.userId ?? null,
            note: input.note ?? null,
            source: 'desk',
          } as never,
        });
        await this.status.applyWithin(tx, {
          itemId: loan.itemId,
          toStatus: 'missing',
          causeType: 'loan',
          causeId: loanId,
          note: 'declared lost at the desk',
          now,
        });
      },
      { isolationLevel: 'ReadCommitted' },
    );

    // THE CHARGE IS ITS OWN TRANSACTION, deliberately.
    //
    // Phase 16's rule, restated: a fee the reader disputes must not be able to
    // abort the circulation operation. The copy is gone either way; the loan
    // closing is the fact, and the money is a consequence of it. `FeesService`
    // opens and balances its own journal, and a failure here leaves a closed
    // loan and a missing copy — which is the correct half to keep.
    let feeId: string | null = null;
    if (amountCents !== null && loan.patronId !== null) {
      const charged = await this.fees.charge(tenant, actor, {
        patronId: loan.patronId,
        feeTypeId: 'feetype_replacement',
        branchId: loan.checkoutBranchId,
        currency: await this.currencyFor(tenant, loan.checkoutBranchId),
        amountCents: BigInt(amountCents),
        reason: input.note ?? 'Replacement cost for a copy declared lost',
        loanId,
        itemId: loan.itemId,
      });
      feeId = charged.feeId;
    }

    await this.audit.record(tenant, actor, {
      action: 'circulation.loan.declared_lost',
      // `targetType`/`targetId`, NOT `entityKind`/`entityId`. Those are the 2.0
      // COLUMN names; `AuditEntry` is the service's own contract and
      // `TenantAuditService` maps it onto whichever schema is live. Phase 20h
      // wrote the column names here and reached for `as never` when the type
      // disagreed — so only `action` survived, this row lost the loan id, and
      // `target_type` went in NULL. Nothing noticed, because the audit writer
      // swallows its own failures by design.
      targetType: 'loan',
      targetId: loanId,
      after: { itemId: loan.itemId, feeId, amountCents },
    });

    return {
      loanId,
      itemId: loan.itemId,
      feeId,
      charged: feeId !== null,
      reason:
        feeId !== null
          ? null
          : amountCents === null
            ? 'No amount was given, so nothing was charged. Pricing a lost copy from the policy is ' +
              'phase 21; until then the amount is the library’s to name.'
            : 'This loan has no reader linked to it, so there was nobody to charge.',
    };
  }

  /** The branch's currency — money is always a pair, and the branch owns it. */
  private async currencyFor(tenant: TenantContext, branchId: string): Promise<string> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const branch = await client.branch.findUnique({
      where: { id: branchId },
      select: { currency: true },
    });
    return branch?.currency ?? 'EUR';
  }
}
