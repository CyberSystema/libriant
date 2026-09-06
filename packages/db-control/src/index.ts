export { controlDb, disconnectControlDb } from './client.js';

// Per-tenant runtime database credentials (tenant-isolation-02/03). Exported
// from the barrel rather than a subpath because the API, the provisioning
// service and four scripts all need the same naming and sealing rules, and a
// second copy of "what a tenant's role is called" is how a rotation renames a
// role nothing connects as.
export {
  ROLE_SLOTS,
  composeRuntimeUrl,
  newRuntimePassword,
  openTenantPassword,
  otherSlot,
  parseTenantDbMasterKey,
  redactDbUrl,
  sameEndpointAndDatabase,
  sealTenantPassword,
  sealedEquals,
  slotOfRole,
  tenantLoginRole,
  tenantPrivilegeRole,
  tenantRoleNames,
} from './tenant-db-credentials.js';
export type { RoleSlot, SealedPassword, SealedPasswordRow } from './tenant-db-credentials.js';
export {
  DEFAULT_ROLE_LIMITS,
  applyTenantRoleGrants,
  describeTenantRoles,
  dropTenantRoles,
  ensureTenantRoles,
  retireTenantLoginRole,
} from './tenant-db-roles.js';
export type { TenantRoleLimits } from './tenant-db-roles.js';

// Re-export the generated Prisma types so consumers can import everything
// from `@libriant/db-control` without dipping into @prisma/client directly.
export {
  Prisma,
  PrismaClient,
  // Enums
  TenantStatus,
  UserRole,
  UserStatus,
  AdminRole,
  AdminStatus,
  FeatureType,
  BillingMode,
  SubscriptionStatus,
  SupportKeyStatus,
  SupportSessionEndReason,
  AnnouncementSeverity,
  SystemModeKind,
  SystemModeScope,
  AuditActorType,
  EmailOutboxStatus,
  EmailMessageKind,
  ImportEntityKind,
  ImportSourceFormat,
  ImportStatus,
  ImportDuplicateMode,
  MaintenanceKind,
  MaintenanceScope,
  MaintenanceStatus,
  ExportFormat,
  ExportScope,
  ExportStatus,
  ExportRequesterKind,
  LibraryType,
  LibraryEditRequestStatus,
  ApplicationStatus,
} from '@prisma/client';

export type {
  Cell,
  Tenant,
  TenantDbCredential,
  User,
  PlanFeature,
  Plan,
  PlanFeatureValue,
  TenantPlanOverride,
  Subscription,
  BillingAccount,
  StripeWebhookEvent,
  AdminUser,
  SupportKey,
  SupportSession,
  SupportActionLog,
  SupportRedemptionAttempt,
  AuditEvent,
  Announcement,
  AnnouncementDelivery,
  SystemModeEvent,
  EmailOutbox,
  ImportBatch,
  ImportRowIssue,
  PlatformSetting,
  MaintenanceRun,
  ExportJob,
  LibraryEditRequest,
  Application,
} from '@prisma/client';
