import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { api } from '@/lib/api';
import type { FieldDef } from '@/components/DynamicFields';
import { MemberForm } from './MemberForm';

export const dynamic = 'force-dynamic';

type FieldsResponse = { entityKind: string; fields: FieldDef[] };

export default async function NewMemberPage({
  params,
}: {
  params: { locale: string; slug: string };
}) {
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  // Pull active custom fields server-side so the form renders without a
  // hydration flash. Failure is non-fatal — we still let the librarian add
  // the basic fields.
  let customFields: FieldDef[] = [];
  try {
    const res = await api<FieldsResponse>(`/t/${params.slug}/data-model/fields/member`, {
      cookie,
    });
    customFields = res.fields;
  } catch {
    customFields = [];
  }

  return (
    <>
      <PageHeader
        title={t('members.form.title')}
        subtitle={t('members.form.subtitle')}
        trail={
          <Link href={`/${params.locale}/t/${params.slug}/members`} style={{ color: 'inherit' }}>
            ← {t('members.title')}
          </Link>
        }
      />
      <div style={{ maxWidth: 720 }}>
        <MemberForm
          slug={params.slug}
          catalog={catalog}
          locale={params.locale}
          customFields={customFields}
        />
      </div>
    </>
  );
}
