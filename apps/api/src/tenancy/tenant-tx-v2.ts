import type { TenantPrismaClientV2 } from '@libriant/db-tenant';

/**
 * The client Prisma hands an interactive transaction on the 2.0 datamodel.
 *
 * Structurally the full client minus the connection-lifecycle methods, and NOT
 * assignable to `TenantPrismaClientV2` — so a helper that must work both inside
 * and outside a transaction takes this narrower type.
 *
 * It lives in its own file because phase 11a gave it a second user. Two copies
 * of an `Omit<...>` list is one place for them to disagree, and the symptom of
 * disagreement would be a helper that silently cannot be called from inside a
 * transaction — which is the only place these helpers are ever correct.
 */
export type TxV2 = Omit<
  TenantPrismaClientV2,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
