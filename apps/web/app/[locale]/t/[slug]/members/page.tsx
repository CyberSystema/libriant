import Link from 'next/link';
import { Banner, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { notFound } from 'next/navigation';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { dataPort } from '@/lib/ports';
import { translateApiError } from '@/lib/api-errors';
import { MembersTable, type PatronRow } from './MembersTable';

type ListResponse<T> = { items: T[]; nextCursor: string | null; minQueryChars?: number };

/**
 * The statuses `ListPatronsQueryDto` will accept. Mirrored here rather than
 * imported: the DTO lives in the API and the web app does not depend on it.
 */
const ROSTER_STATUSES = ['active', 'suspended', 'closed'];

export default async function MembersPage(props: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  const q = searchParams.q?.trim();
  /**
   * FILTERED against the 2.0 enum before it is forwarded.
   *
   * 1.0 accepted `archived` as a status and passed whatever arrived straight
   * through. 2.0's roster statuses are `active | suspended | closed` — archived
   * became a timestamp — and `validateDto` runs `forbidNonWhitelisted`, so a
   * bookmarked or hand-typed `?status=archived` that worked yesterday is a 400
   * and an error banner today. Dropping an unknown value shows the unfiltered
   * roster instead, which is the answer a stale link should get.
   */
  const status = ROSTER_STATUSES.includes(searchParams.status ?? '')
    ? searchParams.status
    : undefined;
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (status) qs.set('status', status);
  qs.set('limit', '25');

  let initial: ListResponse<PatronRow>;
  let fetchError: string | null = null;
  try {
    initial = await dataPort().get<ListResponse<PatronRow>>(
      `/t/${params.slug}/patrons?${qs.toString()}`,
      { cookie },
    );
  } catch (err) {
    initial = { items: [], nextCursor: null };
    fetchError = translateApiError(err, t, t('common.states.error'));
  }

  return (
    <>
      <PageHeader
        title={t('members.title')}
        subtitle={t('members.subtitle')}
        actions={
          <Link
            href={`/${params.locale}/t/${params.slug}/members/new`}
            className="lbr-btn lbr-btn--primary lbr-btn--md"
          >
            {t('members.addMember')}
          </Link>
        }
      />
      {fetchError ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {fetchError}
        </Banner>
      ) : null}
      <MembersTable
        catalog={catalog}
        locale={params.locale}
        slug={params.slug}
        status={status}
        initial={initial}
      />
    </>
  );
}
