import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, CardHeader, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';
import { ImportWizard, type EntitySpec, type ImportBatchDto } from './ImportWizard';

export const dynamic = 'force-dynamic';

type EntitiesResponse = { entities: EntitySpec[] };
type ListResponse = { items: ImportBatchDto[] };

/**
 * Bulk import / migration wizard, under Settings. Server-fetches the entity
 * catalogue + recent batches; a 402 means the tenant's plan doesn't include
 * `bulk_import_enabled`, so we render an upgrade prompt instead of the wizard.
 */
export default async function ImportPage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);
  const cookie = await requestCookieHeader();

  let entities: EntitySpec[] = [];
  let initialBatches: ImportBatchDto[] = [];
  let locked = false;
  try {
    const [ents, list] = await Promise.all([
      api<EntitiesResponse>(`/t/${params.slug}/imports/entities`, { cookie }),
      api<ListResponse>(`/t/${params.slug}/imports`, { cookie }),
    ]);
    entities = ents.entities;
    initialBatches = list.items;
  } catch (err) {
    if (err instanceof ApiError && err.status === 402) locked = true;
    else throw err;
  }

  const header = (
    <PageHeader
      title={t('import.title')}
      subtitle={t('import.subtitle')}
      trail={
        <Link href={`/${params.locale}/t/${params.slug}/settings`} style={{ color: 'inherit' }}>
          ← {t('import.back')}
        </Link>
      }
    />
  );

  if (locked) {
    return (
      <>
        {header}
        <Card>
          <CardHeader title={t('import.locked.title')} />
          <CardBody>
            <Banner severity="info">{t('import.locked.body')}</Banner>
          </CardBody>
        </Card>
      </>
    );
  }

  return (
    <>
      {header}
      <Banner severity="info" style={{ marginBottom: 'var(--sp-4)' }}>
        {t('import.orderHint')}
      </Banner>
      <ImportWizard
        catalog={catalog}
        locale={params.locale}
        slug={params.slug}
        entities={entities}
        initialBatches={initialBatches}
      />
    </>
  );
}
