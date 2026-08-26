'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { FormError, Button, FormField, Input } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator, isLocale } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { preferredLocale } from '@/lib/locale-preference';

type Props = {
  catalog: Catalog;
  locale: Locale;
  /**
   * Pre-fills the library address. Set by `/login?slug=…`, which is where
   * `/login/reset` sends someone who has just set a new password — they proved
   * who they are a second ago, and the slug is the one field a librarian
   * recovering an account is least likely to know by heart.
   */
  initialSlug?: string;
};

type Errors = {
  slug?: string;
  identifier?: string;
  password?: string;
  form?: string;
};

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export function LoginForm({ catalog, locale, initialSlug = '' }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const [slug, setSlug] = React.useState(initialSlug.toLowerCase().trim());
  const [identifier, setIdentifier] = React.useState('');
  const [password, setPassword] = React.useState('');
  // Default on so an individual user stays signed in; uncheck on a shared /
  // circulation-desk machine to get a session cookie that clears on browser close.
  const [remember, setRemember] = React.useState(true);
  const [errors, setErrors] = React.useState<Errors>({});
  const [submitting, setSubmitting] = React.useState(false);

  function validate(): Errors {
    const next: Errors = {};
    if (!SLUG_RE.test(slug)) next.slug = t('auth.errors.slugInvalid');
    // Identifier may be an email or a staff username — just require something.
    if (identifier.trim().length === 0) next.identifier = t('auth.errors.emailInvalid');
    // Staff use short admin-set passwords, so we don't enforce a minimum here;
    // the server is the authority.
    if (password.length < 1) next.password = t('auth.errors.passwordTooShort', { min: 1 });
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
      const res = await api<{ tenant: { slug: string; defaultLocale?: string } }>('/auth/login', {
        method: 'POST',
        body: { slug, identifier, password, remember },
      });
      // Land in the library's own language. `defaultLocale` is collected at
      // signup and was read nowhere, so a Greek library whose staff run en-US
      // machines got the whole application in English. An explicit choice from
      // the language switch still wins — that person has said the last word.
      const chosen = preferredLocale();
      const tenantLocale = res.tenant.defaultLocale;
      const target = chosen ?? (tenantLocale && isLocale(tenantLocale) ? tenantLocale : locale);
      // Redirect to the tenant home. The cookie is set by the API and
      // travels back through the same-origin proxy.
      router.push(`/${target}/t/${slug}`);
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
      {/* Always mounted — see FormError. */}
      <FormError style={{ marginBottom: 'var(--sp-4)' }}>
        {errors.form ? errors.form : null}
      </FormError>

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

      <FormField
        id="login-identifier"
        label={t('auth.signIn.identifier')}
        hint={t('auth.signIn.identifierHint')}
        required
        error={errors.identifier}
      >
        <Input
          name="identifier"
          autoComplete="username"
          spellCheck={false}
          value={identifier}
          onChange={(e) => setIdentifier(e.currentTarget.value)}
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

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-2)',
          margin: 'var(--sp-2) 0 var(--sp-4)',
          cursor: 'pointer',
          fontSize: 'var(--fs-sm)',
        }}
      >
        <input
          type="checkbox"
          name="remember"
          checked={remember}
          onChange={(e) => setRemember(e.currentTarget.checked)}
        />
        {t('auth.signIn.rememberMe')}
      </label>

      <Button type="submit" loading={submitting} style={{ width: '100%' }} size="lg">
        {t('auth.signIn.submit')}
      </Button>
    </form>
  );
}
