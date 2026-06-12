import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardBody, CardHeader, HelpButton, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';

/**
 * Settings index. Today only the data-model editor lives here; future
 * sections (notification templates, branding) get their
 * own card on this page.
 */
export default async function SettingsPage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const catalog = await loadCatalog(params.locale);
  const t = createTranslator(catalog, params.locale);

  // A library can't self-delete — deletion is owner break-glass. The librarian
  // requests it by email; we pre-fill subject + body with the slug so the
  // Libriant team can find and confirm the right library.
  const deletionEmail = 'hello@libriant.com';
  const deletionMailto =
    `mailto:${deletionEmail}` +
    `?subject=${encodeURIComponent(t('settings.sections.delete.emailSubject', { slug: params.slug }))}` +
    `&body=${encodeURIComponent(t('settings.sections.delete.emailBody', { slug: params.slug }))}`;

  return (
    <>
      <PageHeader
        title={t('settings.title')}
        subtitle={t('settings.subtitle')}
        help={
          <HelpButton title="About settings">
            <p>This is the home for everything that changes how your library behaves.</p>
            <h3>What lives here today</h3>
            <ul>
              <li>
                <strong>Data model</strong> — add custom fields to books / members / loans, or whole
                new collection types (DVDs, Board games, …). Changes take effect on next page load,
                no migration needed.
              </li>
              <li>
                <strong>Get help from Libriant</strong> — generate a one-time code so our team can
                debug something in your library. End access at any time.
              </li>
            </ul>
            <h3>Coming soon</h3>
            <p>Notification templates, branding.</p>
          </HelpButton>
        }
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 'var(--sp-4)',
        }}
      >
        <Card>
          <CardHeader
            title={t('settings.sections.library.title')}
            subtitle={t('settings.sections.library.description')}
          />
          <CardBody>
            <Link
              href={`/${params.locale}/t/${params.slug}/settings/library`}
              className="lbr-btn lbr-btn--primary lbr-btn--md"
            >
              {t('settings.sections.library.cta')}
            </Link>
          </CardBody>
        </Card>

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
            title={t('settings.sections.import.title')}
            subtitle={t('settings.sections.import.description')}
          />
          <CardBody>
            <Link
              href={`/${params.locale}/t/${params.slug}/settings/import`}
              className="lbr-btn lbr-btn--primary lbr-btn--md"
            >
              {t('settings.sections.import.cta')}
            </Link>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={t('settings.sections.export.title')}
            subtitle={t('settings.sections.export.description')}
          />
          <CardBody>
            <Link
              href={`/${params.locale}/t/${params.slug}/settings/export`}
              className="lbr-btn lbr-btn--primary lbr-btn--md"
            >
              {t('settings.sections.export.cta')}
            </Link>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Get help from Libriant"
            subtitle="Give our team time-limited access to your library so we can help you fix something."
          />
          <CardBody>
            <Link
              href={`/${params.locale}/t/${params.slug}/settings/support-access`}
              className="lbr-btn lbr-btn--primary lbr-btn--md"
            >
              Manage support access
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

      <Card style={{ marginTop: 'var(--sp-6)', borderColor: 'var(--color-danger)' }}>
        <CardHeader
          title={t('settings.sections.delete.title')}
          subtitle={t('settings.sections.delete.description')}
        />
        <CardBody>
          <p style={{ marginTop: 0 }}>{t('settings.sections.delete.body')}</p>
          <a href={deletionMailto} className="lbr-btn lbr-btn--danger lbr-btn--md">
            {t('settings.sections.delete.cta')}
          </a>
        </CardBody>
      </Card>
    </>
  );
}
