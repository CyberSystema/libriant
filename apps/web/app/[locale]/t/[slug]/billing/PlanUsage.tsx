import * as React from 'react';
import { Card, CardBody, CardHeader } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';

/** One line of `GET /t/:slug/plan/usage`. */
export type UsageRow = {
  feature: string;
  limit: number;
  used: number | null;
  /** The API says so; never infer it by comparing `limit` to a large number. */
  unlimited: boolean;
  unit: string | null;
  source: string;
};

export type PlanUsageResponse = {
  plan: { id: string; slug: string; name: string } | null;
  usage: UsageRow[];
};

/** Amber from four fifths of the way up, red once the cap refuses. */
function barColor(ratio: number): string {
  if (ratio >= 1) return 'var(--color-danger)';
  if (ratio >= 0.8) return 'var(--color-warning)';
  return 'var(--color-primary)';
}

/**
 * launch-readiness-17 — the screen a librarian could not reach.
 *
 * `GET /t/:slug/plan/usage` existed all along and 404'd in production, so
 * nothing in the product ever showed a library how much of its plan it had
 * spent. The first number a librarian saw was the one in the 402, halfway
 * through accessioning a delivery. This is the endpoint's client; without it
 * the API change is an endpoint nobody calls.
 *
 * Rendered on the plan page because that is where someone sent away by a cap
 * arrives ("Upgrade your plan to add more") and where the upgrade lives. That
 * page redirects to the library home while subscriptions are switched off, so
 * the card is only ever reached once there are real caps to show — which is
 * also the moment the numbers start to matter.
 *
 * The row labels come from `errors.feature.*` — the same strings the 402 is
 * worded with, in both languages — so the line a librarian reads here and the
 * refusal they read later name the same thing.
 */
export function PlanUsage({
  usage,
  catalog,
  locale,
}: {
  usage: UsageRow[];
  catalog: Catalog;
  locale: Locale;
}) {
  const t = createTranslator(catalog, locale);
  const fmt = (n: number) => n.toLocaleString(locale);
  // Nothing measurable (no counters resolved, or the plan carries no int
  // limits) — render nothing rather than an empty card that reads as "zero".
  //
  // A limit of 0 with nothing used is dropped for the same reason: Starter's
  // `max_custom_collections` is 0, and rendered it read «προσαρμοσμένες
  // συλλογές 0 / 0» — a line that looks like a broken counter and tells a
  // librarian nothing about a feature their plan simply does not include. A
  // library that DOES hold three collections on such a plan still gets its
  // line, in red, because that one is the whole point of the card.
  const rows = usage.filter((r) => r.used !== null && !(r.limit <= 0 && r.used === 0));
  if (!rows.length) return null;

  return (
    <Card style={{ marginTop: 'var(--sp-4)' }}>
      <CardHeader title={t('billing.usage')} />
      <CardBody>
        <dl
          style={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'minmax(8rem, auto) 1fr',
            gap: 'var(--sp-3) var(--sp-5)',
            alignItems: 'center',
            fontSize: 'var(--fs-sm)',
          }}
        >
          {rows.map((row) => {
            const used = row.used ?? 0;
            const ratio = row.unlimited || row.limit <= 0 ? 0 : used / row.limit;
            return (
              <React.Fragment key={row.feature}>
                <dt style={{ color: 'var(--color-text-muted)' }}>
                  {t(`errors.feature.${row.feature}`)}
                </dt>
                <dd style={{ margin: 0 }}>
                  <div>
                    <strong>{fmt(used)}</strong>
                    {' / '}
                    {/* The unlimited limit is Number.MAX_SAFE_INTEGER, which
                        would render as 9.007.199.254.740.991 — a number that
                        tells a librarian nothing. */}
                    {row.unlimited ? '∞' : fmt(row.limit)}
                  </div>
                  {row.unlimited ? null : (
                    <div
                      style={{
                        marginTop: 'var(--sp-1)',
                        height: '0.375rem',
                        borderRadius: '999px',
                        background: 'var(--color-surface-muted)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.min(100, Math.round(ratio * 100))}%`,
                          height: '100%',
                          background: barColor(ratio),
                        }}
                      />
                    </div>
                  )}
                </dd>
              </React.Fragment>
            );
          })}
        </dl>
      </CardBody>
    </Card>
  );
}
