import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { dataPort } from '@/lib/ports';
import type { CatalogTemplate } from '@/lib/marc-from-template';
import { BibCreateForm } from './BibCreateForm';

export const dynamic = 'force-dynamic';

export default async function NewBibPage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  // The record a new book starts from — leader, fields and indicators — served
  // rather than hand-rolled in the browser. `catalog-templates.controller.ts`
  // says why at length; the short form is that `check:marc-schema` already
  // gate-checks this answer and a second copy would not be checked by anything.
  const templates = await dataPort()
    .get<{ items: CatalogTemplate[] }>(`/t/${params.slug}/catalog/templates`, { cookie })
    .catch(() => ({ items: [] as CatalogTemplate[] }));
  const template = templates.items.find((x) => x.id === 'book') ?? null;

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
        <BibCreateForm
          slug={params.slug}
          catalog={catalog}
          locale={params.locale}
          template={template}
        />
      </div>
    </>
  );
}
