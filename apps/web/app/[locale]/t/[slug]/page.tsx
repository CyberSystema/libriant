import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, CardHeader, EmptyState, PageHeader } from '@libriant/ui';
import { isLocale, createTranslator } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { api, type BillingSnapshot } from '@/lib/api';

/**
 * `GET /t/:slug/summary` — the five tile counts in one call.
 *
 * Declared here rather than imported from `@/lib/api` for the same reason
 * `BillingSnapshot` is declared there: this is the only consumer, and the
 * shape is the API's `TenantSummary` (apps/api/src/dashboard/dashboard.service.ts).
 */
type TenantSummary = {
  books: number;
  members: number;
  activeLoans: number;
  overdueLoans: number;
  queuedHolds: number;
  cachedForSeconds: number;
};

/**
 * Tenant home — at-a-glance counts plus the current billing snapshot.
 * Server-rendered so the page is usable the moment the layout finishes
 * auth-redirects.
 *
 * performance-11. THIS PAGE WAS THE FINDING. It used to define a `safeCount`
 * helper that called a cursor-paged LIST endpoint and returned
 * `res.items.length` — the page size, not a total — five times in parallel:
 *
 *     catalog/books?limit=1        members?limit=1
 *     loans?status=active&limit=100   loans?overdue=1&limit=100
 *     reservations?status=queued&limit=100
 *
 * THE NUMBERS WERE NOT THE NUMBERS. `limit=1` meant a 400,000-title catalogue
 * rendered its tile as "1" and a 100,000-member library rendered "1"; the three
 * `limit=100` tiles saturated at 100 (and the service clamps `limit` to 100
 * anyway, so asking for more would not have helped). Driven through this page
 * against a seeded library of 5,006 titles / 800 members / 400 active loans /
 * 150 overdue / 250 queued holds, the five tiles server-rendered as
 * 1 · 1 · 100 · 100 · 100. They now render 5006 · 800 · 400 · 150 · 250.
 *
 * ON COST, BE PRECISE — the finding's "two full scans of loans, 32,845 buffers
 * each" is STALE. performance-02 added the ordering indexes those list calls
 * needed, and re-measured on the audit's 400,000-title fixture the three
 * expensive-looking ones are now `Index Scan using loans_status_loanedAt_id_idx`
 * (52 buffers), `Index Only Scan using loans_status_dueAt_id_idx` (6) and
 * `Index Scan using books_sortTitle_idx` (11). What this replaces is therefore
 * five HTTP round trips and ~15 statements per render, not two table scans.
 *
 * One call now, to an endpoint that answers with real counts and caches them in
 * Redis for 30 s. Uncached that statement is 17,107 buffers — MORE than the
 * five list calls — so the cache is not a nicety, it is what makes this a cost
 * win as well as a correctness one, and the missing `books_active_idx` partial
 * index (13,333 of those 17,107) is what would make it unconditional. Both are
 * recorded with the remediation.
 *
 * The helper is gone on purpose: leaving a `safeCount` in the file is how the
 * next tile gets wired back to a page size.
 *
 * The API failure is still caught locally so a slow or down API degrades the
 * dashboard to "—" tiles rather than blanking the page — and note that on that
 * path `summary` is null, so the onboarding welcome (which is keyed on "zero
 * books AND zero members") is NOT shown to a library whose API simply did not
 * answer.
 */
export default async function TenantHome(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  async function safeSummary(): Promise<TenantSummary | null> {
    try {
      return await api<TenantSummary>(`/t/${params.slug}/summary`, { cookie });
    } catch {
      return null;
    }
  }

  async function safeBilling(): Promise<BillingSnapshot | null> {
    try {
      return await api<BillingSnapshot>(`/t/${params.slug}/billing`, { cookie });
    } catch {
      return null;
    }
  }

  const [summary, billing] = await Promise.all([safeSummary(), safeBilling()]);

  const books = tile(summary?.books);
  const members = tile(summary?.members);
  const activeLoans = tile(summary?.activeLoans);
  const overdueLoans = tile(summary?.overdueLoans);
  const queuedHolds = tile(summary?.queuedHolds);

  // Only a summary we actually received can say "this library is empty".
  const isEmpty = summary !== null && summary.books === 0 && summary.members === 0;
  const needsBooks = summary !== null && summary.books === 0;
  const needsMembers = summary !== null && summary.members === 0;
  const off = t('common.dashboard.offline');

  return (
    <>
      <PageHeader title={t('common.app.name')} subtitle={t('onboarding.welcome.subtitle')} />

      {billing && billing.billingEnabled && billing.status === 'past_due' ? (
        <Banner
          severity="warning"
          title={t('billing.retry.title')}
          style={{ marginBottom: 'var(--sp-4)' }}
        >
          {t('billing.retry.body', { date: fmtDate(billing.graceUntil) ?? '' })}{' '}
          <Link href={`/${params.locale}/t/${params.slug}/billing`}>{t('billing.retry.link')}</Link>
          .
        </Banner>
      ) : null}

      {isEmpty ? (
        <EmptyState
          illustration="illustrations/welcome"
          title={t('onboarding.welcome.title')}
          description={t('onboarding.welcome.subtitle')}
          action={
            <Link
              href={`/${params.locale}/t/${params.slug}/onboarding`}
              className="lbr-btn lbr-btn--primary lbr-btn--md"
            >
              {t('onboarding.welcome.start')}
            </Link>
          }
        />
      ) : needsBooks || needsMembers ? (
        <Banner
          severity="info"
          title={t('onboarding.nudge.title')}
          style={{ marginBottom: 'var(--sp-4)' }}
        >
          {needsBooks ? t('onboarding.nudge.bookMissing') : t('onboarding.nudge.memberMissing')}{' '}
          <Link href={`/${params.locale}/t/${params.slug}/onboarding`}>
            {t('onboarding.nudge.cta')}
          </Link>
        </Banner>
      ) : null}

      {!isEmpty ? (
        <section className="lbr-stat-grid" style={{ marginBottom: 'var(--sp-6)' }}>
          <Tile label={t('common.nav.catalog')} value={books} offline={off} />
          <Tile label={t('common.nav.members')} value={members} offline={off} />
          <Tile label={t('common.dashboard.activeLoans')} value={activeLoans} offline={off} />
          <Tile label={t('common.dashboard.overdueLoans')} value={overdueLoans} offline={off} />
          <Tile label={t('common.dashboard.queuedHolds')} value={queuedHolds} offline={off} />
        </section>
      ) : null}

      {/* The plan card is billing-only. When subscriptions are disabled the
          whole product is free, so there's no plan to manage — hide it
          entirely (the Billing page shows the "everything's included" notice
          for anyone who still navigates there). */}
      {billing?.billingEnabled === false ? null : (
        <Card>
          <CardHeader
            title={t('common.dashboard.currentPlan')}
            subtitle={t('common.dashboard.currentPlanSub')}
          />
          <CardBody>
            {billing ? (
              <>
                <p style={{ margin: '0 0 var(--sp-2) 0' }}>
                  <strong>{billing.plan.name}</strong> ·{' '}
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    {billing.billingMode === 'manual'
                      ? t('billing.billingMode.manual')
                      : t('billing.billingMode.stripe')}
                  </span>
                </p>
                <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
                  {t('billing.statusLabel')}: <strong>{billing.status}</strong>
                  {billing.currentPeriodEnd
                    ? ` · ${t('billing.renewsOn', { date: fmtDate(billing.currentPeriodEnd) ?? '' })}`
                    : null}
                  {billing.cancelAtPeriodEnd ? ` · ${t('billing.cancelScheduled')}` : null}
                </p>
                <p style={{ marginTop: 'var(--sp-3)' }}>
                  <Link href={`/${params.locale}/t/${params.slug}/billing`}>
                    {t('billing.manage')} →
                  </Link>
                </p>
              </>
            ) : (
              <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
                {t('billing.unreachable')}
              </p>
            )}
          </CardBody>
        </Card>
      )}
    </>
  );
}

/**
 * One tile's state, derived from the single summary call. `null` means the
 * summary did not arrive — every tile then reads "—" with the offline caption,
 * which is the same degradation the five separate calls used to give per tile.
 */
function tile(count: number | undefined): { count: number | null; error: boolean } {
  return count === undefined ? { count: null, error: true } : { count, error: false };
}

function Tile({
  label,
  value,
  offline,
}: {
  label: string;
  value: { count: number | null; error: boolean };
  offline: string;
}) {
  return (
    <Card>
      <div className="lbr-stat">
        <span className="lbr-stat__label">{label}</span>
        <span className="lbr-stat__value">
          {value.error ? '—' : value.count === null ? '—' : value.count.toString()}
        </span>
        {value.error ? <span className="lbr-stat__caption">{offline}</span> : null}
      </div>
    </Card>
  );
}

function fmtDate(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    return new Date(input).toLocaleDateString();
  } catch {
    return null;
  }
}
