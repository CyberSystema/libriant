'use client';
import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Banner } from '@libriant/ui';
import { safeLocale, staticTranslator } from '@/lib/static-catalog';

/**
 * Page-level boundary inside the tenant workspace.
 *
 * A failed catalogue or loans page should cost the librarian that page, not the
 * whole shell: this boundary sits under the tenant layout, so the sidebar,
 * sign-out and every other section stay reachable while one page is broken.
 * Only a failure in the layout itself falls through to `[locale]/error.tsx`.
 */
export default function TenantPageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const params = useParams();
  const locale = safeLocale(params?.locale);
  const slug = typeof params?.slug === 'string' ? params.slug : '';
  const t = staticTranslator(locale);

  React.useEffect(() => {
    console.error('[libriant] tenant page failed', error.digest ?? error.message);
  }, [error]);

  return (
    <section style={{ maxWidth: 640 }}>
      <Banner
        severity="critical"
        title={t('system.crash.title')}
        style={{ marginBottom: 'var(--sp-3)' }}
      >
        {t('system.crash.description')}
      </Banner>
      <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
        <button type="button" className="lbr-btn lbr-btn--primary lbr-btn--md" onClick={reset}>
          {t('system.crash.retry')}
        </button>
        {slug ? (
          <Link
            href={`/${locale}/t/${slug}`}
            className="lbr-btn lbr-btn--secondary lbr-btn--md"
            style={{ textDecoration: 'none' }}
          >
            {t('system.crash.home')}
          </Link>
        ) : null}
      </div>
      {error.digest ? (
        <p
          style={{
            marginTop: 'var(--sp-4)',
            fontSize: 'var(--fs-xs)',
            color: 'var(--color-text-muted)',
          }}
        >
          {t('system.crash.reference')}: <code>{error.digest}</code>
        </p>
      ) : null}
    </section>
  );
}
