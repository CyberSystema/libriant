/**
 * Billing modes a plan can use. `stripe` plans are self-serve via Stripe
 * subscriptions; `manual` plans are invoiced by Libriant directly and are
 * typical for on-premises / enterprise contracts.
 */
export const BILLING_MODES = ['stripe', 'manual'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

/**
 * System modes the platform (or a single tenant) can be put into. `normal`
 * is the default; the rest are administrative states triggered from
 * /admin/system-mode.
 */
export const SYSTEM_MODES = [
  'normal',
  'maintenance',
  'read_only',
  'out_of_order',
  'under_construction',
] as const;
export type SystemMode = (typeof SYSTEM_MODES)[number];
