import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { changeActorOf, setChangeActor } from '../tenancy/tenant-actor-guc.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
import { acquireLocks, lockKey } from '../platform/locks.js';
import { DEFAULT_IDS, seedCirculationDefaults } from './circulation-defaults.js';
import { PolicySnapshotService } from './policy-snapshot.service.js';
import { TenantClockService } from './tenant-clock.service.js';

/**
 * Every write that can change what a book costs.
 *
 * Three things happen on every one of them, in this order, and the order is the
 * design:
 *
 *   1. the row changes inside a transaction, where seventeen `AFTER … FOR EACH
 *      STATEMENT` triggers bump `circulation_policy_version`;
 *   2. the transaction commits;
 *   3. the new version is ANNOUNCED — mirrored into Redis and published — so
 *      every other process drops its cache.
 *
 * Step 3 is deliberately outside the transaction. Announcing inside it means a
 * subscriber can react before the commit, read the PRE-CHANGE rows on its own
 * connection, and cache them stamped with the NEW version — after which every
 * freshness check agrees and the pod serves the old policy under the new number
 * until the TTL expires. Announcing after commit trades that for losing the
 * notification if the process dies in between, which is precisely what the
 * thirty-second backstop exists to cover.
 */
@Injectable()
export class PolicyWriteService {
  private readonly logger = new Logger(PolicyWriteService.name);

  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(PolicySnapshotService) private readonly snapshots: PolicySnapshotService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
    @Inject(TenantClockService) private readonly clock: TenantClockService,
  ) {}

  // -------------------------------------------------------------------------
  // Seeding
  // -------------------------------------------------------------------------

  /**
   * Give a library the six rows it needs to lend anything. Idempotent.
   *
   * A tenant provisioned before this phase — and `lbr2` currently holds no rows
   * anywhere, so that is every tenant — has an empty rules matrix, and an empty
   * matrix is `POLICY_ERROR.noMatchingRule` on the first checkout: the desk
   * refuses, correctly and unhelpfully. This is what closes that.
   *
   * UNDER AN ADVISORY LOCK, because "seed when the table is empty" is a
   * read-then-write and there are five callers between provisioning, the
   * maintenance fix pass and the tests. Two concurrent attempts both read zero
   * under ReadCommitted, both insert a wildcard, and one gets a `23505` from
   * `circulation_rules_default_singleton` — which is the constraint doing its
   * job, but as a 500 on a signup. The lock makes the second caller wait and
   * then find the rows.
   */
  async seedDefaults(tenant: TenantContext, actor: TenantActor): Promise<{ seeded: boolean }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    const outcome = await client.$transaction(
      async (tx) => {
        // The whole tenant's policy configuration is one lock domain; there is
        // no per-row contention to model. Phase 13 wrote this key by hand,
        // spelling it and hashing it exactly as `platform/locks.ts` does "so the
        // two can never collide by accident"; phase 16 made `policy` a real
        // LockDomain and this the call it always should have been.
        await acquireLocks(tx, [lockKey('policy', tenant.id)]);
        await setChangeActor(tx, changeActorOf(actor));

        // The same function the provisioning path calls, so a library created
        // by signup and one repaired by this route get identical rows.
        const seeded = await seedCirculationDefaults(tx as never, now);
        return { seeded, version: seeded ? await readVersion(tx) : (null as number | null) };
      },
      { isolationLevel: 'ReadCommitted' },
    );

    if (outcome.seeded) {
      await this.announce(tenant, outcome.version);
      await this.audit.record(tenant, actor, {
        action: 'circulation.policy.seeded',
        targetType: 'circulation_rule',
        targetId: DEFAULT_IDS.wildcardRule,
      });
      this.logger.log(`Seeded circulation defaults for tenant ${tenant.id}.`);
    }
    return { seeded: outcome.seeded };
  }

  // -------------------------------------------------------------------------
  // The wildcard rule, which cannot be removed
  // -------------------------------------------------------------------------

  /**
   * §6 phase 13: "Deleting or disabling the wildcard rule is refused with a
   * typed error."
   *
   * THE DATABASE CANNOT DO THIS ONE, and the reason is worth writing down
   * because the partial unique index looks like it should.
   * `circulation_rules_default_singleton` forbids a SECOND enabled wildcard; it
   * says nothing about removing the last one. A deferred CONSTRAINT TRIGGER
   * counting the survivors at commit would close delete, disable and
   * expire — and measured on PG 16.15, `CREATE CONSTRAINT TRIGGER … AFTER
   * TRUNCATE` is rejected outright (`FOR EACH ROW` is unsupported for TRUNCATE
   * and `FOR EACH STATEMENT` is a syntax error there), so `TRUNCATE
   * circulation_rules` would still empty the table. A guard that closes three
   * doors out of four, at commit time, with an error Prisma surfaces as a
   * generic transaction failure, is not obviously better than a guard in the one
   * service that owns this table — and it is materially worse to read.
   *
   * So the refusal is here, it is typed, and it names what would happen. The
   * fourth door is closed by phase 16's role work (`REVOKE TRUNCATE`), and the
   * `circulation_settings`/`circulation_policy_version` bump triggers mean that
   * if anybody does truncate the table, every pod rebuilds within a second and
   * the resolver refuses to lend rather than serving a matrix that no longer
   * exists. Refusing is correct.
   */
  private assertNotTheWildcard(
    rule: { id: string; specificityIsZero: boolean },
    what: string,
  ): void {
    if (!rule.specificityIsZero) return;
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'circulation.wildcardRuleRequired',
      message:
        `This is the library's default rule — the one with no conditions on it — and ${what} it ` +
        'would leave loans with no policy at all: the desk would refuse every checkout, with no ' +
        'rule to point at. Edit it instead, or add a more specific rule above it.',
      ruleId: rule.id,
    });
  }

  async deleteRule(tenant: TenantContext, actor: TenantActor, ruleId: string): Promise<void> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const version = await client.$transaction(
      async (tx) => {
        await setChangeActor(tx, changeActorOf(actor));
        const rule = await this.requireRule(tx, ruleId);
        this.assertNotTheWildcard(rule, 'deleting');
        await tx.circulationRule.delete({ where: { id: ruleId } });
        return readVersion(tx);
      },
      { isolationLevel: 'ReadCommitted' },
    );
    await this.announce(tenant, version);
    await this.audit.record(tenant, actor, {
      action: 'circulation.rule.deleted',
      targetType: 'circulation_rule',
      targetId: ruleId,
    });
  }

  /**
   * Update a rule. Disabling the wildcard is refused for the same reason
   * deleting it is: an `enabled = false` wildcard is present, looks configured,
   * and matches nothing.
   */
  async updateRule(
    tenant: TenantContext,
    actor: TenantActor,
    ruleId: string,
    patch: RulePatch,
  ): Promise<void> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const version = await client.$transaction(
      async (tx) => {
        await setChangeActor(tx, changeActorOf(actor));
        const rule = await this.requireRule(tx, ruleId);
        if (patch.enabled === false) this.assertNotTheWildcard(rule, 'disabling');
        // An `effective_to` in the past retires the rule as surely as disabling
        // it, and `isInForce` cannot tell the difference — so the wildcard
        // cannot be given one either. `effective_from` in the FUTURE is the
        // third way, and the sharpest, because the row reads as live: it is
        // refused here too.
        if (patch.effectiveTo !== undefined && patch.effectiveTo !== null) {
          this.assertNotTheWildcard(rule, 'giving an end date to');
        }
        if (patch.effectiveFrom !== undefined && patch.effectiveFrom !== null) {
          this.assertNotTheWildcard(rule, 'giving a start date to');
        }
        await tx.circulationRule.update({
          where: { id: ruleId },
          data: { ...patch, updatedAt: this.clock.now() } as never,
        });
        return readVersion(tx);
      },
      { isolationLevel: 'ReadCommitted' },
    );
    await this.announce(tenant, version);
    await this.audit.record(tenant, actor, {
      action: 'circulation.rule.updated',
      targetType: 'circulation_rule',
      targetId: ruleId,
      after: patch as never,
    });
  }

  /** Create a rule. A duplicate scope is a 409, not a 500. */
  async createRule(
    tenant: TenantContext,
    actor: TenantActor,
    input: RuleCreate,
  ): Promise<{ id: string }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();
    const result = await client
      .$transaction(
        async (tx) => {
          await setChangeActor(tx, changeActorOf(actor));
          const created = await tx.circulationRule.create({
            data: { ...input, createdAt: now, updatedAt: now } as never,
            select: { id: true },
          });
          return { id: created.id, version: await readVersion(tx) };
        },
        { isolationLevel: 'ReadCommitted' },
      )
      .catch((err: unknown) => {
        throw duplicateScope(err, isWildcardScope(input)) ?? err;
      });

    await this.announce(tenant, result.version);
    await this.audit.record(tenant, actor, {
      action: 'circulation.rule.created',
      targetType: 'circulation_rule',
      targetId: result.id,
    });
    return { id: result.id };
  }

  // -------------------------------------------------------------------------
  // Simple mode
  // -------------------------------------------------------------------------

  /**
   * Turn the matrix on or off.
   *
   * §8 risk 6: "simple mode is the DEFAULT and is gated by
   * `circulation_rules_enabled` — off means the UI is today's settings form
   * writing only the wildcard rule and the matrix editor does not exist."
   *
   * TURNING IT OFF IS REFUSED WHILE SPECIFIC RULES EXIST, and the check happens
   * inside the transaction that flips it. A library with fourteen rules that
   * switches to simple mode would otherwise keep resolving against all fourteen
   * while its UI showed one form describing the wildcard — the rules would still
   * price loans and nobody could see them. Deleting them silently is worse
   * again: they are the library's configuration.
   */
  async setRulesEnabled(
    tenant: TenantContext,
    actor: TenantActor,
    enabled: boolean,
  ): Promise<void> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const version = await client.$transaction(
      async (tx) => {
        await setChangeActor(tx, changeActorOf(actor));
        if (!enabled) {
          const specific = await tx.circulationRule.count({
            where: {
              OR: [
                { patronCategoryId: { not: null } },
                { itemTypeId: { not: null } },
                { owningBranchId: { not: null } },
                { shelvingLocationId: { not: null } },
                { checkoutBranchId: { not: null } },
                { pickupBranchId: { not: null } },
              ],
            },
          });
          if (specific > 0) {
            throw new ConflictException({
              statusCode: 409,
              error: 'Conflict',
              code: 'circulation.rulesStillPresent',
              message:
                `This library has ${specific} rule(s) with conditions on them. Simple mode shows ` +
                'one form for the default rule and no way to see the others — but they would go ' +
                'on deciding loan periods and fines invisibly. Delete them first, or stay in the ' +
                'full rules view.',
              ruleCount: specific,
            });
          }
        }
        await tx.circulationSetting.upsert({
          where: { id: 1 },
          create: { id: 1, circulationRulesEnabled: enabled, updatedAt: this.clock.now() },
          update: { circulationRulesEnabled: enabled, updatedAt: this.clock.now() },
        });
        return readVersion(tx);
      },
      { isolationLevel: 'ReadCommitted' },
    );
    await this.announce(tenant, version);
    await this.audit.record(tenant, actor, {
      action: 'circulation.mode.changed',
      targetType: 'circulation_settings',
      targetId: '1',
      after: { circulationRulesEnabled: enabled },
    });
  }

  // -------------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------------

  private async requireRule(
    tx: TxV2,
    ruleId: string,
  ): Promise<{ id: string; specificityIsZero: boolean }> {
    // The selectors rather than `specificity`: that column is GENERATED and
    // therefore absent from the Prisma model, so the datamodel cannot select it.
    // Six NULL checks say the same thing and say it in the datamodel's own
    // vocabulary.
    const rule = await tx.circulationRule.findUnique({
      where: { id: ruleId },
      select: {
        id: true,
        patronCategoryId: true,
        itemTypeId: true,
        owningBranchId: true,
        shelvingLocationId: true,
        checkoutBranchId: true,
        pickupBranchId: true,
      },
    });
    if (rule === null) throw new NotFoundException(`No circulation rule with id ${ruleId}.`);
    return {
      id: rule.id,
      specificityIsZero:
        rule.patronCategoryId === null &&
        rule.itemTypeId === null &&
        rule.owningBranchId === null &&
        rule.shelvingLocationId === null &&
        rule.checkoutBranchId === null &&
        rule.pickupBranchId === null,
    };
  }

  private async announce(tenant: TenantContext, version: number | null): Promise<void> {
    if (version === null) return;
    await this.snapshots.announce(tenant.id, version);
  }
}

/** Read the bumped counter inside the writing transaction. */
async function readVersion(tx: TxV2): Promise<number> {
  const row = await tx.circulationPolicyVersion.findUnique({
    where: { id: 1 },
    select: { version: true },
  });
  // Unreachable: the migration inserts the row and the CHECK pins its id. If it
  // is gone the write still committed, so this returns null and the announce is
  // skipped — every pod then converges on the backstop rather than on nothing.
  return row?.version ?? 0;
}

/**
 * `circulation_rules_scope_unique` → a 409 naming the scope.
 *
 * Returns `null` for anything else so the caller rethrows the original rather
 * than turning every failure into a duplicate-scope message — the same shape as
 * `duplicateControlNumber` in the MARC write path, and for the same reason.
 *
 * The evidence is the WHOLE stringified `meta` plus the message: Prisma 7 with a
 * driver adapter leaves `meta.target` undefined and reports the constraint at
 * `meta.driverAdapterError.cause.constraint.fields`, so a check against one path
 * is a check that silently stops working on a client upgrade.
 *
 * WHICH MESSAGE comes from the INPUT, not from which index fired — measured,
 * and it is the opposite of what the two index names suggest. A second wildcard
 * violates `circulation_rules_scope_unique` FIRST, because two wildcards have
 * identical all-empty scopes, so `circulation_rules_default_singleton` never
 * gets to report it. Keying the message on the constraint name told a librarian
 * who had tried to add a second default rule that "another rule already covers
 * exactly this combination of conditions" — true, and not what they needed to
 * hear.
 */
function duplicateScope(err: unknown, isWildcard: boolean): ConflictException | null {
  const e = err as { code?: string; meta?: unknown; message?: string };
  if (e?.code !== 'P2002') return null;
  const evidence = `${JSON.stringify(e.meta ?? '')} ${e.message ?? ''}`;
  if (
    !evidence.includes('circulation_rules_scope_unique') &&
    !evidence.includes('default_singleton')
  ) {
    return null;
  }
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: isWildcard ? 'circulation.duplicateWildcardRule' : 'circulation.duplicateRuleScope',
    message: isWildcard
      ? 'This library already has a default rule — the one with no conditions on it — and there ' +
        'can only be one. Edit that rule instead.'
      : 'Another rule already covers exactly this combination of conditions. Two rules with the ' +
        'same scope would tie on every ranking key, so which one priced a loan would depend on ' +
        'nothing a librarian can see. Edit the existing rule, or narrow this one.',
  });
}

export type RulePatch = {
  name?: string;
  notes?: string | null;
  loanPolicyId?: string;
  overdueFinePolicyId?: string;
  lostItemFeePolicyId?: string;
  holdPolicyId?: string;
  noticePolicyId?: string;
  maxLoansForRule?: number | null;
  maxHoldsForRule?: number | null;
  ageRestrictionMinYears?: number | null;
  priority?: number;
  enabled?: boolean;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
};

export type RuleCreate = {
  id?: string;
  name: string;
  notes?: string | null;
  patronCategoryId?: string | null;
  itemTypeId?: string | null;
  owningBranchId?: string | null;
  shelvingLocationId?: string | null;
  checkoutBranchId?: string | null;
  pickupBranchId?: string | null;
  loanPolicyId: string;
  overdueFinePolicyId: string;
  lostItemFeePolicyId: string;
  holdPolicyId: string;
  noticePolicyId: string;
  maxLoansForRule?: number | null;
  maxHoldsForRule?: number | null;
  ageRestrictionMinYears?: number | null;
  priority?: number;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
};

/** Six blank selectors. The shape of the one rule a library must always have. */
function isWildcardScope(input: RuleCreate): boolean {
  return (
    (input.patronCategoryId ?? null) === null &&
    (input.itemTypeId ?? null) === null &&
    (input.owningBranchId ?? null) === null &&
    (input.shelvingLocationId ?? null) === null &&
    (input.checkoutBranchId ?? null) === null &&
    (input.pickupBranchId ?? null) === null
  );
}
