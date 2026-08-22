/**
 * Seed-data declarations for the control-plane DB.
 *
 * These are STARTER values, not source-of-truth — the owner reshapes them
 * in the admin UI after launch. Seed inserts only happen when the target
 * tables are empty, so re-running is safe.
 *
 * Keep this file declarative: only constants. The seed script in
 * prisma/seed.ts handles the SQL.
 */
import { FEATURES, type FeatureDescriptor, type FeatureKey } from '@libriant/shared';

/**
 * Mirror the catalog from @libriant/shared/features.ts into the control DB.
 * This lets the admin UI render the editor without having to import the TS
 * module — the source of truth on disk is still `features.ts`.
 *
 * The explicit `FeatureDescriptor[]` cast is needed because `as const satisfies`
 * narrows `FEATURES` to a const-tuple of distinct literal shapes; `Object.values`
 * on that loses the common-shape inference.
 */
const FEATURE_LIST: ReadonlyArray<FeatureDescriptor> = Object.values(
  FEATURES,
) as ReadonlyArray<FeatureDescriptor>;

export const featureRows = FEATURE_LIST.map((f, i) => ({
  key: f.key as FeatureKey,
  type: (f.type === 'int' ? 'integer' : f.type === 'bool' ? 'boolean' : 'text') as
    'integer' | 'boolean' | 'text',
  label: f.label,
  description: f.description,
  defaultInt: typeof f.default === 'number' ? f.default : null,
  defaultBool: typeof f.default === 'boolean' ? f.default : null,
  defaultText: typeof f.default === 'string' ? f.default : null,
  unit: f.unit ?? null,
  sortOrder: i,
}));

export const defaultCell = {
  id: 'cell-eu-1',
  slug: 'eu-1',
  name: 'EU – Cell 1',
  region: 'eu-central',
  acceptsNew: true,
};

/**
 * The five illustrative starter plans the owner can reshape in the admin UI.
 * Values match the table in the approved plan. Stripe price IDs are
 * placeholders — replace with real ones in the dashboard after launch.
 */
type PlanSeed = {
  slug: string;
  name: string;
  description: string;
  billingMode: 'stripe' | 'manual';
  stripePriceId: string | null;
  monthlyPriceCents: number;
  /** Stripe Price ID for the annual cadence; null when not offered annually. */
  stripeAnnualPriceId?: string | null;
  /** Ten months for twelve. Null means monthly-only. */
  annualPriceCents?: number | null;
  currency: string;
  isPublic: boolean;
  sortOrder: number;
  // Feature values for THIS plan. Use `null` to inherit the catalog default.
  features: Partial<Record<FeatureKey, number | boolean | string | null>>;
};

export const planSeeds: PlanSeed[] = [
  {
    slug: 'starter',
    name: 'Starter',
    description:
      'Free. Sized for a Greek school library — roughly 2,000-6,000 items — or a very small community collection.',
    billingMode: 'stripe',
    stripePriceId: 'price_seed_starter',
    monthlyPriceCents: 0,
    stripeAnnualPriceId: null,
    annualPriceCents: null,
    currency: 'EUR',
    isPublic: true,
    sortOrder: 10,
    features: {
      max_books: 5_000,
      max_members: 1_500,
      max_storage_mb: 512,
      staff_seats: 3,
      max_custom_collections: 0,
      max_records_per_collection: 0,
      max_custom_fields_per_entity: 5,
      reservations_enabled: false,
      isbn_lookup_enabled: true,
      bulk_import_enabled: false,
      email_notifications_enabled: false,
      audit_log_retention_days: 7,
      api_access_enabled: false,
      custom_subdomain_enabled: false,
      priority_support: false,
    },
  },
  {
    slug: 'community',
    name: 'Community',
    description: 'A small municipal, community or specialist library. Around 20,000 titles.',
    billingMode: 'stripe',
    stripePriceId: 'price_seed_community',
    monthlyPriceCents: 3900,
    stripeAnnualPriceId: 'price_seed_community_annual',
    annualPriceCents: 39000,
    currency: 'EUR',
    isPublic: true,
    sortOrder: 20,
    features: {
      max_books: 20_000,
      max_members: 5_000,
      max_storage_mb: 2_048,
      staff_seats: 10,
      max_custom_collections: 1,
      max_records_per_collection: 1_000,
      max_custom_fields_per_entity: 15,
      reservations_enabled: true,
      isbn_lookup_enabled: true,
      bulk_import_enabled: true,
      email_notifications_enabled: true,
      audit_log_retention_days: 90,
      api_access_enabled: false,
      custom_subdomain_enabled: false,
      priority_support: false,
    },
  },
  {
    slug: 'municipal',
    name: 'Municipal',
    description:
      'A working municipal library. 60,000 titles covers the median Greek public library.',
    billingMode: 'stripe',
    stripePriceId: 'price_seed_municipal',
    monthlyPriceCents: 7900,
    stripeAnnualPriceId: 'price_seed_municipal_annual',
    annualPriceCents: 79000,
    currency: 'EUR',
    isPublic: true,
    sortOrder: 30,
    features: {
      max_books: 60_000,
      max_members: 15_000,
      max_storage_mb: 10_240,
      staff_seats: 25,
      max_custom_collections: 5,
      max_records_per_collection: 25_000,
      max_custom_fields_per_entity: 30,
      reservations_enabled: true,
      isbn_lookup_enabled: true,
      bulk_import_enabled: true,
      email_notifications_enabled: true,
      audit_log_retention_days: 365,
      api_access_enabled: true,
      custom_subdomain_enabled: false,
      priority_support: false,
    },
  },
  {
    slug: 'central',
    name: 'Central',
    description:
      'A large or central municipal library, or a δημόσια βιβλιοθήκη. Up to 150,000 titles.',
    billingMode: 'stripe',
    stripePriceId: 'price_seed_central',
    monthlyPriceCents: 11900,
    stripeAnnualPriceId: 'price_seed_central_annual',
    annualPriceCents: 119000,
    currency: 'EUR',
    isPublic: true,
    sortOrder: 35,
    features: {
      max_books: 150_000,
      max_members: 40_000,
      max_storage_mb: 25_600,
      staff_seats: 60,
      max_custom_collections: 10,
      max_records_per_collection: 100_000,
      max_custom_fields_per_entity: 60,
      reservations_enabled: true,
      isbn_lookup_enabled: true,
      bulk_import_enabled: true,
      email_notifications_enabled: true,
      audit_log_retention_days: 1_095,
      api_access_enabled: true,
      custom_subdomain_enabled: false,
      priority_support: true,
    },
  },
  {
    slug: 'institutional',
    name: 'Institutional',
    description: 'An academic library or a very large public collection. Up to 400,000 titles.',
    billingMode: 'stripe',
    stripePriceId: 'price_seed_institutional',
    monthlyPriceCents: 18900,
    stripeAnnualPriceId: 'price_seed_institutional_annual',
    annualPriceCents: 189000,
    currency: 'EUR',
    isPublic: true,
    sortOrder: 40,
    features: {
      max_books: 400_000,
      max_members: 100_000,
      max_storage_mb: 102_400,
      staff_seats: 150,
      max_custom_collections: 20,
      max_records_per_collection: 250_000,
      max_custom_fields_per_entity: 120,
      reservations_enabled: true,
      isbn_lookup_enabled: true,
      bulk_import_enabled: true,
      email_notifications_enabled: true,
      audit_log_retention_days: 3_650,
      api_access_enabled: true,
      custom_subdomain_enabled: true,
      priority_support: true,
    },
  },
  {
    slug: 'on-prem-enterprise',
    name: 'On-prem / Enterprise',
    description:
      'Contract-priced. Manual invoicing. No predefined caps — set per tenant via overrides.',
    billingMode: 'manual',
    stripePriceId: null,
    monthlyPriceCents: 0,
    stripeAnnualPriceId: null,
    annualPriceCents: null,
    currency: 'EUR',
    isPublic: false,
    sortOrder: 99,
    features: {
      max_books: 1_000_000_000,
      max_members: 1_000_000_000,
      max_storage_mb: 1_000_000_000,
      staff_seats: 1_000_000_000,
      max_custom_collections: 1_000_000_000,
      max_records_per_collection: 1_000_000_000,
      max_custom_fields_per_entity: 1_000_000_000,
      reservations_enabled: true,
      isbn_lookup_enabled: true,
      bulk_import_enabled: true,
      email_notifications_enabled: true,
      audit_log_retention_days: 1_000_000_000,
      api_access_enabled: true,
      custom_subdomain_enabled: true,
      priority_support: true,
    },
  },
];
