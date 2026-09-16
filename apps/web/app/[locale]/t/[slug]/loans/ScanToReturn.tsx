'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { dataPort } from '@/lib/ports';
import { BarcodeScanner, SCAN_FORMATS, scanningSupported } from '@/components/BarcodeScanner';

type Props = { slug: string; locale: Locale; catalog: Catalog };

/**
 * Desk "scan to return" on the loans page, on the 2.0 surface (phase 20q).
 *
 * Scan a returned copy's barcode → resolve the copy → find its OPEN loan → jump
 * to that loan's detail page, where the librarian returns it. We deliberately
 * still DON'T auto-return, and 2.0 makes that more important rather than less:
 * `POST /circulation/checkin` takes the barcode directly, so returning on the
 * scan would be one tap with no confirmation — and a 2.0 check-in closes the
 * loan, moves the copy's status, may promote a hold, may open a transfer and may
 * charge an overdue fine, none of which has an undo. A human glance first is
 * cheap; five audited side effects on the wrong copy are not.
 *
 * ## `?open=1`, never `?status=active`
 *
 * 2.0's open set is FOUR statuses — `loans_closed_consistency` makes it
 * `(closed_at IS NULL) = status IN ('active','claims_returned',
 * 'claims_never_borrowed','recalled')`. Asking for `active` would answer "no
 * open loan for that barcode — nothing to return" for a recalled copy or one
 * whose reader claims to have brought it back already, which is the wrong answer
 * said confidently, at the one moment the copy is physically in the librarian's
 * hand. `?open=1` is also the form that walks `loans_one_open_per_item`, the
 * UNIQUE partial index on exactly this question.
 *
 * Renders nothing when the browser can't scan — the librarian just opens the
 * loan and returns it by hand, exactly as before.
 */
export function ScanToReturn({ slug, locale, catalog }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [canScan, setCanScan] = React.useState(false);
  React.useEffect(() => setCanScan(scanningSupported()), []);

  async function resolve(barcode: string) {
    setOpen(false);
    const value = barcode.trim();
    if (!value) return;
    setBusy(true);
    const port = dataPort();
    try {
      // FLAT, where 1.0's copy lookup nested the copy under a `copy` key. The
      // 2.0 read also carries the title, which is why the "no open loan" toast
      // below can name the book instead of only the barcode.
      const item = await port.get<{ id: string; bib: { title: string } }>(
        `/t/${slug}/items/by-barcode?barcode=${encodeURIComponent(value)}`,
      );
      const loans = await port.get<{ items: Array<{ id: string }> }>(
        `/t/${slug}/circulation/loans?itemId=${encodeURIComponent(item.id)}&open=1&limit=1`,
      );
      const loan = loans.items[0];
      if (!loan) {
        toast.show({
          severity: 'warning',
          title: t('loans.scanReturn.noOpenLoan', { title: item.bib.title }),
        });
        return;
      }
      router.push(`/${locale}/t/${slug}/loans/${loan.id}`);
    } catch {
      toast.show({
        severity: 'warning',
        title: t('loans.scanReturn.notFound', { barcode: value }),
      });
    } finally {
      setBusy(false);
    }
  }

  if (!canScan) return null;

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} loading={busy}>
        {t('loans.scanReturn.button')}
      </Button>
      <BarcodeScanner
        open={open}
        onClose={() => setOpen(false)}
        formats={SCAN_FORMATS.label}
        title={t('loans.scanReturn.title')}
        catalog={catalog}
        locale={locale}
        onScan={(v) => void resolve(v)}
      />
    </>
  );
}
