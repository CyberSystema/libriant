import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';
import type { FieldDef } from '@/components/DynamicFields';
import type { MemberInitial } from '../new/MemberForm';
import { MemberDetail } from './MemberDetail';

export const dynamic = 'force-dynamic';

type FieldsResponse = { entityKind: string; fields: FieldDef[] };

type MemberWithCirculation = MemberInitial & {
  status: 'active' | 'suspended' | 'archived';
  archivedAt: string | null;
  photoAssetRef: string | null;
  staffNotes: string | null;
  joinedAt: string;
  circulation: {
    activeLoans: number;
    activeReservations: number;
    outstandingFinesCents: number;
  };
};

export default async function MemberDetailPage(props: {
  params: Promise<{ locale: string; slug: string; id: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  let member: MemberWithCirculation | null = null;
  let fetchError: string | null = null;
  try {
    member = await api<MemberWithCirculation>(`/t/${params.slug}/members/${params.id}`, {
      cookie,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    fetchError = err instanceof ApiError ? err.message : t('common.states.error');
  }

  let customFields: FieldDef[] = [];
  try {
    const res = await api<FieldsResponse>(`/t/${params.slug}/data-model/fields/member`, {
      cookie,
    });
    customFields = res.fields;
  } catch {
    customFields = [];
  }

  if (!member) {
    return (
      <>
        <PageHeader title={t('members.title')} />
        <Banner severity="critical">{fetchError ?? t('common.states.error')}</Banner>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={member.fullName}
        subtitle={member.memberNumber}
        trail={
          <Link href={`/${params.locale}/t/${params.slug}/members`} style={{ color: 'inherit' }}>
            ← {t('members.title')}
          </Link>
        }
      />
      <MemberDetail
        slug={params.slug}
        catalog={catalog}
        locale={params.locale}
        initial={member}
        customFields={customFields}
      />
    </>
  );
}
