'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, FormField, Input, Modal, Textarea, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { ApiError, api } from '@/lib/api';
import { printDocument } from '@/lib/print';
import { useIdempotencyKey } from '@/lib/useIdempotencyKey';
import { useOfflineQueue } from '@/components/OfflineQueueProvider';
import { isNetworkError, type CirculationKind } from '@/lib/offline-queue';

type LoanShape = {
  id: string;
  status: 'active' | 'returned' | 'lost';
  renewedCount: number;
  copy: { barcode: string; book: { title: string } };
  member: { fullName: string };
};

type Props = {
  slug: string;
  loan: LoanShape;
  catalog: Catalog;
  locale: Locale;
};

/**
 * Action row on a loan's detail page. Three modal-driven actions:
 *
 *   - **Return** — captures condition (ok / damaged) + optional notes.
 *     Fires POST `/loans/:id/return`; success toast surfaces the overdue
 *     fine (if any) and the promoted hold (if one was queued).
 *   - **Renew** — choose how many periods to extend by. The API enforces
 *     the `maxRenewals` cap and refuses when a hold is queued.
 *   - **Mark lost** — optional replacement cost in cents. Fires POST
 *     `/loans/:id/mark-lost`.
 *
 * Closed loans (status != 'active') render only a back-link disabled state
 * so the librarian can't accidentally double-return.
 */
export function LoanActions({ slug, loan, catalog, locale }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const [openModal, setOpenModal] = React.useState<'return' | 'renew' | 'lost' | null>(null);
  // One key per action attempt: a double-click / retry replays instead of
  // acting twice (server dedupes per route+key). Rotated after each success so
  // a deliberate repeat (e.g. renewing again) is a new operation.
  const { key: idempotencyKey, rotate } = useIdempotencyKey();
  const { enqueue } = useOfflineQueue();
  const [printing, setPrinting] = React.useState(false);

  // Print a checkout/return slip. Read-only — no offline queue, no idempotency
  // key. In the desktop shell this is a silent job; in a browser it opens the
  // print route, which raises the dialog itself.
  async function printReceipt() {
    setPrinting(true);
    try {
      const res = await printDocument({ locale, slug, kind: 'receipt', id: loan.id });
      toast.show(
        res.ok
          ? { severity: 'success', title: t('loans.print.sent') }
          : { severity: 'critical', title: t('loans.print.failed') },
      );
    } finally {
      setPrinting(false);
    }
  }

  if (loan.status !== 'active') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
        <p
          style={{
            padding: 'var(--sp-3) var(--sp-4)',
            background: 'var(--color-surface-muted)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--color-text-muted)',
            fontSize: 'var(--fs-sm)',
            margin: 0,
          }}
        >
          {loan.status === 'returned'
            ? t('loans.actions.closedReturned')
            : t('loans.actions.closedLost')}
        </p>
        <div>
          <Button variant="secondary" loading={printing} onClick={printReceipt}>
            {t('loans.print.printReceipt')}
          </Button>
        </div>
      </div>
    );
  }

  async function call(path: string, body: Record<string, unknown>) {
    try {
      const res = (await api<{
        loan: { id: string; status: string };
        fine?: { amountCents: number; currency: string } | null;
        promotedHold?: { memberFullName: string } | null;
      }>(`/t/${slug}/loans/${loan.id}/${path}`, { method: 'POST', body, idempotencyKey })) as
        | {
            loan: { status: string };
            fine: { amountCents: number; currency: string } | null;
            promotedHold: { memberFullName: string } | null;
          }
        | { id: string; status: string };
      rotate(); // succeeded — next action gets a fresh key
      setOpenModal(null);
      if ('loan' in res && res.loan) {
        const fineMsg = res.fine
          ? ` · ${t('loans.actions.fineCreated', {
              amount: (res.fine.amountCents / 100).toFixed(2),
              currency: res.fine.currency,
            })}`
          : '';
        const holdMsg = res.promotedHold
          ? ` · ${t('loans.actions.holdPromoted', { name: res.promotedHold.memberFullName })}`
          : '';
        toast.show({
          severity: 'success',
          title: t(`loans.actions.${path}Success`),
          body: `${loan.copy.book.title}${fineMsg}${holdMsg}`,
        });
      } else {
        toast.show({
          severity: 'success',
          title: t(`loans.actions.${path}Success`),
        });
      }
      router.refresh();
    } catch (err) {
      if (isNetworkError(err)) {
        // Offline — queue the action and replay it (idempotently) on reconnect.
        const queued = await enqueue({
          idempotencyKey,
          path: `/t/${slug}/loans/${loan.id}/${path}`,
          body,
          kind: path as CirculationKind,
          label: loan.copy.book.title,
        });
        rotate();
        setOpenModal(null);
        toast.show(
          queued
            ? { severity: 'info', title: t('loans.queue.queued') }
            : { severity: 'critical', title: t('loans.queue.saveFailed') },
        );
        return;
      }
      toast.show({
        severity: 'critical',
        title: err instanceof ApiError ? err.message : t('common.states.error'),
      });
    }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
        <Button variant="primary" onClick={() => setOpenModal('return')}>
          {t('loans.actions.return')}
        </Button>
        <Button variant="secondary" onClick={() => setOpenModal('renew')}>
          {t('loans.actions.renew')}
        </Button>
        <Button variant="ghost" onClick={() => setOpenModal('lost')}>
          {t('loans.actions.markLost')}
        </Button>
        <Button variant="secondary" loading={printing} onClick={printReceipt}>
          {t('loans.print.printReceipt')}
        </Button>
      </div>

      <ReturnModal
        open={openModal === 'return'}
        onClose={() => setOpenModal(null)}
        onSubmit={(condition, notes) => call('return', { condition, notes })}
        catalog={catalog}
        locale={locale}
        title={t('loans.actions.returnTitle', { book: loan.copy.book.title })}
      />
      <RenewModal
        open={openModal === 'renew'}
        onClose={() => setOpenModal(null)}
        onSubmit={(periods) => call('renew', { periods })}
        catalog={catalog}
        locale={locale}
        title={t('loans.actions.renewTitle', { book: loan.copy.book.title })}
      />
      <MarkLostModal
        open={openModal === 'lost'}
        onClose={() => setOpenModal(null)}
        onSubmit={(cents, notes) => call('mark-lost', { replacementCostCents: cents, notes })}
        catalog={catalog}
        locale={locale}
        title={t('loans.actions.markLostTitle', { book: loan.copy.book.title })}
      />
    </>
  );
}

function ReturnModal({
  open,
  onClose,
  onSubmit,
  catalog,
  locale,
  title,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (condition: 'ok' | 'damaged', notes: string) => Promise<void>;
  catalog: Catalog;
  locale: Locale;
  title: string;
}) {
  const t = createTranslator(catalog, locale);
  const [condition, setCondition] = React.useState<'ok' | 'damaged'>('ok');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(condition, notes);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('loans.actions.return')}
          </Button>
        </>
      }
    >
      <FormField id="return-condition" label={t('loans.actions.condition')}>
        <select
          id="return-condition"
          className="lbr-input"
          value={condition}
          onChange={(e) => setCondition(e.currentTarget.value as 'ok' | 'damaged')}
        >
          <option value="ok">{t('loans.actions.condition.ok')}</option>
          <option value="damaged">{t('loans.actions.condition.damaged')}</option>
        </select>
      </FormField>
      <FormField id="return-notes" label={t('loans.actions.notes')}>
        <Textarea
          id="return-notes"
          value={notes}
          onChange={(e) => setNotes(e.currentTarget.value)}
          rows={3}
        />
      </FormField>
    </Modal>
  );
}

function RenewModal({
  open,
  onClose,
  onSubmit,
  catalog,
  locale,
  title,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (periods: number) => Promise<void>;
  catalog: Catalog;
  locale: Locale;
  title: string;
}) {
  const t = createTranslator(catalog, locale);
  const [periods, setPeriods] = React.useState(1);
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(periods);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('loans.actions.renew')}
          </Button>
        </>
      }
    >
      <FormField
        id="renew-periods"
        label={t('loans.actions.periods')}
        hint={t('loans.actions.periodsHint')}
      >
        <Input
          id="renew-periods"
          type="number"
          min={1}
          max={10}
          value={periods}
          onChange={(e) => setPeriods(Math.max(1, Number(e.currentTarget.value) || 1))}
        />
      </FormField>
    </Modal>
  );
}

function MarkLostModal({
  open,
  onClose,
  onSubmit,
  catalog,
  locale,
  title,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (cents: number, notes: string) => Promise<void>;
  catalog: Catalog;
  locale: Locale;
  title: string;
}) {
  const t = createTranslator(catalog, locale);
  const [amount, setAmount] = React.useState('0.00');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      role="alertdialog"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const cents = Math.round(Number(amount) * 100);
                await onSubmit(isFinite(cents) && cents > 0 ? cents : 0, notes);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('loans.actions.markLost')}
          </Button>
        </>
      }
    >
      <FormField
        id="lost-amount"
        label={t('loans.actions.replacementCost')}
        hint={t('loans.actions.replacementCostHint')}
      >
        <Input
          id="lost-amount"
          type="number"
          min={0}
          step={0.01}
          value={amount}
          onChange={(e) => setAmount(e.currentTarget.value)}
        />
      </FormField>
      <FormField id="lost-notes" label={t('loans.actions.notes')}>
        <Textarea
          id="lost-notes"
          value={notes}
          onChange={(e) => setNotes(e.currentTarget.value)}
          rows={3}
        />
      </FormField>
    </Modal>
  );
}
