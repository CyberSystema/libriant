'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { api } from '@/lib/api';

type Props = { catalog: Catalog; locale: Locale };

/** Calls `/auth/logout`, then bounces to the locale-scoped sign-in page. */
export function LogoutButton({ catalog, locale }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api('/auth/logout', { method: 'POST' });
        } catch {
          // Even if the API errors, the cookie's likely revoked. Push the
          // user to /login anyway — they'll get bounced if still authed.
        }
        router.push(`/${locale}/login`);
        router.refresh();
      }}
    >
      {t('common.actions.signOut')}
    </Button>
  );
}
