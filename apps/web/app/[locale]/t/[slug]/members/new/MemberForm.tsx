'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  FormField,
  Input,
  useToast,
} from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { DynamicFields, type FieldDef } from '@/components/DynamicFields';

/** Initial values for edit mode. Shape mirrors the API's MemberDto. */
export type MemberInitial = {
  id: string;
  memberNumber: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  addressLine1: string | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  customFields: Record<string, unknown>;
};

type Props = {
  slug: string;
  catalog: Catalog;
  locale: Locale;
  customFields: FieldDef[];
  /** When set, after-create routing returns to the onboarding wizard instead of /members. */
  returnTo?: string;
  /**
   * When set, the form is in **edit mode** — fields are pre-filled, submit
   * PATCHes instead of POSTs, and on success we return to the detail page
   * (or call `onSaved` if the host page wants to handle it inline).
   */
  initial?: MemberInitial;
  /** Called after a successful PATCH so the detail page can swap back to view mode. */
  onSaved?: (next: MemberInitial) => void;
  /** Override the cancel link target (default: /members). */
  cancelHref?: string;
};

/**
 * Form to add a new member. Three sections:
 *
 *   1. Identity — full name (required) + optional member number override.
 *   2. Contact — email, phone, address. Everything's optional; a library
 *      with thin records can skip the lot.
 *   3. Custom fields — whatever the library has defined for `member` via
 *      the schema editor (Step 17e). Rendered through `<DynamicFields>`,
 *      validated server-side.
 *
 * On submit, structured field errors from the API are mapped back onto
 * their inputs ("This email doesn't look right"). Anything else surfaces
 * as a form-level banner.
 */
export function MemberForm({
  slug,
  catalog,
  locale,
  customFields,
  returnTo,
  initial,
  onSaved,
  cancelHref,
}: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const isEdit = !!initial;
  const [fullName, setFullName] = React.useState(initial?.fullName ?? '');
  const [memberNumber, setMemberNumber] = React.useState(initial?.memberNumber ?? '');
  const [email, setEmail] = React.useState(initial?.email ?? '');
  const [phone, setPhone] = React.useState(initial?.phone ?? '');
  const [dateOfBirth, setDateOfBirth] = React.useState(initial?.dateOfBirth?.slice(0, 10) ?? '');
  const [addressLine1, setAddressLine1] = React.useState(initial?.addressLine1 ?? '');
  const [city, setCity] = React.useState(initial?.city ?? '');
  const [postalCode, setPostalCode] = React.useState(initial?.postalCode ?? '');
  const [country, setCountry] = React.useState(initial?.country ?? '');
  const [customValues, setCustomValues] = React.useState<Record<string, unknown>>(
    initial?.customFields ?? {},
  );
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validation: Record<string, string> = {};
    if (!fullName.trim()) validation.fullName = t('members.errors.fullNameRequired');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      validation.email = t('auth.errors.emailInvalid');
    }
    if (Object.keys(validation).length) {
      setErrors(validation);
      setFormError(t('members.errors.checkFields'));
      return;
    }
    setErrors({});
    setFormError(null);
    setSubmitting(true);

    // Build the payload. On create we skip empty strings (no point sending
    // them); on edit we send `null` for fields the user cleared so the
    // API knows to wipe them.
    const payload: Record<string, unknown> = { fullName: fullName.trim() };
    const apply = (key: string, value: string | undefined) => {
      const trimmed = value?.trim() ?? '';
      if (trimmed.length) payload[key] = trimmed;
      else if (isEdit) payload[key] = null;
    };
    apply('memberNumber', memberNumber);
    apply('email', email);
    apply('phone', phone);
    if (dateOfBirth) payload.dateOfBirth = dateOfBirth;
    else if (isEdit) payload.dateOfBirth = null;
    apply('addressLine1', addressLine1);
    apply('city', city);
    apply('postalCode', postalCode);
    apply('country', country);
    if (Object.keys(customValues).length || isEdit) {
      payload.customFields = customValues;
    }

    try {
      if (isEdit) {
        const updated = await api<MemberInitial>(`/t/${slug}/members/${initial!.id}`, {
          method: 'PATCH',
          body: payload,
        });
        toast.show({
          severity: 'success',
          title: t('members.updateSuccess'),
          body: `${updated.memberNumber} · ${updated.fullName}`,
        });
        onSaved?.(updated);
        router.refresh();
        return;
      }
      const created = await api<{ id: string; memberNumber: string; fullName: string }>(
        `/t/${slug}/members`,
        { method: 'POST', body: payload },
      );
      toast.show({
        severity: 'success',
        title: t('members.createSuccess'),
        body: `${created.memberNumber} · ${created.fullName}`,
      });
      router.push(returnTo ?? `/${locale}/t/${slug}/members/${created.id}`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        // class-validator returns either a string or string[] in `message`.
        // Map well-known patterns back onto the right field. Anything else
        // falls into the form-level banner.
        const message = Array.isArray(err.body.message)
          ? err.body.message.join(' ')
          : (err.body.message ?? '');
        const fieldErrors: Record<string, string> = {};
        if (/email/i.test(message)) fieldErrors.email = message;
        else if (/member number|memberNumber/i.test(message)) fieldErrors.memberNumber = message;
        else if (/fullName|name/i.test(message)) fieldErrors.fullName = message;
        if (Object.keys(fieldErrors).length) {
          setErrors(fieldErrors);
          setFormError(t('members.errors.checkFields'));
        } else {
          setFormError(message || t('common.states.error'));
        }
      } else {
        setFormError(t('common.states.error'));
      }
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {formError ? (
        <Banner severity="critical" style={{ marginBottom: 'var(--sp-4)' }}>
          {formError}
        </Banner>
      ) : null}

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title={t('members.form.identity')} />
        <CardBody>
          <FormField
            id="member-fullName"
            label={t('members.form.fullName')}
            required
            error={errors.fullName}
          >
            <Input
              autoComplete="name"
              value={fullName}
              onChange={(e) => setFullName(e.currentTarget.value)}
            />
          </FormField>
          <FormField
            id="member-number"
            label={t('members.form.memberNumber')}
            hint={t('members.form.memberNumberHint')}
            error={errors.memberNumber}
          >
            <Input
              spellCheck={false}
              value={memberNumber}
              onChange={(e) => setMemberNumber(e.currentTarget.value.toUpperCase())}
            />
          </FormField>
          <FormField id="member-dob" label={t('members.form.dateOfBirth')}>
            <Input
              type="date"
              value={dateOfBirth}
              onChange={(e) => setDateOfBirth(e.currentTarget.value)}
            />
          </FormField>
        </CardBody>
      </Card>

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title={t('members.form.contact')} />
        <CardBody>
          <FormField id="member-email" label={t('members.form.email')} error={errors.email}>
            <Input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
            />
          </FormField>
          <FormField id="member-phone" label={t('members.form.phone')}>
            <Input
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.currentTarget.value)}
            />
          </FormField>
          <FormField id="member-addr" label={t('members.form.address')}>
            <Input
              autoComplete="street-address"
              value={addressLine1}
              onChange={(e) => setAddressLine1(e.currentTarget.value)}
            />
          </FormField>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: 'var(--sp-3)',
            }}
          >
            <FormField id="member-city" label={t('members.form.city')}>
              <Input
                autoComplete="address-level2"
                value={city}
                onChange={(e) => setCity(e.currentTarget.value)}
              />
            </FormField>
            <FormField id="member-postal" label={t('members.form.postalCode')}>
              <Input
                autoComplete="postal-code"
                value={postalCode}
                onChange={(e) => setPostalCode(e.currentTarget.value)}
              />
            </FormField>
            <FormField id="member-country" label={t('members.form.country')}>
              <Input
                autoComplete="country-name"
                value={country}
                onChange={(e) => setCountry(e.currentTarget.value)}
              />
            </FormField>
          </div>
        </CardBody>
      </Card>

      {customFields.length > 0 ? (
        <Card style={{ marginBottom: 'var(--sp-4)' }}>
          <CardHeader title={t('members.form.customFields')} />
          <CardBody>
            <DynamicFields
              fields={customFields}
              locale={locale}
              values={customValues}
              onChange={setCustomValues}
              errors={errors}
              idPrefix="member-cf"
            />
          </CardBody>
        </Card>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
        <Link
          href={cancelHref ?? `/${locale}/t/${slug}/members`}
          className="lbr-btn lbr-btn--ghost lbr-btn--md"
        >
          {t('common.actions.cancel')}
        </Link>
        <Button type="submit" variant="primary" loading={submitting}>
          {isEdit ? t('common.actions.save') : t('members.form.submit')}
        </Button>
      </div>
    </form>
  );
}
