'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { api } from '@/lib/api';
import { BarcodeScanner, SCAN_FORMATS, scanningSupported } from '@/components/BarcodeScanner';

type Props = { slug: string; locale: Locale; catalog: Catalog };

/**
 * Desk "scan to return" entry on the loans page. Scan a returned copy's
 * barcode → resolve the copy → find its open loan → jump to that loan's detail
 * page, where the librarian confirms condition (ok / damaged) and returns it
 * (the return itself is idempotent). We deliberately DON'T auto-return: a human
 * glance plus the condition prompt prevents the wrong copy being marked back in.
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
    try {
      const { copy } = await api<{ copy: { id: string } }>(
        `/t/${slug}/catalog/copies/lookup?barcode=${encodeURIComponent(value)}`,
      );
      const loans = await api<{ items: Array<{ id: string }> }>(
        `/t/${slug}/loans?copyId=${encodeURIComponent(copy.id)}&status=active&limit=1`,
      );
      const loan = loans.items[0];
      if (!loan) {
        toast.show({
          severity: 'warning',
          title: t('loans.scanReturn.noActiveLoan', { barcode: value }),
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
