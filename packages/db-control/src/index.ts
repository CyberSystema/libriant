export { controlDb, disconnectControlDb } from './client';

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
} from '@prisma/client';
