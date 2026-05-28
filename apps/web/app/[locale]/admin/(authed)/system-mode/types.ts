export type SystemModeKind =
  | 'normal'
  | 'maintenance'
  | 'read_only'
  | 'out_of_order'
  | 'under_construction';

export type SystemModeScope = 'global' | 'tenant';

export type AdminEventRow = {
  id: string;
  scope: SystemModeScope;
  tenant: { id: string; slug: string; name: string } | null;
  mode: SystemModeKind;
  messageMarkdown: string | null;
  startsAt: string;
  endsAt: string | null;
  endedAt?: string | null;
  allowAdminBypass: boolean;
  createdBy: { email: string; fullName: string };
};

export type ResolvedSystemMode = {
  mode: SystemModeKind;
  source: 'global' | 'tenant' | 'default';
  eventId: string | null;
  messageMarkdown: string | null;
  startsAt: string | null;
  endsAt: string | null;
  allowAdminBypass: boolean;
};

export const MODE_LABEL: Record<SystemModeKind, string> = {
  normal: 'Normal',
  maintenance: 'Maintenance',
  read_only: 'Read-only',
  out_of_order: 'Out of order',
  under_construction: 'Under construction',
};

export const MODE_DESCRIPTION: Record<Exclude<SystemModeKind, 'normal'>, string> = {
  maintenance: 'Full takeover page. Only admin + healthz + impersonating staff get through.',
  read_only: 'App stays reachable. POST/PATCH/PUT/DELETE return 503 until exited.',
  out_of_order: 'Same enforcement as maintenance, different branding (emergency outage).',
  under_construction: 'No blocking. Renders a persistent banner across the tenant UI.',
};
