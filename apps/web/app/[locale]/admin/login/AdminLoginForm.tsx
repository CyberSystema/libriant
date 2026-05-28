'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, FormField, Input } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

type Props = { locale: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AdminLoginForm({ locale }: Props) {
  const router = useRouter();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [errors, setErrors] = React.useState<{ email?: string; password?: string; form?: string }>(
    {},
  );
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!EMAIL_RE.test(email)) next.email = 'That email address looks wrong.';
    if (password.length < 1) next.password = 'Enter your password.';
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api('/admin/auth/login', { method: 'POST', body: { email, password } });
      router.push(`/${locale}/admin/tenants`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setErrors({ form: 'Email or password is wrong.' });
      } else if (err instanceof ApiError) {
        setErrors({ form: err.message });
      } else {
        setErrors({ form: 'Something went wrong. Try again.' });
      }
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {errors.form ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {errors.form}
        </Banner>
      ) : null}
      <FormField id="admin-email" label="Email" required error={errors.email}>
        <Input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
      </FormField>
      <FormField id="admin-password" label="Password" required error={errors.password}>
        <Input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      </FormField>
      <Button type="submit" variant="primary" size="lg" loading={busy} style={{ width: '100%' }}>
        Sign in
      </Button>
    </form>
  );
}
