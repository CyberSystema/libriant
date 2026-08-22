/**
 * Idempotent seed for the control-plane DB.
 *
 * Guarantees:
 *   - Re-runnable: each section checks for existing rows before inserting.
 *   - Single transaction: either everything lands or nothing does.
 *   - Catalog-aware: feature rows mirror `@libriant/shared/features.ts` so a
 *     new feature key surfaces in the admin UI after a seed re-run.
 *
 * To re-seed from scratch in dev:
 *   pnpm --filter @libriant/db-control prisma:migrate:reset
 *   (Prisma will re-apply migrations and run this script.)
 */
import { FEATURES, FeatureKey } from '@libriant/shared';
import { controlDb, disconnectControlDb, BillingMode, FeatureType } from '../src';
import { featureRows, defaultCell, planSeeds } from './seed-data';

function pickValueCols(value: number | boolean | string | null) {
  if (value === null || value === undefined) {
    return { valueInt: null, valueBool: null, valueText: null };
  }
  if (typeof value === 'number') return { valueInt: value, valueBool: null, valueText: null };
  if (typeof value === 'boolean') return { valueInt: null, valueBool: value, valueText: null };
  return { valueInt: null, valueBool: null, valueText: value };
}

async function seedCells() {
  const existing = await controlDb.cell.findUnique({ where: { slug: defaultCell.slug } });
  if (existing) {
    console.log(`  • cell "${defaultCell.slug}" already exists — skipping`);
    return existing;
  }
  const created = await controlDb.cell.create({ data: defaultCell });
  console.log(`  • created cell "${created.slug}"`);
  return created;
}

async function seedFeatureCatalog() {
  let inserted = 0;
  let updated = 0;
  for (const row of featureRows) {
    const existing = await controlDb.planFeature.findUnique({ where: { key: row.key } });
    if (existing) {
      // Refresh label/description/defaults if they drifted, but keep nothing else.
      await controlDb.planFeature.update({
        where: { key: row.key },
        data: {
          label: row.label,
          description: row.description,
          type: row.type as FeatureType,
          defaultInt: row.defaultInt,
          defaultBool: row.defaultBool,
          defaultText: row.defaultText,
          unit: row.unit,
          sortOrder: row.sortOrder,
        },
      });
      updated++;
    } else {
      await controlDb.planFeature.create({
        data: {
          key: row.key,
          type: row.type as FeatureType,
          label: row.label,
          description: row.description,
          defaultInt: row.defaultInt,
          defaultBool: row.defaultBool,
          defaultText: row.defaultText,
          unit: row.unit,
          sortOrder: row.sortOrder,
        },
      });
      inserted++;
    }
  }
  console.log(`  • feature catalog: ${inserted} inserted, ${updated} refreshed`);
}

async function seedPlans() {
  for (const seed of planSeeds) {
    const existing = await controlDb.plan.findUnique({ where: { slug: seed.slug } });
    if (existing) {
      console.log(`  • plan "${seed.slug}" already exists — skipping`);
      continue;
    }
    const plan = await controlDb.plan.create({
      data: {
        slug: seed.slug,
        name: seed.name,
        description: seed.description,
        billingMode: seed.billingMode as BillingMode,
        stripePriceId: seed.stripePriceId,
        monthlyPriceCents: seed.monthlyPriceCents,
        // Both cadences, or a freshly seeded database comes up with NULL annual
        // pricing: the API reports hasStripeAnnualPrice false, the web clients
        // hide the yearly/monthly toggle, and the annual price libriant.com
        // advertises is unbuyable — with no error anywhere.
        stripeAnnualPriceId: seed.stripeAnnualPriceId ?? null,
        annualPriceCents: seed.annualPriceCents ?? null,
        currency: seed.currency,
        isPublic: seed.isPublic,
        sortOrder: seed.sortOrder,
      },
    });
    // Insert per-feature values for THIS plan.
    const rows = Object.entries(seed.features)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([key, value]) => ({
        planId: plan.id,
        featureKey: key,
        ...pickValueCols(value as number | boolean | string),
      }));
    if (rows.length > 0) {
      await controlDb.planFeatureValue.createMany({ data: rows });
    }
    console.log(`  • created plan "${plan.slug}" with ${rows.length} feature values`);
  }
}

/**
 * Quick sanity check: every feature key referenced in the seed plans must
 * exist in the catalog (which mirrors @libriant/shared). Fails the seed
 * loudly if we ever drift.
 */
function assertSeedConsistency() {
  const knownKeys = new Set((Object.values(FEATURES) as Array<{ key: string }>).map((f) => f.key));
  for (const p of planSeeds) {
    for (const k of Object.keys(p.features)) {
      if (!knownKeys.has(k as FeatureKey)) {
        throw new Error(
          `Plan "${p.slug}" references unknown feature "${k}". Add it to packages/shared/src/features.ts first.`,
        );
      }
    }
  }
}

async function main() {
  assertSeedConsistency();
  console.log('Seeding control-plane DB…');
  await controlDb.$transaction(async () => {
    await seedCells();
    await seedFeatureCatalog();
    await seedPlans();
  });

  // Quick sanity numbers
  const [cells, features, plans, values] = await Promise.all([
    controlDb.cell.count(),
    controlDb.planFeature.count(),
    controlDb.plan.count(),
    controlDb.planFeatureValue.count(),
  ]);
  console.log(
    `Seed complete: cells=${cells}, plan_features=${features}, plans=${plans}, plan_feature_values=${values}`,
  );
}

main()
  .catch(async (err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectControlDb();
  });
