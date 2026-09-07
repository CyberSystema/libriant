export { makeTenantPrismaClient, disconnectTenantClient } from './client.js';
export type { TenantPrismaClient, MakeTenantClientOptions } from './client.js';
export { V2_SCHEMA, withV2Schema } from './v2.js';

// Re-export generated types so consumers import everything from
// `@libriant/db-tenant`.
export {
  Prisma,
  PrismaClient,
  // Enums
  BookCopyStatus,
  MemberStatus,
  LoanStatus,
  ReservationStatus,
  FineStatus,
  AuditActorType,
  FieldEntityKind,
  FieldType,
} from '../node_modules/.prisma/tenant-client/index.js';

export type {
  TenantSetting,
  Author,
  Book,
  BookAuthor,
  BookCopy,
  Member,
  Loan,
  Reservation,
  Fine,
  FieldDefinition,
  Collection,
  CollectionField,
  CollectionRecord,
  AuditEvent,
} from '../node_modules/.prisma/tenant-client/index.js';
export { reconcileSystemRoles, type ReconcileResult } from './system-roles.js';
export {
  DEFAULT_TENANT_SETTINGS,
  describeSeedResult,
  seedTenantDefaults,
  seedTenantSettings,
  type SeedTenantResult,
} from './tenant-defaults.js';
