import Link from 'next/link';
import { Banner, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { notFound } from 'next/navigation';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';
import { MembersTable, type MemberRow } from './MembersTable';

type ListResponse<T> = { items: T[]; nextCursor: string | null };

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
  const status = searchParams.status;
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (status) qs.set('status', status);
  qs.set('limit', '25');

  let initial: ListResponse<MemberRow>;
  let fetchError: string | null = null;
  try {
    initial = await api<ListResponse<MemberRow>>(`/t/${params.slug}/members?${qs.toString()}`, {
      cookie,
    });
  } catch (err) {
    initial = { items: [], nextCursor: null };
    fetchError = err instanceof ApiError ? err.message : t('common.states.error');
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
