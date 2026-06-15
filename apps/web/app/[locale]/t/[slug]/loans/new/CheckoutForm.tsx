'use client';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Banner, Button, Card, CardBody, FormField, Input, Textarea, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { useIdempotencyKey } from '@/lib/useIdempotencyKey';
import { Combobox } from '@/components/Combobox';
import { BarcodeScanner, SCAN_FORMATS, scanningSupported } from '@/components/BarcodeScanner';

type MemberOption = {
  id: string;
  memberNumber: string;
  fullName: string;
  email: string | null;
  status: 'active' | 'suspended' | 'archived';
};

type BookOption = {
  id: string;
  title: string;
  authors: Array<{ authorId: string; fullName: string; order: number }>;
};

type CopySummary = {
  id: string;
  barcode: string;
  status: 'available' | 'on_loan' | 'reserved' | 'lost' | 'damaged' | 'withdrawn';
  shelfLocation: string | null;
};

type BookWithCopies = BookOption & { copies: CopySummary[] };

type Props = {
  slug: string;
  catalog: Catalog;
  locale: Locale;
  /** Default loan period in days (from `tenant_settings`). Used for the initial dueAt. */
  defaultLoanPeriodDays: number;
  /** Optional pre-fill member id (e.g. when arriving from a member page). */
  prefillMemberId?: string;
};

/**
 * The checkout form for librarians. Three sections:
 *
 *   1. Member picker — autocomplete on name / email / memberNumber.
 *   2. Book picker — autocomplete on title / author / ISBN. Once a book
 *      is chosen we fetch its copies and show only the AVAILABLE ones for
 *      selection. (A copy in any other state — on_loan, reserved, damaged,
 *      etc. — can't be lent right now, so we don't even show it.)
 *   3. Due date + notes — due-date defaults to `today + loanPeriodDays`,
 *      librarian can override.
 *
 * On submit we POST to `/t/:slug/loans` and either redirect to the new
 * loan's detail page or surface the API's friendly refusal message
 * (overdue cap, suspended member, etc.).
 */
export function CheckoutForm({
  slug,
  catalog,
  locale,
  defaultLoanPeriodDays,
  prefillMemberId,
}: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const search = useSearchParams();
  const toast = useToast();

  const [member, setMember] = React.useState<MemberOption | null>(null);
  const [book, setBook] = React.useState<BookOption | null>(null);
  const [copies, setCopies] = React.useState<CopySummary[] | null>(null);
  const [copyId, setCopyId] = React.useState<string>('');
  const [copiesLoading, setCopiesLoading] = React.useState(false);
  const [copiesError, setCopiesError] = React.useState<string | null>(null);

  // Camera scanning is an optional enhancement over the pickers. `scanTarget`
  // says which field the open scanner fills; `canScan` is a client-only check
  // gated through state to avoid a hydration mismatch.
  const [scanTarget, setScanTarget] = React.useState<'member' | 'copy' | null>(null);
  const [canScan, setCanScan] = React.useState(false);
  React.useEffect(() => setCanScan(scanningSupported()), []);
  // When a copy is scanned we pick the book (which triggers the copies fetch
  // below); this remembers which copy to auto-select once they load. A ref so
  // updating it doesn't re-run the fetch effect.
  const desiredCopyIdRef = React.useRef<string | null>(null);

  const defaultDue = React.useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + defaultLoanPeriodDays);
    return d.toISOString().slice(0, 10);
  }, [defaultLoanPeriodDays]);
  const [dueAt, setDueAt] = React.useState(defaultDue);
  const [notes, setNotes] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  // Stable key for this checkout: a double-submit / retry returns the same loan
  // instead of lending two copies. Rotated after a successful checkout.
  const { key: idempotencyKey, rotate } = useIdempotencyKey();

  // Pre-fill member from URL (e.g. /loans/new?memberId=...).
  React.useEffect(() => {
    const prefilled = prefillMemberId ?? search?.get('memberId') ?? null;
    if (!prefilled || member) return;
    api<MemberOption>(`/t/${slug}/members/${prefilled}`)
      .then((m) => setMember(m))
      .catch(() => undefined);
  }, [prefillMemberId, search, slug, member]);

  // Whenever a book is chosen, fetch its copies. Cleared on book clear.
  React.useEffect(() => {
    if (!book) {
      setCopies(null);
      setCopyId('');
      return;
    }
    setCopiesLoading(true);
    setCopiesError(null);
    api<BookWithCopies>(`/t/${slug}/catalog/books/${book.id}`)
      .then((b) => {
        setCopies(b.copies);
        // If we got here from a copy scan, honour the scanned copy (when it's
        // available); otherwise auto-pick the first available copy so the
        // common path is a single click after picking the book.
        const desired = desiredCopyIdRef.current;
        desiredCopyIdRef.current = null;
        if (desired && b.copies.some((c) => c.id === desired && c.status === 'available')) {
          setCopyId(desired);
          return;
        }
        const firstAvailable = b.copies.find((c) => c.status === 'available');
        if (firstAvailable) setCopyId(firstAvailable.id);
      })
      .catch((err) => {
        setCopiesError(err instanceof ApiError ? err.message : t('common.states.error'));
      })
      .finally(() => setCopiesLoading(false));
  }, [book, slug, t]);

  const availableCopies = copies?.filter((c) => c.status === 'available') ?? [];

  async function resolveScannedMember(memberNumber: string) {
    try {
      const m = await api<MemberOption>(
        `/t/${slug}/members/lookup?memberNumber=${encodeURIComponent(memberNumber)}`,
      );
      setMember(m);
    } catch {
      toast.show({
        severity: 'warning',
        title: t('loans.checkout.scanMemberNotFound', { number: memberNumber }),
      });
    }
  }

  async function resolveScannedCopy(barcode: string) {
    try {
      const res = await api<{ copy: CopySummary; book: BookOption }>(
        `/t/${slug}/catalog/copies/lookup?barcode=${encodeURIComponent(barcode)}`,
      );
      desiredCopyIdRef.current = res.copy.id;
      setCopyId('');
      setBook(res.book);
      if (res.copy.status !== 'available') {
        toast.show({
          severity: 'warning',
          title: t('loans.checkout.scanCopyUnavailable', { barcode: res.copy.barcode }),
        });
      }
    } catch {
      toast.show({ severity: 'warning', title: t('loans.checkout.scanCopyNotFound', { barcode }) });
    }
  }

  function handleScan(value: string) {
    const v = value.trim();
    const target = scanTarget;
    setScanTarget(null);
    if (!v) return;
    if (target === 'member') void resolveScannedMember(v);
    else if (target === 'copy') void resolveScannedCopy(v);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!member || !book || !copyId) {
      setFormError(t('loans.checkout.missingFields'));
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await api<{ loan: { id: string } }>(`/t/${slug}/loans`, {
        method: 'POST',
        idempotencyKey,
        body: {
          memberId: member.id,
          copyId,
          dueAt: `${dueAt}T23:59:59.000Z`,
          notes: notes.trim() || undefined,
        },
      });
      rotate(); // succeeded — a later checkout starts a fresh key
      toast.show({
        severity: 'success',
        title: t('loans.checkout.success'),
        body: `${book.title} → ${member.fullName}`,
      });
      router.push(`/${locale}/t/${slug}/loans/${res.loan.id}`);
      router.refresh();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : t('common.states.error'));
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

      <BarcodeScanner
        open={scanTarget !== null}
        onClose={() => setScanTarget(null)}
        formats={SCAN_FORMATS.label}
        title={
          scanTarget === 'member'
            ? t('loans.checkout.scanMemberTitle')
            : t('loans.checkout.scanCopyTitle')
        }
        catalog={catalog}
        locale={locale}
        onScan={handleScan}
      />

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardBody>
          <FormField id="checkout-member" label={t('loans.checkout.member')} required>
            <Combobox<MemberOption>
              id="checkout-member"
              placeholder={t('loans.checkout.memberPlaceholder')}
              clearLabel={t('common.combobox.clear')}
              noMatchesText={t('common.combobox.noMatches')}
              value={member}
              onChange={setMember}
              endpoint={(q) =>
                `/t/${slug}/members?q=${encodeURIComponent(q)}&limit=8&status=active`
              }
              renderOption={(m) => (
                <div>
                  <div style={{ fontWeight: 500 }}>{m.fullName}</div>
                  <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
                    {m.memberNumber}
                    {m.email ? ` · ${m.email}` : ''}
                  </div>
                </div>
              )}
              renderSelected={(m) => (
                <div>
                  <div style={{ fontWeight: 500 }}>{m.fullName}</div>
                  <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
                    {m.memberNumber}
                  </div>
                </div>
              )}
            />
          </FormField>
          {canScan ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              style={{ marginTop: 'var(--sp-2)' }}
              onClick={() => setScanTarget('member')}
            >
              {t('loans.checkout.scanMember')}
            </Button>
          ) : null}
        </CardBody>
      </Card>

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardBody>
          <FormField id="checkout-book" label={t('loans.checkout.book')} required>
            <Combobox<BookOption>
              id="checkout-book"
              placeholder={t('loans.checkout.bookPlaceholder')}
              clearLabel={t('common.combobox.clear')}
              noMatchesText={t('common.combobox.noMatches')}
              value={book}
              onChange={(b) => {
                setBook(b);
                setCopyId('');
              }}
              endpoint={(q) => `/t/${slug}/catalog/books?q=${encodeURIComponent(q)}&limit=8`}
              renderOption={(b) => (
                <div>
                  <div style={{ fontWeight: 500 }}>{b.title}</div>
                  <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
                    {b.authors.map((a) => a.fullName).join(', ') || '—'}
                  </div>
                </div>
              )}
              renderSelected={(b) => (
                <div>
                  <div style={{ fontWeight: 500 }}>{b.title}</div>
                  <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
                    {b.authors.map((a) => a.fullName).join(', ') || '—'}
                  </div>
                </div>
              )}
            />
          </FormField>
          {canScan ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              style={{ marginTop: 'var(--sp-2)' }}
              onClick={() => setScanTarget('copy')}
            >
              {t('loans.checkout.scanBook')}
            </Button>
          ) : null}

          {book ? (
            <div style={{ marginTop: 'var(--sp-3)' }}>
              <FormField
                id="checkout-copy"
                label={t('loans.checkout.copy')}
                hint={t('loans.checkout.copyHint')}
                required
              >
                {copiesLoading ? (
                  <p style={{ color: 'var(--color-text-muted)' }}>{t('common.states.loading')}</p>
                ) : copiesError ? (
                  <p role="alert" style={{ color: 'var(--color-danger)' }}>
                    {copiesError}
                  </p>
                ) : availableCopies.length === 0 ? (
                  <Banner severity="warning">
                    {t('loans.checkout.noAvailableCopies', {
                      title: book.title,
                    })}
                  </Banner>
                ) : (
                  <select
                    id="checkout-copy"
                    className="lbr-input"
                    value={copyId}
                    onChange={(e) => setCopyId(e.currentTarget.value)}
                  >
                    {availableCopies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.barcode}
                        {c.shelfLocation ? ` · ${c.shelfLocation}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardBody>
          <FormField
            id="checkout-due"
            label={t('loans.checkout.dueAt')}
            hint={t('loans.checkout.dueAtHint', { days: defaultLoanPeriodDays })}
            required
          >
            <Input
              id="checkout-due"
              type="date"
              value={dueAt}
              min={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setDueAt(e.currentTarget.value)}
            />
          </FormField>
          <FormField id="checkout-notes" label={t('loans.checkout.notes')}>
            <Textarea
              id="checkout-notes"
              placeholder={t('loans.checkout.notesPlaceholder')}
              value={notes}
              onChange={(e) => setNotes(e.currentTarget.value)}
              rows={3}
            />
          </FormField>
        </CardBody>
      </Card>

      <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
        <Link href={`/${locale}/t/${slug}/loans`} className="lbr-btn lbr-btn--ghost lbr-btn--md">
          {t('common.actions.cancel')}
        </Link>
        <Button
          type="submit"
          variant="primary"
          loading={submitting}
          disabled={!member || !book || !copyId}
        >
          {t('loans.checkout.submit')}
        </Button>
      </div>
    </form>
  );
}
