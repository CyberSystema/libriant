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

type Errors = Partial<
  Record<'libraryName' | 'slug' | 'fullName' | 'email' | 'password' | 'form', string>
>;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lowercase + replace runs of non-alphanumeric with single hyphens. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function SignupForm({ catalog, locale }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const [libraryName, setLibraryName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [slugTouched, setSlugTouched] = React.useState(false);
  const [fullName, setFullName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [errors, setErrors] = React.useState<Errors>({});
  const [submitting, setSubmitting] = React.useState(false);

  // Auto-fill the slug from the library name until the user touches it.
  React.useEffect(() => {
    if (!slugTouched) setSlug(slugify(libraryName));
  }, [libraryName, slugTouched]);

  function validate(): Errors {
    const next: Errors = {};
    if (!libraryName.trim()) next.libraryName = t('auth.errors.libraryNameRequired');
    if (!SLUG_RE.test(slug)) next.slug = t('auth.errors.slugInvalid');
    if (!fullName.trim()) next.fullName = t('auth.errors.fullNameRequired');
    if (!EMAIL_RE.test(email)) next.email = t('auth.errors.emailInvalid');
    if (password.length < 12) next.password = t('auth.errors.passwordTooShort', { min: 12 });
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
      await api<{ tenant: { slug: string } }>('/auth/signup', {
        method: 'POST',
        body: { libraryName, slug, fullName, email, password, defaultLocale: locale },
      });
      router.push(`/${locale}/t/${slug}`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        // Map server-side validation errors back onto specific fields when
        // we can; otherwise fall back to a form-level banner.
        const message = Array.isArray(err.body.message)
          ? err.body.message.join(' ')
          : (err.body.message ?? '');
        if (/slug/i.test(message)) setErrors({ slug: message });
        else if (/email/i.test(message)) setErrors({ email: message });
        else if (/password/i.test(message)) setErrors({ password: message });
        else setErrors({ form: message || t('auth.errors.somethingWentWrong') });
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
        id="signup-library-name"
        label={t('auth.signUp.libraryName')}
        hint={t('auth.signUp.libraryNameHint')}
        required
        error={errors.libraryName}
      >
        <Input
          name="libraryName"
          autoComplete="organization"
          value={libraryName}
          onChange={(e) => setLibraryName(e.currentTarget.value)}
        />
      </FormField>

      <FormField
        id="signup-slug"
        label={t('auth.signUp.librarySlug')}
        hint={t('auth.signUp.librarySlugHint')}
        required
        error={errors.slug}
      >
        <Input
          name="slug"
          autoComplete="off"
          spellCheck={false}
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.currentTarget.value.toLowerCase());
          }}
        />
      </FormField>

      <FormField
        id="signup-full-name"
        label={t('auth.signUp.yourName')}
        required
        error={errors.fullName}
      >
        <Input
          name="fullName"
          autoComplete="name"
          value={fullName}
          onChange={(e) => setFullName(e.currentTarget.value)}
        />
      </FormField>

      <FormField id="signup-email" label={t('auth.signUp.email')} required error={errors.email}>
        <Input
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
      </FormField>

      <FormField
        id="signup-password"
        label={t('auth.signUp.password')}
        hint={t('auth.signUp.passwordHint')}
        required
        error={errors.password}
      >
        <Input
          type="password"
          name="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      </FormField>

      <Button type="submit" loading={submitting} style={{ width: '100%' }} size="lg">
        {t('auth.signUp.submit')}
      </Button>
    </form>
  );
}
