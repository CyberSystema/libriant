import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { currentSession, requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import type { FieldDef } from '@/components/DynamicFields';
import type { FinesListResponse } from '@/components/FinesPanel';
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
    /**
     * The amount alone cannot answer "is there anything to settle?" — €0.00
     * across two fines and no fines at all are the same number — so the count
     * is what decides whether the desk is offered a settle action.
     */
    outstandingFinesCount: number;
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
    fetchError = translateApiError(err, t, t('common.states.error'));
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

  // What the member owes, rendered by the desk before JS hydrates. Outstanding
  // only: that is the question being asked at the counter, and the panel loads
  // the settled history on demand for when a member disputes a charge.
  //
  // A failure here is NOT silently swallowed the way the custom fields are. An
  // empty fines card and a fines card we could not load look identical, and one
  // of them tells a librarian a member owes nothing when they may owe €12.
  let fines: FinesListResponse | null = null;
  let finesError: string | null = null;
  try {
    fines = await api<FinesListResponse>(
      `/t/${params.slug}/fines?memberId=${encodeURIComponent(params.id)}&status=outstanding&limit=25`,
      { cookie },
    );
  } catch (err) {
    finesError = translateApiError(err, t, t('loans.fines.loadFailed'));
  }

  // Who may do what. The API is the enforcement (StaffWrite for a payment,
  // owner/admin for a write-off); this only keeps a volunteer from being shown
  // a button that would 403 in their face. An impersonating Libriant admin has
  // no tenant session and is treated as owner, exactly as the tenant layout
  // already resolves them to get this far.
  const session = await currentSession().catch(() => null);
  const role = session?.user.role ?? 'owner';
  const canSettle = role === 'owner' || role === 'admin' || role === 'librarian';
  const canWriteOff = role === 'owner' || role === 'admin';
  // privacy-legal-15: same three roles as a payment, and for the same reason —
  // the volunteer role reads the desk's screens but does not hand a copy of
  // somebody's whole record to whoever asked for it. `@Roles` on
  // SubjectAccessController is the enforcement; this only keeps the button out
  // of a volunteer's face.
  const canExportSubjectData = canSettle;

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
        fines={fines}
        finesError={finesError}
        canSettleFines={canSettle}
        canWriteOffFines={canWriteOff}
        canExportSubjectData={canExportSubjectData}
      />
    </>
  );
}
