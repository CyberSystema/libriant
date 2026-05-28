export type Severity = 'info' | 'warning' | 'critical';

export type Audience =
  | { kind: 'all' }
  | { kind: 'tenant_ids'; tenantIds: string[] }
  | { kind: 'plan_slugs'; planSlugs: string[] }
  | { kind: 'tags'; tags: string[] };

export type AnnouncementSummary = {
  id: string;
  title: string;
  severity: Severity;
  audience: Audience;
  deliverInApp: boolean;
  deliverEmail: boolean;
  publishAt: string | null;
  publishedAt: string | null;
  expiresAt: string | null;
  archivedAt: string | null;
  dismissible: boolean;
  requiresAck: boolean;
  createdAt: string;
  createdBy: { email: string; fullName: string };
  deliveryCount: number;
};

export type AnnouncementDetail = AnnouncementSummary & {
  bodyMarkdown: string;
};

export type AnnouncementStats = {
  targetTenantCount: number;
  deliveryCount: number;
  deliveredInAppCount: number;
  deliveredEmailCount: number;
  dismissedCount: number;
  acknowledgedCount: number;
};

export type AudienceJson =
  | { all: true }
  | { tenant_ids: string[] }
  | { plan_slugs: string[] }
  | { tags: string[] };

export function audienceToJson(a: Audience): AudienceJson {
  switch (a.kind) {
    case 'all':
      return { all: true };
    case 'tenant_ids':
      return { tenant_ids: a.tenantIds };
    case 'plan_slugs':
      return { plan_slugs: a.planSlugs };
    case 'tags':
      return { tags: a.tags };
  }
}

export function describeAudience(a: Audience): string {
  switch (a.kind) {
    case 'all':
      return 'All active libraries';
    case 'tenant_ids':
      return `${a.tenantIds.length} specific librar${a.tenantIds.length === 1 ? 'y' : 'ies'}`;
    case 'plan_slugs':
      return `Libraries on plan: ${a.planSlugs.join(', ')}`;
    case 'tags':
      return `Libraries tagged: ${a.tags.join(', ')}`;
  }
}

export function severityLabel(s: Severity): string {
  return s === 'critical' ? 'Critical' : s === 'warning' ? 'Warning' : 'Info';
}

export function announcementStatus(a: AnnouncementSummary, now = new Date()): string {
  if (a.archivedAt) return 'archived';
  if (a.expiresAt && new Date(a.expiresAt) <= now) return 'expired';
  if (!a.publishedAt) return 'scheduled';
  return 'active';
}
