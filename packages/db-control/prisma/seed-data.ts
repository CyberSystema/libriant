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
    | 'integer'
    | 'boolean'
    | 'text',
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
    description: 'Free tier for evaluation and tiny libraries.',
    billingMode: 'stripe',
    stripePriceId: 'price_seed_starter',
    monthlyPriceCents: 0,
    currency: 'EUR',
    isPublic: true,
    sortOrder: 10,
    features: {
      max_books: 500,
      max_members: 100,
      max_storage_mb: 100,
      staff_seats: 1,
      max_custom_collections: 0,
      max_records_per_collection: 0,
      max_custom_fields_per_entity: 3,
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
    description: 'Small public or community libraries.',
    billingMode: 'stripe',
    stripePriceId: 'price_seed_community',
    monthlyPriceCents: 1900,
    currency: 'EUR',
    isPublic: true,
    sortOrder: 20,
    features: {
      max_books: 5_000,
      max_members: 1_000,
      max_storage_mb: 1_024,
      staff_seats: 3,
      max_custom_collections: 1,
      max_records_per_collection: 1_000,
      max_custom_fields_per_entity: 10,
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
    description: 'Medium-sized municipal libraries.',
    billingMode: 'stripe',
    stripePriceId: 'price_seed_municipal',
    monthlyPriceCents: 7900,
    currency: 'EUR',
    isPublic: true,
    sortOrder: 30,
    features: {
      max_books: 30_000,
      max_members: 7_500,
      max_storage_mb: 10_240,
      staff_seats: 10,
      max_custom_collections: 5,
      max_records_per_collection: 25_000,
      max_custom_fields_per_entity: 25,
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
    slug: 'institutional',
    name: 'Institutional',
    description: 'Academic and large public libraries.',
    billingMode: 'stripe',
    stripePriceId: 'price_seed_institutional',
    monthlyPriceCents: 24900,
    currency: 'EUR',
    isPublic: true,
    sortOrder: 40,
    features: {
      max_books: 200_000,
      max_members: 50_000,
      max_storage_mb: 51_200,
      staff_seats: 30,
      max_custom_collections: 20,
      max_records_per_collection: 250_000,
      max_custom_fields_per_entity: 60,
      reservations_enabled: true,
      isbn_lookup_enabled: true,
      bulk_import_enabled: true,
      email_notifications_enabled: true,
      audit_log_retention_days: 3650,
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
    currency: 'EUR',
    isPublic: false,
    sortOrder: 99,
    features: {
      // We use the very-large-cap "effectively unlimited" pattern of 1B for
      // numeric caps so SQL stays simple; bools are all true.
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
