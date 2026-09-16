'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Banner, Button, FormError, FormField, Input, Textarea, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { dataPort } from '@/lib/ports';
import { translateApiError } from '@/lib/api-errors';
import { useIdempotencyKey } from '@/lib/useIdempotencyKey';
import { BarcodeScanner, SCAN_FORMATS, scanningSupported } from '@/components/BarcodeScanner';

export type PatronCategory = {
  id: string;
  code: string;
  name: string;
  minAgeYears: number | null;
};
export type Branch = { id: string; code: string; name: string };

type Props = {
  slug: string;
  catalog: Catalog;
  locale: Locale;
  categories: PatronCategory[];
  branches: Branch[];
};

/**
 * Enrol a member, on the 2.0 surface (phase 20p).
 *
 * ## What 2.0 added that 1.0 could not express
 *
 *   - **A first card.** In 1.0 the member number WAS the card number. 2.0 makes
 *     cards a table so a found card still resolves — "a found card should be
 *     recognised as the one that was reported lost on the 3rd, not rejected as
 *     an unknown number" — so `barcode` here issues the first one, and is
 *     separate from the number.
 *   - **A category**, which is what the circulation rules match on.
 *   - **A home branch** and **a card expiry**, neither of which 1.0 had.
 *
 * ## The number is MINTED, and left alone unless the library numbers its own
 *
 * `patronNumber` is optional: the server mints `M-YYYY-NNNNNN` in the branch's
 * timezone. The field is offered because a library that runs its own numbering
 * must be able to say so, and it carries the server's own regex — uppercase,
 * because `text_pattern_ops` cannot index a case-insensitive column at all.
 *
 * ## An empty category list is a REAL state, not a loading one
 *
 * Measured in 20m: a freshly provisioned tenant has no patron categories at all
 * — `pcat-general` is created by the UPGRADE and by nothing else, while
 * provisioning seeds a branch, a shelving location and an item type. The field
 * is optional and the column nullable, so enrolment works without one; the form
 * says so rather than presenting an empty select as a failure.
 */
export function PatronEnrolForm({ slug, catalog, locale, categories, branches }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const [fullName, setFullName] = React.useState('');
  const [patronNumber, setPatronNumber] = React.useState('');
  const [barcode, setBarcode] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [dateOfBirth, setDateOfBirth] = React.useState('');
  const [categoryId, setCategoryId] = React.useState(
    categories.length === 1 ? categories[0]!.id : '',
  );
  const [branchId, setBranchId] = React.useState(branches.length === 1 ? branches[0]!.id : '');
  const [expiresAt, setExpiresAt] = React.useState('');
  const [staffNotes, setStaffNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const [canScan, setCanScan] = React.useState(false);
  React.useEffect(() => setCanScan(scanningSupported()), []);
  /**
   * ONE key for one logical "enrol this person".
   *
   * Nothing about a person is unique — a catalogue record at least has a control
   * number — so without this a double-click or a retry after the client deadline
   * enrols the same human twice under two minted numbers, and the second row
   * looks exactly like a legitimate second member of a family.
   */
  const idem = useIdempotencyKey();

  const chosenCategory = categories.find((c) => c.id === categoryId) ?? null;
  /**
   * Warned about BEFORE the API refuses, and only when both facts are known.
   *
   * The category's minimum age is a rule the desk can see; a date of birth the
   * librarian has just typed is the other half. Saying it here is the difference
   * between a form that explains and one that rejects.
   */
  const ageWarning = (() => {
    if (!chosenCategory?.minAgeYears || dateOfBirth === '') return null;
    const born = new Date(dateOfBirth);
    if (Number.isNaN(born.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - born.getFullYear();
    const before =
      now.getMonth() < born.getMonth() ||
      (now.getMonth() === born.getMonth() && now.getDate() < born.getDate());
    if (before) age -= 1;
    return age < chosenCategory.minAgeYears
      ? t('members.form.belowMinAge', {
          category: chosenCategory.name,
          min: chosenCategory.minAgeYears,
        })
      : null;
  })();

  async function submit() {
    if (fullName.trim() === '') {
      setError(t('members.errors.fullNameRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // OMITTED, not sent empty. The DTO validates each field only when it is
      // present, so a blank string would fail `@IsEmail` or the number's regex
      // rather than meaning "not given".
      const body: Record<string, unknown> = { fullName: fullName.trim() };
      if (patronNumber.trim()) body.patronNumber = patronNumber.trim().toUpperCase();
      if (barcode.trim()) body.barcode = barcode.trim();
      if (email.trim()) body.email = email.trim();
      if (phone.trim()) body.phone = phone.trim();
      if (dateOfBirth) body.dateOfBirth = new Date(dateOfBirth).toISOString();
      if (categoryId) body.patronCategoryId = categoryId;
      if (branchId) body.homeBranchId = branchId;
      if (expiresAt) body.expiresAt = new Date(expiresAt).toISOString();
      if (staffNotes.trim()) body.staffNotes = staffNotes.trim();

      const created = await dataPort().post<{ id: string; patronNumber: string | null }>(
        `/t/${slug}/patrons`,
        body,
        { idempotencyKey: idem.key },
      );
      idem.rotate();
      toast.show({
        severity: 'success',
        title: t('members.createSuccess'),
        body: created.patronNumber ?? undefined,
      });
      router.push(`/${locale}/t/${slug}/members/${created.id}`);
    } catch (err) {
      setError(translateApiError(err, t, t('common.states.error')));
      setBusy(false);
    }
  }

  return (
    <div>
      {error ? <FormError>{error}</FormError> : null}
      {categories.length === 0 ? (
        <Banner severity="info" style={{ marginBottom: 'var(--sp-3)' }}>
          {t('members.form.noCategories')}
        </Banner>
      ) : null}

      <div className="lbr-form-grid">
        <FormField id="p-name" label={t('members.columns.name')} required>
          <Input value={fullName} onChange={(e) => setFullName(e.currentTarget.value)} />
        </FormField>
        <FormField id="p-email" label={t('members.columns.email')}>
          <Input value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
        </FormField>
        <FormField id="p-phone" label={t('members.columns.phone')}>
          <Input value={phone} onChange={(e) => setPhone(e.currentTarget.value)} />
        </FormField>
        <FormField id="p-dob" label={t('members.form.dateOfBirth')}>
          <Input
            type="date"
            value={dateOfBirth}
            onChange={(e) => setDateOfBirth(e.currentTarget.value)}
          />
        </FormField>

        <FormField
          id="p-category"
          label={t('members.detail.category')}
          hint={categories.length === 0 ? t('members.form.noCategoriesHint') : undefined}
        >
          <select
            className="lbr-input"
            value={categoryId}
            disabled={categories.length === 0}
            onChange={(e) => setCategoryId(e.currentTarget.value)}
          >
            <option value="">—</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </FormField>

        <FormField id="p-branch" label={t('members.form.homeBranch')}>
          <select
            className="lbr-input"
            value={branchId}
            onChange={(e) => setBranchId(e.currentTarget.value)}
          >
            <option value="">—</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </FormField>

        <FormField
          id="p-number"
          label={t('members.columns.cardNumber')}
          hint={t('members.form.numberMintedHint')}
        >
          <Input
            spellCheck={false}
            value={patronNumber}
            onChange={(e) => setPatronNumber(e.currentTarget.value.toUpperCase())}
          />
        </FormField>
        <FormField
          id="p-expires"
          label={t('members.detail.expiresAt')}
          hint={t('members.form.expiresHint')}
        >
          <Input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.currentTarget.value)}
          />
        </FormField>
      </div>

      <FormField
        id="p-barcode"
        label={t('members.form.cardBarcode')}
        hint={t('members.form.cardBarcodeHint')}
      >
        <Input
          spellCheck={false}
          value={barcode}
          onChange={(e) => setBarcode(e.currentTarget.value)}
        />
      </FormField>
      {canScan ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          style={{ marginTop: 'var(--sp-2)' }}
          onClick={() => setScanning(true)}
        >
          {t('catalog.book.copyScan')}
        </Button>
      ) : null}

      <FormField id="p-notes" label={t('members.detail.staffNotes')}>
        <Textarea
          rows={3}
          value={staffNotes}
          onChange={(e) => setStaffNotes(e.currentTarget.value)}
        />
      </FormField>

      {ageWarning ? (
        <Banner severity="warning" style={{ marginTop: 'var(--sp-3)' }}>
          {ageWarning}
        </Banner>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-3)' }}>
        <Button variant="primary" loading={busy} onClick={submit}>
          {t('members.form.submit')}
        </Button>
      </div>

      <BarcodeScanner
        open={scanning}
        onClose={() => setScanning(false)}
        formats={SCAN_FORMATS.label}
        title={t('members.form.cardScanTitle')}
        catalog={catalog}
        locale={locale}
        onScan={(value) => {
          setBarcode(value.trim());
          setScanning(false);
        }}
      />
    </div>
  );
}
