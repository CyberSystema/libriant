'use client';
import * as React from 'react';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { DataTable, type Column } from '@/components/DataTable';

export type AuditRow = {
  id: string;
  occurredAt: string;
  action: string;
  actorType: 'user' | 'admin' | 'system';
  actorLabel: string | null;
  targetType: string | null;
  targetId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  viaSupport: boolean;
};

/** Actions we ship friendly labels for; anything else is humanized inline. */
const KNOWN_ACTIONS = new Set([
  'member.created',
  'member.updated',
  'member.status_changed',
  'member.archived',
  'loan.checked_out',
  'loan.returned',
  'loan.renewed',
  'loan.marked_lost',
  'settings.updated',
]);

function fmtVal(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function AuditLog({
  slug,
  locale,
  catalog,
  initial,
}: {
  slug: string;
  locale: Locale;
  catalog: Catalog;
  initial: { items: AuditRow[]; nextCursor: string | null };
}) {
  const t = createTranslator(catalog, locale);

  const actionLabel = (action: string) =>
    KNOWN_ACTIONS.has(action)
      ? t(`settings.activity.actions.${action}`)
      : action.replace(/[._]/g, ' ');

  const renderDiff = (row: AuditRow) => {
    const before = row.before ?? {};
    const after = row.after ?? {};
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
    const changed = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (!changed.length) return <span style={{ color: 'var(--color-text-muted)' }}>—</span>;
    return (
      <div style={{ fontSize: 'var(--fs-xs)', display: 'grid', gap: 2 }}>
        {changed.map((k) => (
          <div key={k}>
            <code>{k}</code>: {fmtVal(before[k])}{' '}
            <span style={{ color: 'var(--color-text-muted)' }}>→</span> {fmtVal(after[k])}
          </div>
        ))}
      </div>
    );
  };

  const columns: Column<AuditRow>[] = [
    {
      key: 'occurredAt',
      header: t('settings.activity.cols.when'),
      render: (r) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          {new Date(r.occurredAt).toLocaleString(locale)}
        </span>
      ),
    },
    {
      key: 'actor',
      header: t('settings.activity.cols.who'),
      render: (r) => (
        <div>
          <div>
            {r.actorLabel ??
              (r.actorType === 'system'
                ? t('settings.activity.actor.system')
                : t('settings.activity.actor.unknown'))}
          </div>
          {r.viaSupport ? (
            <div style={{ color: 'var(--color-warning-text)', fontSize: 'var(--fs-xs)' }}>
              {t('settings.activity.viaSupport')}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'action',
      header: t('settings.activity.cols.what'),
      render: (r) => <span style={{ fontWeight: 500 }}>{actionLabel(r.action)}</span>,
    },
    {
      key: 'target',
      header: t('settings.activity.cols.target'),
      render: (r) =>
        r.targetType ? (
          <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
            {r.targetType}
            {r.targetId ? ` · ${r.targetId.slice(0, 8)}` : ''}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'changes',
      header: t('settings.activity.cols.changes'),
      render: renderDiff,
    },
  ];

  return (
    <DataTable<AuditRow>
      endpoint={`/t/${slug}/audit`}
      initial={initial}
      columns={columns}
      emptyTitle={t('settings.activity.empty.title')}
      emptyDescription={t('settings.activity.empty.description')}
      emptyIllustration="illustrations/empty-catalog"
      loadMoreLabel={t('common.actions.loadMore')}
    />
  );
}
