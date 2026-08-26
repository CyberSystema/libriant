'use client';
import * as React from 'react';
import Link from 'next/link';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FormError,
  FormField,
  Modal,
  Textarea,
  useToast,
} from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator, formatDate } from '@libriant/i18n';
import { ApiError, ApiUnavailableError, api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import { useIdempotencyKey } from '@/lib/useIdempotencyKey';
import { formatMoney } from '@/components/money';

/**
 * The desk's money drawer, on the two screens that already showed a fine and
 * could do nothing about it.
 *
 * A `Fine` row has always been created two ways — an overdue item coming back,
 * and the nightly accrual sweep that keeps growing it — and until the fines
 * endpoints existed nothing in the product could ever close one. A member
 * handing €2.40 over the counter could not be recorded; a fine raised by
 * mistake was permanent and kept growing; and GDPR erasure, which correctly
 * refuses while a member owes the library money, was therefore unreachable for
 * anyone who had ever been overdue. This panel is the half a librarian touches.
 *
 * WHY THE TWO ACTIONS DO NOT LOOK ALIKE. Recording a payment is clerical — the
 * coins are already in the drawer and the library is writing down what
 * happened — so it is the row's primary button, one click from the amount it
 * settles. Writing a fine off is the only thing in the product that turns money
 * the library is owed into money it is not owed, it leaves nothing behind but
 * an audit row, and it has no undo. It sits behind a quieter, separately
 * labelled control, is shown only to owners/admins (the API enforces the same),
 * and its dialog makes you say in words which of the two write-offs this is
 * before the button arms.
 *
 * WHY FAILURES LAND IN THE DIALOG, NOT IN A TOAST. Both actions happen inside
 * an open `<dialog>`, and a modal dialog makes everything outside itself inert:
 * a toast fired from here can be read but never clicked, and is painted under
 * the backdrop unless the stack re-promotes itself. `Modal`'s `error` slot
 * exists for exactly this (see packages/ui/src/layers.ts) — a 409 that says the
 * fine grew overnight has to be readable *and* actionable where the librarian
 * still is. Successes, which close the dialog, go to a toast as usual.
 *
 * The strings live in the `loans` catalogue next to the rest of circulation,
 * even though half of them render on the member page: `loadCatalog` merges
 * every namespace, and a fine is a circulation event wherever it is displayed.
 */

export type FineStatus = 'outstanding' | 'paid' | 'waived';

/** One fine, exactly as `GET /t/:slug/fines` serialises it (dates as ISO strings). */
export type Fine = {
  id: string;
  memberId: string;
  loanId: string | null;
  /** Integer subunits of `currency`. Never changes when the fine is settled. */
  amountCents: number;
  currency: string;
  /** Why the money was owed. A write-off never overwrites it. */
  reason: string;
  status: FineStatus;
  paidAt: string | null;
  /** Display-only; the exact record is the audit row. Null while outstanding. */
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  member: {
    id: string;
    memberNumber: string;
    fullName: string;
    status: 'active' | 'suspended' | 'archived';
  };
  loan: {
    id: string;
    dueAt: string;
    returnedAt: string | null;
    status: 'active' | 'returned' | 'lost';
    copy: { id: string; barcode: string; book: { id: string; title: string } };
  } | null;
};

/** What one member currently owes, library-wide — not a total of the page. */
export type MemberFinesSummary = {
  memberId: string;
  outstandingCount: number;
  outstandingCents: number;
  currency: string;
};

export type FinesListResponse = {
  items: Fine[];
  nextCursor: string | null;
  /** Non-null only when the request carried `?memberId=`. */
  summary: MemberFinesSummary | null;
  tenantSummary: { outstandingCount: number; outstandingCents: number; currency: string };
};

type ResolveResponse = { fine: Fine; member: MemberFinesSummary };

type Scope = { kind: 'member'; memberId: string } | { kind: 'loan'; loanId: string };

type Props = {
  slug: string;
  locale: Locale;
  catalog: Catalog;
  /** Which fines this panel is about — one member's, or one loan's. */
  scope: Scope;
  /** Server-rendered first page, so the desk sees the debt before JS hydrates. */
  initial: FinesListResponse;
  /** owner | admin | librarian — may record a payment. */
  canSettle: boolean;
  /** owner | admin — may write a fine off. */
  canWriteOff: boolean;
  /**
   * Called with the member's recomputed totals after every resolution, so the
   * member page's "outstanding fines" line moves the instant the money is
   * recorded instead of waiting for a reload. The API hands these back with the
   * resolution precisely so no second request is needed.
   */
  onSummaryChange?: (summary: MemberFinesSummary) => void;
};

const PAGE_SIZE = 25;

export function FinesPanel({
  slug,
  locale,
  catalog,
  scope,
  initial,
  canSettle,
  canWriteOff,
  onSummaryChange,
}: Props) {
  const t = createTranslator(catalog, locale);
  const toast = useToast();
  const money = React.useCallback(
    (cents: number, currency: string) => formatMoney(cents, currency, locale),
    [locale],
  );

  const [items, setItems] = React.useState<Fine[]>(initial.items);
  const [nextCursor, setNextCursor] = React.useState<string | null>(initial.nextCursor);
  const [summary, setSummary] = React.useState<MemberFinesSummary | null>(initial.summary);
  // A loan's fines are all of them, always: there are two or three and the
  // history is the point. A member's list starts at what is actually owed —
  // that is what the person at the counter is asking about — and settled fines
  // are one click away for when they dispute a charge.
  const [showAll, setShowAll] = React.useState(scope.kind === 'loan');
  const [listBusy, setListBusy] = React.useState(false);
  const [listError, setListError] = React.useState<string | null>(null);

  // Which fine has a dialog open, by id rather than by value: the 409 that says
  // "this fine grew overnight" corrects the row in `items`, and the open dialog
  // has to re-render with the new amount so the next click sends what the member
  // is actually being asked for.
  const [pending, setPending] = React.useState<{ id: string; action: 'pay' | 'writeOff' } | null>(
    null,
  );
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  // One key per SUCCESSFUL resolution, rotated after each one. Every retry in
  // between — the double-click, the resubmit after a refused 409, the second
  // attempt when the first response never arrived — carries the same key, so
  // the money can only move once. (A refused call releases the key server-side,
  // so a corrected resubmit runs for real rather than replaying the refusal.)
  // One key spanning two different fines is harmless: the route carries the
  // fine id, and the interceptor's key includes the path.
  const { key: idempotencyKey, rotate } = useIdempotencyKey();

  // A server re-render (router.refresh() after a return, say) is authoritative.
  React.useEffect(() => {
    setItems(initial.items);
    setNextCursor(initial.nextCursor);
    setSummary(initial.summary);
  }, [initial]);

  const activeFine = pending ? (items.find((f) => f.id === pending.id) ?? null) : null;

  function listPath(opts: { all: boolean; after?: string | null }): string {
    const params = new URLSearchParams();
    if (scope.kind === 'member') params.set('memberId', scope.memberId);
    else params.set('loanId', scope.loanId);
    if (!opts.all) params.set('status', 'outstanding');
    if (opts.after) params.set('after', opts.after);
    params.set('limit', String(PAGE_SIZE));
    return `/t/${slug}/fines?${params.toString()}`;
  }

  async function applyFilter(all: boolean) {
    setListBusy(true);
    setListError(null);
    try {
      const res = await api<FinesListResponse>(listPath({ all }));
      setItems(res.items);
      setNextCursor(res.nextCursor);
      setSummary(res.summary);
      setShowAll(all);
    } catch (err) {
      setListError(translateApiError(err, t, t('loans.fines.loadFailed')));
    } finally {
      setListBusy(false);
    }
  }

  async function loadMore() {
    if (!nextCursor || listBusy) return;
    setListBusy(true);
    setListError(null);
    try {
      const res = await api<FinesListResponse>(listPath({ all: showAll, after: nextCursor }));
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setListError(translateApiError(err, t, t('loans.fines.loadFailed')));
    } finally {
      setListBusy(false);
    }
  }

  function openDialog(fine: Fine, action: 'pay' | 'writeOff') {
    setFormError(null);
    setPending({ id: fine.id, action });
  }

  function closeDialog() {
    if (busy) return; // never yank the dialog out from under a request in flight
    setPending(null);
    setFormError(null);
  }

  /**
   * Turn a failed resolution into a sentence for the dialog — and, where the API
   * told us something true about the row, correct the row while we are at it.
   */
  function describeFailure(err: unknown, fine: Fine): string {
    if (err instanceof ApiError && err.status === 409) {
      const current = err.body.currentAmountCents;
      if (typeof current === 'number') {
        // The accrual sweep grew it while this page sat open. Show the new
        // figure on the row and in the dialog so the librarian can re-confirm
        // with the member and submit the amount they are really collecting.
        const currency = typeof err.body.currency === 'string' ? err.body.currency : fine.currency;
        setItems((prev) =>
          prev.map((f) => (f.id === fine.id ? { ...f, amountCents: current, currency } : f)),
        );
        return t('loans.fines.errors.stale', {
          amount: money(current, currency),
          previous: money(fine.amountCents, fine.currency),
        });
      }
      const settled = typeof err.body.fineStatus === 'string' ? err.body.fineStatus : null;
      if (settled === 'paid' || settled === 'waived') {
        // Another station got there first. Retire the row's actions so the
        // dialog is not the only place saying so.
        setItems((prev) => prev.map((f) => (f.id === fine.id ? { ...f, status: settled } : f)));
        return t(
          settled === 'paid'
            ? 'loans.fines.errors.alreadyPaid'
            : 'loans.fines.errors.alreadyWaived',
        );
      }
      return translateApiError(err, t, t('common.states.error'));
    }
    if (err instanceof ApiUnavailableError) {
      // Money is deliberately NOT put on the offline queue: the queue replays up
      // to 18 hours later, and a payment that lands the next morning — after the
      // sweep has grown the fine, or after someone waived it — is worse than one
      // that plainly did not happen. Say so, so nobody walks away believing the
      // €2.40 was recorded.
      return `${translateApiError(err, t)} ${t('loans.fines.errors.notRecorded')}`;
    }
    return translateApiError(err, t, t('common.states.error'));
  }

  async function resolve(
    fine: Fine,
    path: 'pay' | 'waive' | 'void',
    body: Record<string, unknown>,
    successTitle: string,
  ) {
    setBusy(true);
    setFormError(null);
    try {
      const res = await api<ResolveResponse>(`/t/${slug}/fines/${fine.id}/${path}`, {
        method: 'POST',
        body,
        idempotencyKey,
      });
      // Keep the settled fine on screen carrying its new status. Dropping it
      // would be the same silence as before: the librarian needs to see that the
      // thing they just did landed on this fine, not infer it from a gap.
      setItems((prev) => prev.map((f) => (f.id === res.fine.id ? res.fine : f)));
      setSummary(res.member);
      onSummaryChange?.(res.member);
      rotate();
      setPending(null);
      toast.show({ severity: 'success', title: successTitle });
    } catch (err) {
      setFormError(describeFailure(err, fine));
    } finally {
      setBusy(false);
    }
  }

  const outstandingOnPage = items.filter((f) => f.status === 'outstanding');
  const showActions = (canSettle || canWriteOff) && outstandingOnPage.length > 0;
  // A loan's own total is computed from the rows because the API only returns a
  // summary for `?memberId=`. Only shown when the list is complete — a figure
  // built from page one of a paginated list would understate the debt, which is
  // the one direction a money total must never be wrong in.
  const loanOwedCents =
    scope.kind === 'loan' && nextCursor === null
      ? outstandingOnPage.reduce((sum, f) => sum + f.amountCents, 0)
      : null;
  const loanCurrency = items[0]?.currency ?? initial.tenantSummary.currency;

  return (
    <>
      <Card>
        <CardHeader
          title={t('loans.fines.title')}
          actions={
            scope.kind === 'member' ? (
              <Button
                variant="secondary"
                size="sm"
                loading={listBusy}
                onClick={() => void applyFilter(!showAll)}
              >
                {showAll ? t('loans.fines.filter.outstandingOnly') : t('loans.fines.filter.all')}
              </Button>
            ) : null
          }
        />
        <CardBody>
          <FormError style={{ marginBottom: 'var(--sp-4)' }}>{listError}</FormError>

          {scope.kind === 'member' ? (
            <p style={{ marginTop: 0, marginBottom: 'var(--sp-4)' }}>
              {summary && summary.outstandingCount > 0 ? (
                <>
                  <strong>
                    {t('loans.fines.summary.owed', {
                      amount: money(summary.outstandingCents, summary.currency),
                    })}
                  </strong>
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    {' · '}
                    {t('loans.fines.summary.count', { count: summary.outstandingCount })}
                  </span>
                </>
              ) : (
                <span style={{ color: 'var(--color-text-muted)' }}>
                  {t('loans.fines.summary.none')}
                </span>
              )}
            </p>
          ) : loanOwedCents !== null && loanOwedCents > 0 ? (
            <p style={{ marginTop: 0, marginBottom: 'var(--sp-4)' }}>
              <strong>
                {t('loans.fines.summary.loanOwed', { amount: money(loanOwedCents, loanCurrency) })}
              </strong>
            </p>
          ) : null}

          {items.length === 0 ? (
            // "Nothing outstanding" is already the member headline above; repeating
            // it as the list's empty text would say the same sentence twice.
            scope.kind === 'member' && !showAll ? null : (
              <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
                {t('loans.fines.empty')}
              </p>
            )
          ) : (
            <div className="lbr-table-wrap lbr-table-wrap--cards">
              <table className="lbr-table lbr-table--cards">
                <thead>
                  <tr>
                    <th>{t('loans.fines.columns.reason')}</th>
                    <th>{t('loans.fines.columns.amount')}</th>
                    <th>{t('loans.fines.columns.status')}</th>
                    {showActions ? <th>{t('loans.fines.columns.actions')}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {items.map((fine) => (
                    <tr key={fine.id}>
                      <td data-label={t('loans.fines.columns.reason')}>
                        <div>{fine.reason}</div>
                        {scope.kind === 'member' && fine.loan ? (
                          <div style={{ fontSize: 'var(--fs-xs)' }}>
                            <Link href={`/${locale}/t/${slug}/loans/${fine.loan.id}`}>
                              {fine.loan.copy.book.title}
                            </Link>
                            <span style={{ color: 'var(--color-text-muted)' }}>
                              {' · '}
                              {fine.loan.copy.barcode}
                            </span>
                          </div>
                        ) : null}
                        <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
                          {t('loans.fines.raisedOn', {
                            date: formatDate(new Date(fine.createdAt), locale),
                          })}
                        </div>
                      </td>
                      <td data-label={t('loans.fines.columns.amount')}>
                        {money(fine.amountCents, fine.currency)}
                      </td>
                      <td data-label={t('loans.fines.columns.status')}>
                        <StatusCell fine={fine} catalog={catalog} locale={locale} />
                      </td>
                      {showActions ? (
                        <td data-label="">
                          {fine.status === 'outstanding' ? (
                            <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
                              {canSettle ? (
                                <Button
                                  variant="primary"
                                  size="sm"
                                  onClick={() => openDialog(fine, 'pay')}
                                >
                                  {t('loans.fines.pay.action')}
                                </Button>
                              ) : null}
                              {canWriteOff ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => openDialog(fine, 'writeOff')}
                                >
                                  {t('loans.fines.writeOff.action')}
                                </Button>
                              ) : null}
                            </div>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!canSettle && outstandingOnPage.length > 0 ? (
            // A volunteer can see the debt but not record it. Say why, or the desk
            // reads the missing button as a broken screen.
            <p
              style={{
                color: 'var(--color-text-muted)',
                fontSize: 'var(--fs-sm)',
                marginBottom: 0,
              }}
            >
              {t('loans.fines.staffOnly')}
            </p>
          ) : null}

          {nextCursor ? (
            <div style={{ marginTop: 'var(--sp-4)' }}>
              <Button variant="secondary" loading={listBusy} onClick={() => void loadMore()}>
                {t('common.actions.loadMore')}
              </Button>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {activeFine && pending?.action === 'pay' ? (
        <PayFineModal
          fine={activeFine}
          catalog={catalog}
          locale={locale}
          busy={busy}
          error={formError}
          onClose={closeDialog}
          onSubmit={(notes) =>
            resolve(
              activeFine,
              'pay',
              {
                // Always sent, never inferred server-side: the sweep grows a fine
                // overnight, and without it the API would stamp "paid in full" on
                // a €2.90 debt because €2.40 was in the drawer.
                amountCents: activeFine.amountCents,
                ...(notes.trim().length ? { notes: notes.trim() } : {}),
              },
              t('loans.fines.pay.success', {
                amount: money(activeFine.amountCents, activeFine.currency),
              }),
            )
          }
        />
      ) : null}

      {activeFine && pending?.action === 'writeOff' ? (
        <WriteOffModal
          fine={activeFine}
          catalog={catalog}
          locale={locale}
          busy={busy}
          error={formError}
          onClose={closeDialog}
          onSubmit={(kind, reason) =>
            resolve(
              activeFine,
              kind === 'waive' ? 'waive' : 'void',
              { reason },
              t(
                kind === 'waive'
                  ? 'loans.fines.writeOff.waivedSuccess'
                  : 'loans.fines.writeOff.voidedSuccess',
              ),
            )
          }
        />
      ) : null}
    </>
  );
}

/**
 * Status, plus the date it stopped being outstanding.
 *
 * `resolvedAt` is derived by the API (the schema has `paidAt` and no
 * `waivedAt`), so it is shown as context next to the word — never as the
 * authoritative record, which is the audit row.
 */
function StatusCell({ fine, catalog, locale }: { fine: Fine; catalog: Catalog; locale: Locale }) {
  const t = createTranslator(catalog, locale);
  const label = t(`loans.fines.status.${fine.status}`);
  if (fine.status === 'outstanding') {
    return <span style={{ color: 'var(--color-danger)' }}>{label}</span>;
  }
  return (
    <span>
      <span style={{ color: 'var(--color-success)' }}>{label}</span>
      {fine.resolvedAt ? (
        <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
          {' · '}
          {formatDate(new Date(fine.resolvedAt), locale)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * "The member is handing me coins." The amount is the headline because it is
 * the one thing that has to match what is on the counter, and because it may
 * have moved since the page was rendered.
 */
function PayFineModal({
  fine,
  catalog,
  locale,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  fine: Fine;
  catalog: Catalog;
  locale: Locale;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (notes: string) => Promise<void>;
}) {
  const t = createTranslator(catalog, locale);
  const [notes, setNotes] = React.useState('');
  const amount = formatMoney(fine.amountCents, fine.currency, locale);

  return (
    <Modal
      open
      onClose={onClose}
      title={t('loans.fines.pay.title', { amount })}
      error={error}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void onSubmit(notes)}>
            {t('loans.fines.pay.submit')}
          </Button>
        </>
      }
    >
      <p style={{ marginTop: 0, fontSize: 'var(--fs-2xl)', fontWeight: 600 }}>{amount}</p>
      <p style={{ marginTop: 0, color: 'var(--color-text-muted)' }}>
        {fine.reason}
        {' · '}
        {fine.member.fullName}
      </p>
      <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-sm)' }}>
        {t('loans.fines.pay.fullOnly')}
      </p>
      <FormField
        id="fine-pay-notes"
        label={t('loans.fines.pay.notes')}
        hint={t('loans.fines.pay.notesHint')}
      >
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.currentTarget.value)}
          rows={2}
          maxLength={2000}
        />
      </FormField>
    </Modal>
  );
}

/**
 * The heavy one. Two different things share the `waived` status because the
 * schema has three statuses and a fourth would be a migration across every
 * tenant database — but they are different events in the record, and the
 * librarian is the only one who knows which happened, so the dialog asks
 * instead of guessing. A waiver says the debt was real and the library chose
 * not to collect it; a void says there was never a debt. Recording the second
 * as the first puts a false statement about a patron's money into the file that
 * gets read back to them when they dispute the charge.
 *
 * Nothing is armed until a kind is chosen and a reason is typed — the reason is
 * required by the API and is the whole of the accounting record for money that
 * stops being owed.
 */
function WriteOffModal({
  fine,
  catalog,
  locale,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  fine: Fine;
  catalog: Catalog;
  locale: Locale;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (kind: 'waive' | 'void', reason: string) => Promise<void>;
}) {
  const t = createTranslator(catalog, locale);
  const [kind, setKind] = React.useState<'waive' | 'void' | null>(null);
  const [reason, setReason] = React.useState('');
  const [touched, setTouched] = React.useState(false);
  const amount = formatMoney(fine.amountCents, fine.currency, locale);
  const trimmed = reason.trim();
  const reasonOk = trimmed.length >= 3 && trimmed.length <= 500;
  const armed = kind !== null && reasonOk;

  function submit() {
    setTouched(true);
    if (!armed || busy) return;
    void onSubmit(kind, trimmed);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('loans.fines.writeOff.title', { amount })}
      role="alertdialog"
      error={error}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="danger" loading={busy} disabled={!armed} onClick={submit}>
            {/* The label follows the choice: until one is made the button is
                both neutral and disabled, so it never promises "waive" for
                what the librarian is about to record as an error. */}
            {kind === 'waive'
              ? t('loans.fines.writeOff.submitWaive')
              : kind === 'void'
                ? t('loans.fines.writeOff.submitVoid')
                : t('loans.fines.writeOff.submit')}
          </Button>
        </>
      }
    >
      <p style={{ marginTop: 0, color: 'var(--color-text-muted)' }}>
        {fine.reason}
        {' · '}
        {fine.member.fullName}
      </p>

      <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="lbr-field__label">{t('loans.fines.writeOff.choose')}</legend>
        <WriteOffChoice
          name="fine-write-off-kind"
          value="waive"
          checked={kind === 'waive'}
          onChange={() => setKind('waive')}
          label={t('loans.fines.writeOff.waiveLabel')}
          description={t('loans.fines.writeOff.waiveHint')}
          disabled={busy}
        />
        <WriteOffChoice
          name="fine-write-off-kind"
          value="void"
          checked={kind === 'void'}
          onChange={() => setKind('void')}
          label={t('loans.fines.writeOff.voidLabel')}
          description={t('loans.fines.writeOff.voidHint')}
          disabled={busy}
        />
      </fieldset>

      <FormField
        id="fine-write-off-reason"
        label={t('loans.fines.writeOff.reason')}
        hint={t('loans.fines.writeOff.reasonHint')}
        error={touched && !reasonOk ? t('loans.fines.writeOff.reasonRequired') : undefined}
        required
      >
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          onBlur={() => setTouched(true)}
          rows={3}
          maxLength={500}
          disabled={busy}
        />
      </FormField>

      <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-sm)', marginBottom: 0 }}>
        {t('loans.fines.writeOff.irreversible')}
      </p>
    </Modal>
  );
}

function WriteOffChoice({
  name,
  value,
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  description: string;
  disabled: boolean;
}) {
  return (
    <label
      style={{
        display: 'flex',
        gap: 'var(--sp-3)',
        alignItems: 'flex-start',
        padding: 'var(--sp-2) 0',
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        style={{ marginTop: '0.25rem' }}
      />
      <span>
        <span style={{ fontWeight: 500 }}>{label}</span>
        <span
          style={{
            display: 'block',
            color: 'var(--color-text-muted)',
            fontSize: 'var(--fs-sm)',
          }}
        >
          {description}
        </span>
      </span>
    </label>
  );
}
