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
          <HelpButton title={t('settings.help.title')}>
            <p>{t('settings.help.intro')}</p>
            <h3>{t('settings.help.todayTitle')}</h3>
            <ul>
              <li>{t('settings.help.dataModel')}</li>
              <li>{t('settings.help.support')}</li>
            </ul>
            <h3>{t('settings.help.comingSoonTitle')}</h3>
            <p>{t('settings.help.comingSoon')}</p>
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
            title={t('settings.sections.profile.title')}
            subtitle={t('settings.sections.profile.description')}
          />
          <CardBody>
            <Link
              href={`/${params.locale}/t/${params.slug}/settings/profile`}
              className="lbr-btn lbr-btn--primary lbr-btn--md"
            >
              {t('settings.sections.profile.cta')}
            </Link>
          </CardBody>
        </Card>

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
            title={t('settings.sections.activity.title')}
            subtitle={t('settings.sections.activity.description')}
          />
          <CardBody>
            <Link
              href={`/${params.locale}/t/${params.slug}/settings/activity`}
              className="lbr-btn lbr-btn--primary lbr-btn--md"
            >
              {t('settings.sections.activity.cta')}
            </Link>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={t('settings.sections.templates.title')}
            subtitle={t('settings.sections.templates.description')}
          />
          <CardBody>
            <Link
              href={`/${params.locale}/t/${params.slug}/settings/notification-templates`}
              className="lbr-btn lbr-btn--primary lbr-btn--md"
            >
              {t('settings.sections.templates.cta')}
            </Link>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={t('settings.sections.branding.title')}
            subtitle={t('settings.sections.branding.description')}
          />
          <CardBody>
            <Link
              href={`/${params.locale}/t/${params.slug}/settings/branding`}
              className="lbr-btn lbr-btn--primary lbr-btn--md"
            >
              {t('settings.sections.branding.cta')}
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
            title={t('settings.sections.supportAccess.title')}
            subtitle={t('settings.sections.supportAccess.description')}
          />
          <CardBody>
            <Link
              href={`/${params.locale}/t/${params.slug}/settings/support-access`}
              className="lbr-btn lbr-btn--primary lbr-btn--md"
            >
              {t('settings.sections.supportAccess.cta')}
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
