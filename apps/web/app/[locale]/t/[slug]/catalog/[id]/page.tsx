import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';
import type { FieldDef } from '@/components/DynamicFields';
import type { BookInitial } from '../new/BookForm';
import { BookDetail } from './BookDetail';

export const dynamic = 'force-dynamic';

type FieldsResponse = { entityKind: string; fields: FieldDef[] };

type BookCopy = {
  id: string;
  barcode: string;
  status: 'available' | 'on_loan' | 'reserved' | 'lost' | 'damaged' | 'withdrawn';
  shelfLocation: string | null;
  archivedAt: string | null;
};

type BookWithCopies = BookInitial & {
  coverAssetRef: string | null;
  archivedAt: string | null;
  copies: BookCopy[];
};

export default async function BookDetailPage({
  params,
}: {
  params: { locale: string; slug: string; id: string };
}) {
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  let book: BookWithCopies | null = null;
  let fetchError: string | null = null;
  try {
    book = await api<BookWithCopies>(`/t/${params.slug}/catalog/books/${params.id}`, { cookie });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    fetchError = err instanceof ApiError ? err.message : t('common.states.error');
  }

  let customFields: FieldDef[] = [];
  try {
    const res = await api<FieldsResponse>(`/t/${params.slug}/data-model/fields/book`, {
      cookie,
    });
    customFields = res.fields;
  } catch {
    customFields = [];
  }

  if (!book) {
    return (
      <>
        <PageHeader title={t('catalog.title')} />
        <Banner severity="critical">{fetchError ?? t('common.states.error')}</Banner>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={book.title}
        subtitle={book.subtitle ?? undefined}
        trail={
          <Link href={`/${params.locale}/t/${params.slug}/catalog`} style={{ color: 'inherit' }}>
            ← {t('catalog.title')}
          </Link>
        }
      />
      <BookDetail
        slug={params.slug}
        catalog={catalog}
        locale={params.locale}
        initial={book}
        customFields={customFields}
      />
    </>
  );
}
