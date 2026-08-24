'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';

type ReservationLite = {
  id: string;
  status: 'queued' | 'ready' | 'fulfilled' | 'expired' | 'canceled';
  book: { title: string };
  member: { fullName: string };
};

type Props = {
  slug: string;
  reservation: ReservationLite;
  catalog: Catalog;
  locale: Locale;
};

/**
 * Inline actions for a reservation row.
 *
 *   - `queued` or `ready` → **Cancel** (DELETE `/reservations/:id`)
 *   - `ready`              → **Fulfill** (POST `/reservations/:id/fulfill`,
 *                            creates the Loan from the held copy)
 *   - resolved             → no action; the row is read-only history
 *
 * Both actions confirm in a toast with an Undo for cancel (cancels the
 * cancel — see `placeHold` round-trip in Step 14).
 */
export function ReservationRowActions({ slug, reservation, catalog, locale }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState<'cancel' | 'fulfill' | null>(null);

  const isActive = reservation.status === 'queued' || reservation.status === 'ready';
  if (!isActive) {
    return <span style={{ color: 'var(--color-text-muted)' }}>—</span>;
  }

  async function call(verb: 'cancel' | 'fulfill') {
    setBusy(verb);
    try {
      if (verb === 'cancel') {
        await api(`/t/${slug}/reservations/${reservation.id}`, { method: 'DELETE' });
        toast.show({
          severity: 'success',
          title: t('reservations.actions.cancelSuccess'),
          body: reservation.book.title,
        });
      } else {
        await api(`/t/${slug}/reservations/${reservation.id}/fulfill`, {
          method: 'POST',
          body: {},
        });
        toast.show({
          severity: 'success',
          title: t('reservations.actions.fulfillSuccess'),
          body: `${reservation.book.title} → ${reservation.member.fullName}`,
        });
      }
      router.refresh();
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: translateApiError(err, t, t('common.states.error')),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: 'flex', gap: 'var(--sp-1)' }}>
      {reservation.status === 'ready' ? (
        <Button
          size="sm"
          variant="primary"
          loading={busy === 'fulfill'}
          onClick={() => call('fulfill')}
        >
          {t('reservations.actions.fulfill')}
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" loading={busy === 'cancel'} onClick={() => call('cancel')}>
        {t('reservations.actions.cancel')}
      </Button>
    </div>
  );
}
