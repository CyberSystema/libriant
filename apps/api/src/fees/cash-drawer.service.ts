import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { changeActorOf, setChangeActor } from '../tenancy/tenant-actor-guc.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TenantClockService } from '../policy/tenant-clock.service.js';
import { acquireLocks, lockKey } from '../platform/locks.js';
import { postJournalWithin } from './ledger.js';

/**
 * The till (2.0 phase 18).
 *
 * ## A CLOSE WITH A VARIANCE RECORDS IT. It never adjusts the till.
 *
 * This is the acceptance criterion, and it is a statement about what a library
 * is allowed to learn. The journal says what the desk took; the count says what
 * is in the drawer; when they differ, something happened — a note stuck to
 * another, change given wrong, a theft — and the gap is the only evidence of it.
 * A close that "corrected" the expected figure to match the count would make
 * every drawer balance for ever and make that evidence unobtainable.
 *
 * So the variance is stored, and it is posted to `cash_over_short`, which is an
 * EXPENSE account. The library's books then say, truthfully, that it is down
 * thirty cents — rather than that its till holds thirty cents it does not have.
 *
 * ## expected_cents is a SNAPSHOT, not a recomputation
 *
 * It is computed once, here, from the journal as it stands at the moment of
 * counting, and stored. A generated column or a view would re-answer the
 * question every time somebody looked, so a transaction posted late — an
 * offline replica reconciling, a correction keyed the next morning — would
 * silently rewrite what last night's drawer was supposed to hold, and a variance
 * somebody had already investigated would disappear from the record.
 */
@Injectable()
export class CashDrawerService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly clock: TenantClockService,
  ) {}

  /**
   * Open a till at a desk.
   *
   * One at a time per service point — `cash_drawer_one_open_per_service_point`
   * says so, and the 23505 is turned into a 409 here because two open drawers at
   * one desk is two librarians each certain they know what is in it.
   */
  async open(
    tenant: TenantContext,
    actor: TenantActor,
    input: {
      readonly servicePointId: string;
      readonly currency: string;
      readonly openingFloatCents: bigint;
    },
  ): Promise<{ drawerSessionId: string }> {
    if (input.openingFloatCents < 0n) {
      throw new BadRequestException('An opening float cannot be negative.');
    }
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    return client.$transaction(async (tx) => {
      await acquireLocks(tx, [lockKey('drawer', input.servicePointId)]);
      await setChangeActor(tx, changeActorOf(actor));

      const servicePoint = await tx.servicePoint.findUnique({
        where: { id: input.servicePointId },
        select: { id: true, branchId: true, archivedAt: true },
      });
      if (servicePoint === null || servicePoint.archivedAt !== null) {
        throw new NotFoundException(`No active service point ${input.servicePointId}.`);
      }

      const already = await tx.cashDrawerSession.findFirst({
        where: { servicePointId: input.servicePointId, closedAt: null },
        select: { id: true },
      });
      if (already !== null) {
        throw new ConflictException(
          `Service point ${input.servicePointId} already has an open drawer (${already.id}). ` +
            `Close it before opening another.`,
        );
      }

      const session = await tx.cashDrawerSession.create({
        data: {
          servicePointId: servicePoint.id,
          branchId: servicePoint.branchId,
          currency: input.currency,
          openedAt: now,
          openedByUserId: actor.userId ?? null,
          openingFloatCents: input.openingFloatCents,
        },
        select: { id: true },
      });
      return { drawerSessionId: session.id };
    });
  }

  /**
   * What the journal says this drawer should hold.
   *
   * `opening_float + SUM(debit - credit)` over `cash_on_hand` for this session.
   * There is no `cash_drawer_movements` table to read instead, and that is the
   * design: a movements table would be a second recording of the same fact, and
   * a cash count is only worth taking because it is an INDEPENDENT check on the
   * journal rather than a comparison of the journal with itself.
   */
  async expectedCents(tenant: TenantContext, drawerSessionId: string): Promise<bigint> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const rows = await client.$queryRaw<{ expected: bigint }[]>`
      SELECT (d.opening_float_cents
              + COALESCE(pg_catalog.sum(e.debit_cents - e.credit_cents), 0))::bigint AS expected
        FROM cash_drawer_sessions d
        LEFT JOIN account_transactions t ON t.drawer_session_id = d.id
        LEFT JOIN account_entries e
               ON e.transaction_id = t.id AND e.account = 'cash_on_hand'
       WHERE d.id = ${drawerSessionId}
       GROUP BY d.id, d.opening_float_cents`;
    const row = rows[0];
    if (row === undefined) throw new NotFoundException(`No drawer session ${drawerSessionId}.`);
    return BigInt(row.expected);
  }

  /**
   * Count the till and close it.
   *
   * The variance is RECORDED — on the session, and as a journal against
   * `cash_over_short` so the general ledger says the same thing the drawer does.
   * A drawer that counted exactly posts no journal at all: a zero-amount
   * transaction would balance trivially and mean nothing, and
   * `fee_allocations_not_zero` refuses the same shape one table over.
   */
  async close(
    tenant: TenantContext,
    actor: TenantActor,
    input: {
      readonly drawerSessionId: string;
      readonly countedCents: bigint;
      readonly note?: string | null;
    },
  ): Promise<{
    expectedCents: bigint;
    countedCents: bigint;
    varianceCents: bigint;
    transactionId: string | null;
  }> {
    if (input.countedCents < 0n) {
      throw new BadRequestException('A counted till cannot be negative.');
    }
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    const session = await client.cashDrawerSession.findUnique({
      where: { id: input.drawerSessionId },
      select: { id: true, servicePointId: true, branchId: true, currency: true, closedAt: true },
    });
    if (session === null) {
      throw new NotFoundException(`No drawer session ${input.drawerSessionId}.`);
    }
    if (session.closedAt !== null) {
      throw new ConflictException(`Drawer session ${session.id} is already closed.`);
    }

    return client.$transaction(async (tx) => {
      await acquireLocks(tx, [lockKey('drawer', session.servicePointId)]);
      await setChangeActor(tx, changeActorOf(actor));

      // Inside the lock and inside the transaction, so no payment can land
      // between the figure being taken and the session being closed.
      const rows = await tx.$queryRaw<{ expected: bigint }[]>`
        SELECT (d.opening_float_cents
                + COALESCE(pg_catalog.sum(e.debit_cents - e.credit_cents), 0))::bigint AS expected
          FROM cash_drawer_sessions d
          LEFT JOIN account_transactions t ON t.drawer_session_id = d.id
          LEFT JOIN account_entries e
                 ON e.transaction_id = t.id AND e.account = 'cash_on_hand'
         WHERE d.id = ${session.id}
         GROUP BY d.id, d.opening_float_cents`;
      const expectedCents = BigInt(rows[0]?.expected ?? 0n);
      const varianceCents = input.countedCents - expectedCents;

      let transactionId: string | null = null;
      if (varianceCents !== 0n) {
        const short = varianceCents < 0n;
        const magnitude = short ? -varianceCents : varianceCents;
        const journal = await postJournalWithin(tx, {
          kind: 'cash_over_short',
          currency: session.currency,
          branchId: session.branchId,
          drawerSessionId: session.id,
          actorUserId: actor.userId ?? null,
          note: input.note ?? null,
          now,
          // SHORT: the till holds less than the journal says, so cash leaves and
          // the library books an expense. OVER: the reverse, and it is still
          // posted to cash_over_short rather than to revenue — money that
          // appeared without a transaction is not income, it is unexplained.
          legs: short
            ? [
                { account: 'cash_over_short', debit: magnitude },
                { account: 'cash_on_hand', credit: magnitude },
              ]
            : [
                { account: 'cash_on_hand', debit: magnitude },
                { account: 'cash_over_short', credit: magnitude },
              ],
        });
        transactionId = journal.transactionId;
      }

      await tx.cashDrawerSession.update({
        where: { id: session.id },
        data: {
          closedAt: now,
          closedByUserId: actor.userId ?? null,
          countedCents: input.countedCents,
          expectedCents,
          varianceCents,
          closeNote: input.note ?? null,
        },
      });

      return { expectedCents, countedCents: input.countedCents, varianceCents, transactionId };
    });
  }
}
