import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  computeDueDate,
  PolicyResolutionError,
  resolveCirculationPolicy,
  type ResolveContext,
} from '@libriant/circ-policy';
import { validateDto } from '../auth/validate-dto.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';
import { TenantActor as TenantActorParam } from '../tenancy/tenant-actor.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import { TenantCtx } from '../tenancy/tenant-context.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import {
  CreateRuleDto,
  ExplainQueryDto,
  PreviewDto,
  SetModeDto,
  UpdateRuleDto,
} from './policy.dto.js';
import { PolicySnapshotService } from './policy-snapshot.service.js';
import { PolicyWriteService } from './policy-write.service.js';
import { TenantClockService } from './tenant-clock.service.js';

/**
 * The rules matrix, and the answer to "why is this book due on the 19th?".
 *
 * §6's claim for M2 is that "Koha, Alma and FOLIO cannot answer the why-this-due-
 * date question at all", and `GET /circulation/explain` is where that claim is
 * cashed. It is only answerable because §3 chose winner-takes-all: one rule
 * decides all five policies, so the answer is a rule with a name. Under a
 * per-field merge — which is what Koha does, resolving per RULE NAME so
 * `issuelength` can come from one row and `fine` from another — the honest
 * answer is a six-row field-provenance table nobody reads.
 */
@Controller('t/:slug/circulation')
@UseGuards(TenantGuard, PermissionGuard)
export class PolicyController {
  constructor(
    @Inject(PolicySnapshotService) private readonly snapshots: PolicySnapshotService,
    @Inject(PolicyWriteService) private readonly writes: PolicyWriteService,
    @Inject(TenantClockService) private readonly clock: TenantClockService,
  ) {}

  /**
   * Which rule applies, which rules it beat, and every calendar roll that moved
   * the date.
   *
   * The three names §4.1 fixes — `matchedRuleId`, `beatenRuleIds`,
   * `calendarRolls` — come straight out of `RuleTrace` and are not renamed here.
   * `beatenRuleIds` is bounded to rules that MATCHED this context and lost: the
   * naive reading returns 499 ids from a 500-rule snapshot, and none of them is
   * what the librarian wanted to know. "Your branch rule beat the tenant
   * default" is.
   */
  @RequirePermission('circ.policy.read')
  @Get('explain')
  async explain(@TenantCtx() tenant: TenantContext, @Query() rawQuery: unknown) {
    const q = await validateDto(ExplainQueryDto, rawQuery ?? {});
    const { snapshot, branchCalendars } = await this.snapshots.load(tenant);
    const at = q.at === undefined ? this.clock.now() : this.clock.at(q.at);

    const ctx: ResolveContext = {
      patronCategoryId: q.patronCategoryId ?? null,
      itemTypeId: q.itemTypeId ?? null,
      owningBranchId: q.owningBranchId ?? null,
      shelvingLocationId: q.shelvingLocationId ?? null,
      checkoutBranchId: q.checkoutBranchId ?? null,
      pickupBranchId: q.pickupBranchId ?? null,
      at,
    };

    const resolved = this.resolve(snapshot, ctx);

    // The due date, and therefore the rolls, only exist if a branch was named:
    // a calendar is a property of a branch and there is no library-wide one.
    // Saying so is better than silently computing against whichever calendar
    // happened to be first.
    let dueAt: string | null = null;
    let rolls: readonly { reason: string; from: string; to: string; detail?: string }[] = [];
    let dueDateNote: string | null = null;
    const branchId = q.checkoutBranchId ?? q.owningBranchId ?? null;
    const calendar = branchId === null ? undefined : snapshot.calendars[branchId];

    if (branchId === null) {
      dueDateNote =
        'No branch was named, so no calendar applies and no due date was computed. Add ' +
        'checkoutBranchId to see the date and the rolls.';
    } else if (calendar === undefined) {
      dueDateNote =
        `Branch ${branchId} has no calendar, so opening hours and closed days cannot be ` +
        'applied. The rule below still decides the loan period.';
    } else {
      try {
        const computed = computeDueDate({
          policy: resolved.loan,
          calendar,
          from: at,
          hasOutstandingHold: q.hasOutstandingHold === true,
        });
        dueAt = computed.dueAt === null ? null : computed.dueAt.toISOString();
        rolls = computed.rolls;
      } catch (err) {
        // A calendar that does not reach this date, or one with no open day
        // inside the horizon, is a real refusal and the librarian needs its
        // wording — this endpoint exists to explain, so it explains the failure
        // too rather than turning it into a 500.
        dueDateNote = err instanceof PolicyResolutionError ? err.message : describe(err);
      }
    }

    return {
      snapshotVersion: resolved.trace.snapshotVersion,
      resolvedAt: at.toISOString(),
      matchedRuleId: resolved.trace.matchedRuleId,
      matchedRuleName: resolved.rule.name,
      beatenRuleIds: resolved.trace.beatenRuleIds,
      selectorsUsed: resolved.trace.selectorsUsed,
      wildcardsUsed: resolved.trace.wildcardsUsed,
      calendarRolls: rolls,
      dueAt,
      dueDateNote,
      policies: {
        loan: { id: resolved.loan.id, name: resolved.loan.name },
        overdueFine: { id: resolved.overdueFine.id, name: resolved.overdueFine.name },
        lostItemFee: { id: resolved.lostItemFee.id, name: resolved.lostItemFee.name },
        hold: { id: resolved.hold.id, name: resolved.hold.name },
        notice: { id: resolved.notice.id, name: resolved.notice.name },
      },
      categoryLimit: resolved.categoryLimit,
      branchCalendarId: branchId === null ? null : (branchCalendars[branchId] ?? null),
    };
  }

  /**
   * What a loan policy WOULD do, before it is saved.
   *
   * §6 phase 13 asks for a "preview endpoint", and the reason it is not just
   * `explain` with a different name is that it takes an UNSAVED policy. A
   * librarian changing "14 days" to "3 weeks" wants to see the date move before
   * committing to it, and the alternative — save, look, undo — writes two rows
   * to the audit log and bumps the policy version twice for a question.
   *
   * It writes nothing and can write nothing: it builds a `LoanPolicy` value in
   * memory and hands it to the same pure function a real checkout uses.
   */
  @RequirePermission('circ.policy.read')
  @Post('preview')
  @HttpCode(200)
  async preview(@TenantCtx() tenant: TenantContext, @Body() raw: unknown) {
    const dto = await validateDto(PreviewDto, raw ?? {});
    const { snapshot } = await this.snapshots.load(tenant);
    const calendar = snapshot.calendars[dto.branchId];
    if (calendar === undefined) {
      throw new BadRequestException(
        `Branch ${dto.branchId} has no calendar, so a due date cannot be previewed against it. ` +
          'Give the branch a calendar first.',
      );
    }
    if (dto.loanPolicy.profile === 'rolling' && dto.loanPolicy.periodValue === undefined) {
      throw new BadRequestException('A rolling loan policy needs a period to preview.');
    }

    const at = dto.at === undefined ? this.clock.now() : this.clock.at(dto.at);
    // A whole `LoanPolicy` with the preview's four fields over the defaults the
    // form has not asked about. Cast at the boundary rather than threading a
    // partial type through `computeDueDate`, which takes the real thing.
    const policy = {
      id: 'preview',
      name: 'preview',
      loanable: true,
      profile: dto.loanPolicy.profile,
      period:
        dto.loanPolicy.periodValue === undefined
          ? null
          : { value: dto.loanPolicy.periodValue, unit: dto.loanPolicy.periodUnit ?? 'days' },
      fixedDueDateSetId: null,
      dueTimeOfDay:
        dto.loanPolicy.dueTimeOfDayMin === undefined || dto.loanPolicy.dueTimeOfDayMin === null
          ? null
          : {
              hour: Math.floor(dto.loanPolicy.dueTimeOfDayMin / 60),
              minute: dto.loanPolicy.dueTimeOfDayMin % 60,
            },
      closedDayHandling: dto.loanPolicy.closedDayHandling ?? 'keep',
      openingTimeOffset: null,
      maxPeriod: null,
      renewable: true,
      renewalsAllowed: null,
      renewalPeriod: null,
      renewFrom: 'currentDueDate',
      noRenewalBefore: null,
      noRenewalBeforeRelativeTo: 'dueDate',
      renewWithOutstandingHolds: true,
      alternateCheckoutPeriodWithHolds: null,
      alternateRenewalPeriodWithHolds: null,
      itemLimitForPolicy: null,
    } as const;

    try {
      const computed = computeDueDate({
        policy: policy as never,
        calendar,
        from: at,
        hasOutstandingHold: dto.hasOutstandingHold === true,
      });
      return {
        from: at.toISOString(),
        dueAt: computed.dueAt === null ? null : computed.dueAt.toISOString(),
        calendarRolls: computed.rolls,
        timezone: calendar.timezone,
      };
    } catch (err) {
      throw policyErrorToHttp(err);
    }
  }

  /** The matrix as the editor renders it, plus which mode the library is in. */
  @RequirePermission('circ.policy.read')
  @Get('policy')
  async readPolicy(@TenantCtx() tenant: TenantContext) {
    const { snapshot, circulationRulesEnabled } = await this.snapshots.load(tenant);
    return {
      snapshotVersion: snapshot.version,
      circulationRulesEnabled,
      // Ranked the way the resolver ranks, in JS. Postgres cannot reproduce this
      // order — see the loader — so the listing sorts here, from the same
      // comparator, and a UI can never show a different order than the engine
      // uses.
      rules: [...snapshot.rules]
        .sort(
          (a, b) =>
            b.priority - a.priority ||
            specificityOf(b) - specificityOf(a) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .map((r) => ({ ...r, specificity: specificityOf(r) })),
      loanPolicies: Object.values(snapshot.loanPolicies),
      overdueFinePolicies: Object.values(snapshot.overdueFinePolicies),
      lostItemFeePolicies: Object.values(snapshot.lostItemFeePolicies),
      holdPolicies: Object.values(snapshot.holdPolicies),
      noticePolicies: Object.values(snapshot.noticePolicies),
      patronCategoryLimits: Object.values(snapshot.patronCategoryLimits),
    };
  }

  @RequirePermission('circ.policy.manage')
  @Post('rules')
  @HttpCode(201)
  async createRule(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CreateRuleDto, raw ?? {});
    return this.writes.createRule(tenant, actor, {
      ...dto,
      effectiveFrom:
        dto.effectiveFrom === undefined || dto.effectiveFrom === null
          ? null
          : this.clock.at(dto.effectiveFrom),
      effectiveTo:
        dto.effectiveTo === undefined || dto.effectiveTo === null
          ? null
          : this.clock.at(dto.effectiveTo),
    });
  }

  @RequirePermission('circ.policy.manage')
  @Patch('rules/:id')
  @HttpCode(200)
  async updateRule(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(UpdateRuleDto, raw ?? {});
    const { effectiveFrom: _from, effectiveTo: _to, ...rest } = dto;
    await this.writes.updateRule(tenant, actor, id, {
      ...rest,
      ...(dto.effectiveFrom === undefined
        ? {}
        : { effectiveFrom: dto.effectiveFrom === null ? null : this.clock.at(dto.effectiveFrom) }),
      ...(dto.effectiveTo === undefined
        ? {}
        : { effectiveTo: dto.effectiveTo === null ? null : this.clock.at(dto.effectiveTo) }),
    });
    return { ok: true };
  }

  @RequirePermission('circ.policy.manage')
  @Delete('rules/:id')
  @HttpCode(200)
  async deleteRule(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Param('id') id: string,
  ) {
    await this.writes.deleteRule(tenant, actor, id);
    return { ok: true };
  }

  @RequirePermission('circ.policy.manage')
  @Put('mode')
  @HttpCode(200)
  async setMode(
    @TenantCtx() tenant: TenantContext,
    @TenantActorParam() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(SetModeDto, raw ?? {});
    await this.writes.setRulesEnabled(tenant, actor, dto.circulationRulesEnabled);
    return { circulationRulesEnabled: dto.circulationRulesEnabled };
  }

  /**
   * Give a library that has none the six rows it needs to lend. Idempotent.
   *
   * Every tenant provisioned before this phase has an empty matrix — `lbr2` held
   * no rows anywhere until now — and an empty matrix is `NO_MATCHING_RULE` on
   * the first checkout. Provisioning calls the same service for new libraries;
   * this route is how an existing one is repaired without a deploy.
   */
  @RequirePermission('circ.policy.manage')
  @Post('policy/seed')
  @HttpCode(200)
  async seed(@TenantCtx() tenant: TenantContext, @TenantActorParam() actor: TenantActor) {
    return this.writes.seedDefaults(tenant, actor);
  }

  private resolve(snapshot: Parameters<typeof resolveCirculationPolicy>[0], ctx: ResolveContext) {
    try {
      return resolveCirculationPolicy(snapshot, ctx);
    } catch (err) {
      throw policyErrorToHttp(err);
    }
  }
}

/** Six selector weights, as the SQL generated column computes them. */
function specificityOf(r: {
  patronCategoryId: string | null;
  itemTypeId: string | null;
  owningBranchId: string | null;
  shelvingLocationId: string | null;
  checkoutBranchId: string | null;
  pickupBranchId: string | null;
}): number {
  return (
    (r.patronCategoryId !== null ? 32 : 0) +
    (r.itemTypeId !== null ? 16 : 0) +
    (r.owningBranchId !== null ? 8 : 0) +
    (r.shelvingLocationId !== null ? 4 : 0) +
    (r.checkoutBranchId !== null ? 2 : 0) +
    (r.pickupBranchId !== null ? 1 : 0)
  );
}

/**
 * A resolver refusal is a 409, carrying its code.
 *
 * NOT a 500: every one of the ten `POLICY_ERROR` codes is a configuration
 * problem a librarian can act on — a missing wildcard rule, a calendar that does
 * not reach this date, a term set with no range for today — and a 500 with a
 * support code says none of that. The `code` travels so the staff UI can offer
 * the right next screen.
 */
function policyErrorToHttp(err: unknown): unknown {
  if (!(err instanceof PolicyResolutionError)) return err;
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: `circulation.${err.code}`,
    message: err.message,
    subjectId: err.subject ?? null,
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
