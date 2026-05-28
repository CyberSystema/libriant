import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardBody, CardHeader, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';

/**
 * Settings index. Today only the data-model editor lives here; future
 * sections (loan policies, notification templates, branding) get their
 * own card on this page.
 */
export default async function SettingsPage({
  params,
}: {
  params: { locale: string; slug: string };
}) {
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);

  return (
    <>
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 'var(--sp-4)',
        }}
      >
        <Card>
          <CardHeader
            title={t('settings.sections.dataModel.title')}
            subtitle={t('settings.sections.dataModel.description')}
          />
          <CardBody>
            <Link
              href={`/${params.locale}/t/${params.slug}/settings/data-model`}
              className="lbr-btn lbr-btn--primary lbr-btn--md"
            >
              {t('settings.sections.dataModel.cta')}
            </Link>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={t('settings.sections.comingSoon.title')}
            subtitle={t('settings.sections.comingSoon.description')}
          />
          <CardBody>
            <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: 'var(--fs-sm)' }}>
              {t('settings.sections.comingSoon.description')}
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
