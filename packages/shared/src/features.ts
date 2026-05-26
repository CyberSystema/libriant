/**
 * Catalog of every feature key the system understands.
 *
 * This file is the *menu of switches and limits* — never the values for a
 * specific plan. Plan values live in the control-plane DB and are managed
 * by the owner in the admin UI. To add a new gate or limit:
 *   1. add the key + type here
 *   2. seed it into `plan_features` and assign defaults
 *   3. enforce it in code via `@RequiresFeature` or `QuotaInterceptor`
 */

export type FeatureType = 'int' | 'bool' | 'text';

export type FeatureDescriptor = {
  key: string;
  type: FeatureType;
  /** Human-readable label shown in the admin UI. */
  label: string;
  /** Plain-language description of what this gate/limit controls. */
  description: string;
  /** Fallback if no plan or override sets the value. */
  default: number | boolean | string;
  /** For `int` features, whether the value is a quota count, MB, days, etc. */
  unit?: 'count' | 'mb' | 'days' | 'seats';
};

export const FEATURES = {
  max_books: {
    key: 'max_books',
    type: 'int',
    label: 'Maximum books',
    description: 'How many distinct books the library can have in its catalog.',
    default: 500,
    unit: 'count',
  },
  max_members: {
    key: 'max_members',
    type: 'int',
    label: 'Maximum members',
    description: 'How many members can be on file at once.',
    default: 100,
    unit: 'count',
  },
  max_storage_mb: {
    key: 'max_storage_mb',
    type: 'int',
    label: 'Maximum storage (MB)',
    description:
      'Total file storage available to the library for covers, photos, attachments, etc.',
    default: 100,
    unit: 'mb',
  },
  staff_seats: {
    key: 'staff_seats',
    type: 'int',
    label: 'Staff seats',
    description: 'How many staff users can log in to the library.',
    default: 1,
    unit: 'seats',
  },
  max_custom_collections: {
    key: 'max_custom_collections',
    type: 'int',
    label: 'Maximum custom collections',
    description: 'How many custom record types (e.g. DVDs, BoardGames) the library can define.',
    default: 0,
    unit: 'count',
  },
  max_records_per_collection: {
    key: 'max_records_per_collection',
    type: 'int',
    label: 'Max records per custom collection',
    description: 'Per-collection ceiling on records in custom collections.',
    default: 0,
    unit: 'count',
  },
  max_custom_fields_per_entity: {
    key: 'max_custom_fields_per_entity',
    type: 'int',
    label: 'Custom fields per entity',
    description: 'How many custom fields the library can add to books, members, loans, etc.',
    default: 3,
    unit: 'count',
  },
  reservations_enabled: {
    key: 'reservations_enabled',
    type: 'bool',
    label: 'Reservations',
    description: 'Allow members to reserve books that are currently checked out.',
    default: false,
  },
  isbn_lookup_enabled: {
    key: 'isbn_lookup_enabled',
    type: 'bool',
    label: 'ISBN lookup',
    description: 'Pre-fill book details by looking up the ISBN against OpenLibrary.',
    default: true,
  },
  bulk_import_enabled: {
    key: 'bulk_import_enabled',
    type: 'bool',
    label: 'Bulk import',
    description: 'Import books or members from a spreadsheet.',
    default: false,
  },
  email_notifications_enabled: {
    key: 'email_notifications_enabled',
    type: 'bool',
    label: 'Email notifications',
    description: 'Send overdue reminders and reservation-ready notices by email.',
    default: false,
  },
  audit_log_retention_days: {
    key: 'audit_log_retention_days',
    type: 'int',
    label: 'Audit log retention (days)',
    description: 'How long the library can look back through its own audit log.',
    default: 7,
    unit: 'days',
  },
  api_access_enabled: {
    key: 'api_access_enabled',
    type: 'bool',
    label: 'API access',
    description: 'Allow programmatic access to the library via the Libriant API.',
    default: false,
  },
  custom_subdomain_enabled: {
    key: 'custom_subdomain_enabled',
    type: 'bool',
    label: 'Custom subdomain',
    description:
      'Allow the library to be reached at its own subdomain in addition to the path URL.',
    default: false,
  },
  priority_support: {
    key: 'priority_support',
    type: 'bool',
    label: 'Priority support',
    description: 'Higher-tier response times from the Libriant team.',
    default: false,
  },
} as const satisfies Record<string, FeatureDescriptor>;

export type FeatureKey = keyof typeof FEATURES;

export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];

export function getFeature(key: FeatureKey): FeatureDescriptor {
  return FEATURES[key];
}
