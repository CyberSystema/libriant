import { desktopBridge, type DesktopAck } from './desktop';

/**
 * Print a Libriant document (a circulation receipt or a barcode label).
 *
 * One switch decides the path at click time:
 *   - **Desktop shell** — a SILENT job to the default printer via the audited
 *     `window.libriantDesktop.print` bridge (no OS dialog).
 *   - **Browser** — open the same-origin print route in a new tab; the route
 *     raises the browser's own print dialog once it has rendered.
 *
 * The print content itself is server-rendered by the `/print/...` routes, so
 * this helper only needs to build the path and pick the mechanism.
 */

export type PrintKind = 'receipt' | 'label';

export type PrintTarget = {
  locale: string;
  slug: string;
  kind: PrintKind;
  /** Loan id for a receipt, copy id for a label. */
  id: string;
  /** Required for a label — the copy's book id (there is no copy-by-id fetch). */
  bookId?: string;
};

/** Build the same-origin print-route path for a document. */
export function buildPrintPath(target: PrintTarget): string {
  const { locale, slug, kind, id, bookId } = target;
  if (kind === 'receipt') {
    return `/${locale}/print/${slug}/receipt/${encodeURIComponent(id)}`;
  }
  const query = bookId ? `?book=${encodeURIComponent(bookId)}` : '';
  return `/${locale}/print/${slug}/label/${encodeURIComponent(id)}${query}`;
}

export async function printDocument(target: PrintTarget): Promise<DesktopAck> {
  const path = buildPrintPath(target);
  const bridge = desktopBridge();
  if (bridge) {
    try {
      return await bridge.print({ path });
    } catch {
      return { ok: false, reason: 'bridge-error' };
    }
  }
  const opened = window.open(path, '_blank', 'noopener');
  return opened ? { ok: true } : { ok: false, reason: 'popup-blocked' };
}
