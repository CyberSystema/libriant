import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { NonProductionOnlyGuard, PlanDemoController } from './plan-demo.controller.js';
import { PlanUsageController } from './plan-usage.controller.js';
import { AdminPlanUsageController } from './plan-usage-admin.controller.js';
import { PlansModule } from './plans.module.js';
import { breaches, type UsageRow } from './plan-usage.js';

/**
 * launch-readiness-17 / billing-16, and the regression each is one edit away
 * from becoming again.
 */

function row(partial: Partial<UsageRow> & Pick<UsageRow, 'feature' | 'limit' | 'used'>): UsageRow {
  return {
    unlimited: false,
    unit: null,
    source: 'plan',
    ...partial,
  } as UsageRow;
}

describe('the usage routes are not behind the production gate', () => {
  // The routes were moved off PlanDemoController, whose NonProductionOnlyGuard
  // 404'd them in production and left a library with no screen anywhere showing
  // how much of its plan it had spent. Putting the guard back — or moving a
  // route back onto the demo controller — is a one-line edit that typechecks,
  // lints, and silently takes the numbers away again. Nest resolves guards from
  // exactly this metadata, so this is the same thing the router reads.
  it('PlanUsageController carries no NonProductionOnlyGuard', () => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, PlanUsageController) ?? []) as unknown[];
    expect(guards).not.toContain(NonProductionOnlyGuard);
    expect(guards.length).toBeGreaterThan(0); // still tenant- and role-guarded
  });

  it('serves both /plan and /plan/usage itself', () => {
    const paths = ['plan', 'usage'].map((name) =>
      Reflect.getMetadata(PATH_METADATA, PlanUsageController.prototype[name as 'plan' | 'usage']),
    );
    expect(paths).toEqual(['plan', 'plan/usage']);
  });

  it('the demo write it was split away from IS still production-gated', () => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, PlanDemoController) ?? []) as unknown[];
    expect(guards[0]).toBe(NonProductionOnlyGuard);
  });

  it('PlansModule registers both new controllers — unregistered they are inert', () => {
    const controllers = (Reflect.getMetadata('controllers', PlansModule) ?? []) as unknown[];
    expect(controllers).toContain(PlanUsageController);
    expect(controllers).toContain(AdminPlanUsageController);
  });
});

describe('breaches()', () => {
  it('reports a library that is at or past a cap it holds things under', () => {
    expect(
      breaches([
        row({ feature: 'staff_seats', limit: 3, used: 4 }),
        row({ feature: 'max_books', limit: 5_000, used: 5_000 }),
        row({ feature: 'max_members', limit: 1_500, used: 12 }),
      ]).map((r) => r.feature),
    ).toEqual(['staff_seats', 'max_books']);
  });

  it('does NOT report a zero limit nobody has used', () => {
    // Starter's max_custom_collections is 0 — the feature is switched off, not
    // a cap anyone has filled. Without this, `0 >= 0` made every Starter
    // library a breach: driven against the 135 tenants on the audit control
    // plane the pre-flight answered `overCap: 135`, every one of them for this
    // single line, which is a report an operator scrolls past.
    expect(breaches([row({ feature: 'max_custom_collections', limit: 0, used: 0 })])).toEqual([]);
  });

  it('DOES report a zero limit that already holds something', () => {
    // The library made three collections while subscriptions were off. Flipping
    // the switch refuses the fourth; the operator has to know before Monday.
    expect(
      breaches([row({ feature: 'max_custom_collections', limit: 0, used: 3 })]).map(
        (r) => r.feature,
      ),
    ).toEqual(['max_custom_collections']);
  });

  it('never reports an unlimited line, whatever the sentinel is next to', () => {
    expect(
      breaches([
        row({
          feature: 'max_books',
          limit: Number.MAX_SAFE_INTEGER,
          used: 400_000,
          unlimited: true,
        }),
      ]),
    ).toEqual([]);
  });

  it('never reports a line with no counter — "we did not measure" is not "over"', () => {
    expect(breaches([row({ feature: 'max_books', limit: 10, used: null })])).toEqual([]);
  });
});
