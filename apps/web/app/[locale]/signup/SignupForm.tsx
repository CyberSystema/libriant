'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { FormError, Button, FormField, Input, Textarea } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { LIBRARY_TYPES } from '@libriant/shared/library';
import { ApiError, api } from '@/lib/api';
import { consentLabelParts } from '@/lib/consent-label';

type Props = {
  catalog: Catalog;
  locale: Locale;
};

type Errors = Partial<
  Record<
    | 'libraryName'
    | 'slug'
    | 'fullName'
    | 'email'
    | 'password'
    | 'accept'
    | 'libraryType'
    | 'addressStreet'
    | 'addressCity'
    | 'addressPostalCode'
    | 'addressCountry'
    | 'form',
    string
  >
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
  const [accept, setAccept] = React.useState(false);
  // Library profile (collected at signup).
  const [libraryType, setLibraryType] = React.useState('');
  const [addressStreet, setAddressStreet] = React.useState('');
  const [addressCity, setAddressCity] = React.useState('');
  const [addressPostalCode, setAddressPostalCode] = React.useState('');
  const [addressRegion, setAddressRegion] = React.useState('');
  const [addressCountry, setAddressCountry] = React.useState('GR');
  const [publicPhone, setPublicPhone] = React.useState('');
  const [publicEmail, setPublicEmail] = React.useState('');
  const [website, setWebsite] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [foundedYear, setFoundedYear] = React.useState('');
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
    if (!libraryType) next.libraryType = t('library.field.type');
    if (!addressStreet.trim()) next.addressStreet = t('library.field.street');
    if (!addressCity.trim()) next.addressCity = t('library.field.city');
    if (!addressPostalCode.trim()) next.addressPostalCode = t('library.field.postalCode');
    if (!/^[A-Za-z]{2}$/.test(addressCountry.trim()))
      next.addressCountry = t('library.field.country');
    if (!accept) next.accept = t('legal.consent.required');
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
        body: {
          libraryName,
          slug,
          fullName,
          email,
          password,
          defaultLocale: locale,
          acceptLegal: accept,
          libraryType,
          addressStreet,
          addressCity,
          addressPostalCode,
          addressRegion: addressRegion || undefined,
          addressCountry,
          publicPhone: publicPhone || undefined,
          publicEmail: publicEmail || undefined,
          website: website || undefined,
          description: description || undefined,
          foundedYear: foundedYear ? Number(foundedYear) : undefined,
        },
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
      {/* Always mounted — see FormError. */}
      <FormError style={{ marginBottom: 'var(--sp-4)' }}>
        {errors.form ? errors.form : null}
      </FormError>

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

      <fieldset className="lbr-fieldset">
        <legend>{t('library.signup.heading')}</legend>
        <p className="lbr-help" style={{ marginTop: 0 }}>
          {t('library.signup.hint')}
        </p>

        <FormField
          id="signup-type"
          label={t('library.field.type')}
          required
          error={errors.libraryType}
        >
          <select
            name="libraryType"
            className="lbr-input"
            value={libraryType}
            onChange={(e) => setLibraryType(e.currentTarget.value)}
          >
            <option value="" disabled>
              —
            </option>
            {LIBRARY_TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {t(`library.type.${ty}`)}
              </option>
            ))}
          </select>
        </FormField>

        <FormField
          id="signup-street"
          label={t('library.field.street')}
          required
          error={errors.addressStreet}
        >
          <Input
            name="addressStreet"
            autoComplete="street-address"
            value={addressStreet}
            onChange={(e) => setAddressStreet(e.currentTarget.value)}
          />
        </FormField>

        <div className="lbr-form-grid">
          <FormField
            id="signup-city"
            label={t('library.field.city')}
            required
            error={errors.addressCity}
          >
            <Input
              name="addressCity"
              value={addressCity}
              onChange={(e) => setAddressCity(e.currentTarget.value)}
            />
          </FormField>
          <FormField
            id="signup-postal"
            label={t('library.field.postalCode')}
            required
            error={errors.addressPostalCode}
          >
            <Input
              name="addressPostalCode"
              value={addressPostalCode}
              onChange={(e) => setAddressPostalCode(e.currentTarget.value)}
            />
          </FormField>
          <FormField id="signup-region" label={t('library.field.region')}>
            <Input
              name="addressRegion"
              value={addressRegion}
              onChange={(e) => setAddressRegion(e.currentTarget.value)}
            />
          </FormField>
          <FormField
            id="signup-country"
            label={t('library.field.country')}
            required
            error={errors.addressCountry}
          >
            <Input
              name="addressCountry"
              maxLength={2}
              value={addressCountry}
              onChange={(e) => setAddressCountry(e.currentTarget.value.toUpperCase())}
            />
          </FormField>
        </div>

        <div className="lbr-form-grid">
          <FormField id="signup-phone" label={t('library.field.phone')}>
            <Input
              name="publicPhone"
              value={publicPhone}
              onChange={(e) => setPublicPhone(e.currentTarget.value)}
            />
          </FormField>
          <FormField id="signup-pubemail" label={t('library.field.email')}>
            <Input
              type="email"
              name="publicEmail"
              value={publicEmail}
              onChange={(e) => setPublicEmail(e.currentTarget.value)}
            />
          </FormField>
          <FormField id="signup-website" label={t('library.field.website')}>
            <Input
              name="website"
              value={website}
              onChange={(e) => setWebsite(e.currentTarget.value)}
            />
          </FormField>
          <FormField id="signup-founded" label={t('library.field.foundedYear')}>
            <Input
              type="number"
              name="foundedYear"
              value={foundedYear}
              onChange={(e) => setFoundedYear(e.currentTarget.value)}
            />
          </FormField>
        </div>

        <FormField id="signup-desc" label={t('library.field.description')}>
          <Textarea
            name="description"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
        </FormField>
      </fieldset>

      <div className="lbr-consent" style={{ margin: 'var(--sp-4) 0' }}>
        <label className="lbr-consent__label">
          <input
            type="checkbox"
            name="acceptLegal"
            checked={accept}
            onChange={(e) => setAccept(e.currentTarget.checked)}
            aria-invalid={errors.accept ? true : undefined}
          />
          {/*
            privacy-legal-13: built from SIGNUP_CONSENT_DOCS, which is the same
            list the API stamps `presented` with. Two hard-coded links here and
            a third slug there is how an acceptance record ends up claiming a
            document was shown that never was.
          */}
          <span>
            {consentLabelParts(t, locale).map((part, i) =>
              part.kind === 'link' ? (
                <a
                  key={`${part.slug}-${i}`}
                  href={part.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {part.text}
                </a>
              ) : (
                <React.Fragment key={`t-${i}`}>{part.text}</React.Fragment>
              ),
            )}
          </span>
        </label>
        {errors.accept ? (
          <p className="lbr-consent__error" role="alert">
            {errors.accept}
          </p>
        ) : null}
      </div>

      <Button type="submit" loading={submitting} style={{ width: '100%' }} size="lg">
        {t('auth.signUp.submit')}
      </Button>
    </form>
  );
}
