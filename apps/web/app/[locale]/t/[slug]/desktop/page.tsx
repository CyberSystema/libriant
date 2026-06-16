import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Banner, Card, CardBody, CardHeader, PageHeader } from '@libriant/ui';
import { createTranslator, isLocale, type Locale } from '@libriant/i18n';
import { loadCatalog } from '@/lib/locale-loader';
import { requestCookieHeader } from '@/lib/session';
import { ApiError, api } from '@/lib/api';
import { guessPlatformFromRequest, type DesktopPlatform } from '@/lib/desktop-server';

export const dynamic = 'force-dynamic';

type ReleaseInfo = {
  entitled: boolean;
  reason: string;
  billingEnabled: boolean;
  available: boolean;
  version: string | null;
  platforms: { mac: boolean; win: boolean; linux: boolean };
};

const PLATFORM_ORDER: DesktopPlatform[] = ['mac', 'win', 'linux'];

/**
 * In-panel desktop-app download. The installers live on GitHub Releases; the API
 * proxies + entitlement-gates them, so the buttons just point at the (same-
 * origin) proxy endpoint and the browser downloads the streamed file.
 *
 *   - Entitled + a release is published → per-OS download buttons.
 *   - Entitled but nothing published yet → a "coming soon" notice.
 *   - Not entitled (paid feature, free/lapsed plan) → an upgrade CTA.
 */
export default async function DesktopPage(props: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const params = await props.params;
  if (!isLocale(params.locale)) notFound();
  const locale: Locale = params.locale;
  const catalog = await loadCatalog(locale);
  const t = createTranslator(catalog, locale);
  const cookie = await requestCookieHeader();

  let info: ReleaseInfo | null = null;
  let fetchError: string | null = null;
  try {
    info = await api<ReleaseInfo>(`/t/${params.slug}/desktop/release`, { cookie });
  } catch (err) {
    fetchError = err instanceof ApiError ? err.message : t('common.states.error');
  }

  const guessed = await guessPlatformFromRequest();

  return (
    <>
      <PageHeader title={t('common.desktop.title')} subtitle={t('common.desktop.intro')} />

      {!info ? (
        <Banner severity="critical">{fetchError ?? t('common.states.error')}</Banner>
      ) : !info.entitled ? (
        <Card>
          <CardHeader title={t('common.desktop.upgradeTitle')} />
          <CardBody>
            <p style={{ marginTop: 0 }}>{t('common.desktop.upgradeBody')}</p>
            <Link
              href={`/${locale}/t/${params.slug}/billing`}
              className="lbr-btn lbr-btn--primary lbr-btn--md"
            >
              {t('common.desktop.upgradeCta')}
            </Link>
          </CardBody>
        </Card>
      ) : !info.available ? (
        <Banner severity="info">{t('common.desktop.notPublished')}</Banner>
      ) : (
        <Card>
          <CardHeader
            title={t('common.desktop.download')}
            subtitle={
              info.version ? t('common.desktop.version', { version: info.version }) : undefined
            }
          />
          <CardBody>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-3)' }}>
              {PLATFORM_ORDER.filter((p) => info.platforms[p]).map((p) => {
                const recommended = p === guessed;
                return (
                  <a
                    key={p}
                    href={`/lbr-api/t/${params.slug}/desktop/download?platform=${p}`}
                    className={`lbr-btn lbr-btn--${recommended ? 'primary' : 'secondary'} lbr-btn--md`}
                    download
                  >
                    {t('common.desktop.download')} · {t(`common.desktop.platform.${p}`)}
                  </a>
                );
              })}
            </div>
            {guessed && info.platforms[guessed] ? (
              <p
                style={{
                  marginTop: 'var(--sp-2)',
                  color: 'var(--color-text-muted)',
                  fontSize: 'var(--fs-sm)',
                }}
              >
                {t('common.desktop.recommended')}: {t(`common.desktop.platform.${guessed}`)}
              </p>
            ) : null}
            <p
              style={{
                marginTop: 'var(--sp-3)',
                color: 'var(--color-text-muted)',
                fontSize: 'var(--fs-sm)',
              }}
            >
              {t('common.desktop.installHint')}
            </p>
          </CardBody>
        </Card>
      )}
    </>
  );
}
