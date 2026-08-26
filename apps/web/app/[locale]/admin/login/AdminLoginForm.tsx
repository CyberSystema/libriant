'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { FormError, Button, FormField, Input } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AdminLoginForm() {
  const router = useRouter();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [totp, setTotp] = React.useState('');
  // Becomes true after the server replies that this admin has MFA enabled and
  // a code is required — then we reveal the authenticator-code field.
  const [mfaRequired, setMfaRequired] = React.useState(false);
  const [errors, setErrors] = React.useState<{
    email?: string;
    password?: string;
    totp?: string;
    form?: string;
  }>({});
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!EMAIL_RE.test(email)) next.email = 'That email address looks wrong.';
    if (password.length < 1) next.password = 'Enter your password.';
    if (mfaRequired && !/^\d{6}$/.test(totp)) next.totp = 'Enter the 6-digit code.';
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api('/admin/auth/login', {
        method: 'POST',
        body: { email, password, ...(mfaRequired ? { totp } : {}) },
      });
      router.push(`/admin/tenants`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        const code = err.body?.code;
        if (code === 'mfa_required') {
          setMfaRequired(true);
          setErrors({ form: 'Enter the code from your authenticator app to finish signing in.' });
        } else if (code === 'mfa_invalid') {
          setMfaRequired(true);
          setErrors({ totp: 'That code is wrong or was already used.' });
        } else {
          setErrors({ form: 'Email or password is wrong.' });
        }
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
      {/* Always mounted — see FormError. */}
      <FormError style={{ marginBottom: 'var(--sp-4)' }}>
        {errors.form ? errors.form : null}
      </FormError>
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
      {mfaRequired ? (
        <FormField id="admin-totp" label="Authenticator code" required error={errors.totp}>
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={totp}
            onChange={(e) => setTotp(e.currentTarget.value.replace(/\D/g, ''))}
          />
        </FormField>
      ) : null}
      <Button type="submit" variant="primary" size="lg" loading={busy} style={{ width: '100%' }}>
        Sign in
      </Button>
    </form>
  );
}
