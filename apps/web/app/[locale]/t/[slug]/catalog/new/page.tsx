import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { api } from '@/lib/api';
import type { FieldDef } from '@/components/DynamicFields';
import { BookForm } from './BookForm';

export const dynamic = 'force-dynamic';

type FieldsResponse = { entityKind: string; fields: FieldDef[] };

export default async function NewBookPage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  let customFields: FieldDef[] = [];
  try {
    const res = await api<FieldsResponse>(`/t/${params.slug}/data-model/fields/book`, { cookie });
    customFields = res.fields;
  } catch {
    customFields = [];
  }

  return (
    <>
      <PageHeader
        title={t('catalog.book.title')}
        subtitle={t('catalog.book.subtitle')}
        trail={
          <Link href={`/${params.locale}/t/${params.slug}/catalog`} style={{ color: 'inherit' }}>
            ← {t('catalog.title')}
          </Link>
        }
      />
      <div style={{ maxWidth: 720 }}>
        <BookForm
          slug={params.slug}
          catalog={catalog}
          locale={params.locale}
          customFields={customFields}
        />
      </div>
    </>
  );
}
