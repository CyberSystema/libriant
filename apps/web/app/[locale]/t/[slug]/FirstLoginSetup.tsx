'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Asset, Banner, Button, FormField, Input, PoweredBy, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';

/**
 * One-time forced setup for admin-created staff. Rendered by the tenant layout
 * (in place of the shell) while `mustChangeCredentials` is set. The user can
 * change their name and/or password, or keep both — submitting clears the flag
 * either way. After this, staff can't change name/password themselves; an admin
 * resets them.
 */
export function FirstLoginSetup({
  locale,
  catalog,
  currentName,
}: {
  locale: Locale;
  catalog: Catalog;
  currentName: string;
}) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const [fullName, setFullName] = React.useState(currentName);
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password && password.length < 4) {
      setError(t('auth.firstLogin.pwTooShort'));
      return;
    }
    if (password && password !== confirm) {
      setError(t('auth.firstLogin.pwMismatch'));
      return;
    }
    setBusy(true);
    try {
      const body: { fullName?: string; newPassword?: string } = {};
      if (fullName.trim() && fullName.trim() !== currentName) body.fullName = fullName.trim();
      if (password) body.newPassword = password;
      await api(`/auth/complete-setup`, { method: 'POST', body });
      toast.show({ severity: 'success', title: t('auth.firstLogin.done') });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.states.error'));
      setBusy(false);
    }
  }

  return (
    <main className="lbr-auth-shell">
      <div className="lbr-auth-card">
        <div className="lbr-auth-card__brand">
          <Asset name="brand/logo" width={160} height={40} />
        </div>
        <h1 className="lbr-auth-card__heading">{t('auth.firstLogin.title')}</h1>
        <p className="lbr-auth-card__subtitle">{t('auth.firstLogin.subtitle')}</p>
        <form onSubmit={submit} noValidate>
          {error ? (
            <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
              {error}
            </Banner>
          ) : null}
          <FormField id="fl-name" label={t('auth.firstLogin.name')}>
            <Input value={fullName} onChange={(e) => setFullName(e.currentTarget.value)} />
          </FormField>
          <FormField
            id="fl-pw"
            label={t('auth.firstLogin.newPassword')}
            hint={t('auth.firstLogin.pwHint')}
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
          </FormField>
          <FormField id="fl-pw2" label={t('auth.firstLogin.confirm')}>
            <Input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.currentTarget.value)}
            />
          </FormField>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={busy}
            style={{ width: '100%' }}
          >
            {t('auth.firstLogin.submit')}
          </Button>
        </form>
      </div>
      <div style={{ marginTop: 'var(--sp-4)', textAlign: 'center' }}>
        <PoweredBy />
      </div>
    </main>
  );
}
