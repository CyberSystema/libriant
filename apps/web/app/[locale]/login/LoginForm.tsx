'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, FormField, Input } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';

type Props = {
  catalog: Catalog;
  locale: Locale;
};

type Errors = {
  slug?: string;
  email?: string;
  password?: string;
  form?: string;
};

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginForm({ catalog, locale }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const [slug, setSlug] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [errors, setErrors] = React.useState<Errors>({});
  const [submitting, setSubmitting] = React.useState(false);

  function validate(): Errors {
    const next: Errors = {};
    if (!SLUG_RE.test(slug)) next.slug = t('auth.errors.slugInvalid');
    if (!EMAIL_RE.test(email)) next.email = t('auth.errors.emailInvalid');
    if (password.length < 12) {
      next.password = t('auth.errors.passwordTooShort', { min: 12 });
    }
    return next;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validation = validate();
    if (Object.keys(validation).length) {
      setErrors(validation);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await api<{ ok: true; tenant: { slug: string } }>('/auth/login', {
        method: 'POST',
        body: { slug, email, password },
      });
      // Redirect to the tenant home. The cookie is set by the API and
      // travels back through the same-origin proxy.
      router.push(`/${locale}/t/${slug}`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
        setErrors({ form: t('auth.errors.invalidCredentials') });
      } else {
        setErrors({ form: t('auth.errors.somethingWentWrong') });
      }
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {errors.form ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {errors.form}
        </Banner>
      ) : null}

      <FormField
        id="login-slug"
        label={t('auth.signUp.librarySlug')}
        hint={t('auth.signUp.librarySlugHint')}
        required
        error={errors.slug}
      >
        <Input
          name="slug"
          autoComplete="organization"
          spellCheck={false}
          value={slug}
          onChange={(e) => setSlug(e.currentTarget.value.toLowerCase().trim())}
        />
      </FormField>

      <FormField id="login-email" label={t('auth.signIn.email')} required error={errors.email}>
        <Input
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
      </FormField>

      <FormField
        id="login-password"
        label={t('auth.signIn.password')}
        required
        error={errors.password}
      >
        <Input
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      </FormField>

      <Button type="submit" loading={submitting} style={{ width: '100%' }} size="lg">
        {t('auth.signIn.submit')}
      </Button>
    </form>
  );
}
