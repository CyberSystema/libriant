import type { PortAck, PrintDestination, PrintPort, PrintTarget } from '@libriant/shared/ports';
import { desktopBridge } from '@/lib/desktop';

/**
 * Build the same-origin print-route path for a document.
 *
 * Shared by both implementations, and by the desktop shell's own validation:
 * `apps/desktop/src/main.ts` refuses any path whose pathname does not contain
 * `/print/`, so the segment below is load-bearing rather than cosmetic.
 */
export function buildPrintPath(target: PrintTarget): string {
  const { locale, slug, kind, id, bookId } = target;
  if (kind === 'receipt') {
    return `/${locale}/print/${slug}/receipt/${encodeURIComponent(id)}`;
  }
  const query = bookId ? `?book=${encodeURIComponent(bookId)}` : '';
  return `/${locale}/print/${slug}/label/${encodeURIComponent(id)}${query}`;
}

/**
 * Browser printing: open the print route in a new tab and let the route raise
 * the browser's own print dialog once it has rendered.
 *
 * The content is server-rendered by `app/[locale]/print/...`, which is why this
 * implementation only builds a path. That is also the thing M8 has to solve
 * separately — a Tauri `PrintPort` cannot open a Next.js route, so phase 34's
 * ESC/POS and ZPL renderers become its `print()`, not a third branch here.
 */
export class BrowserPrintPort implements PrintPort {
  async print(target: PrintTarget): Promise<PortAck> {
    if (typeof window === 'undefined') return { ok: false, reason: 'unsupported' };
    const opened = window.open(buildPrintPath(target), '_blank', 'noopener');
    return opened ? { ok: true } : { ok: false, reason: 'popup-blocked' };
  }

  /** A browser cannot enumerate printers. Not an error — the UI hides the picker. */
  async listDestinations(): Promise<readonly PrintDestination[]> {
    return [];
  }
}

/**
 * Desktop printing: a SILENT job to the default printer through the audited
 * `window.libriantDesktop.print` bridge, with no OS dialog — the whole point of
 * the shell for a circulation desk printing a receipt per checkout.
 */
export class DesktopPrintPort implements PrintPort {
  async print(target: PrintTarget): Promise<PortAck> {
    const bridge = desktopBridge();
    if (!bridge) return { ok: false, reason: 'no-bridge' };
    try {
      return await bridge.print({ path: buildPrintPath(target) });
    } catch {
      // The bridge rejects rather than acks when the IPC channel itself fails
      // (shell mid-quit, sender frame no longer trusted). Same shape either way.
      return { ok: false, reason: 'bridge-error' };
    }
  }

  async listDestinations(): Promise<readonly PrintDestination[]> {
    const bridge = desktopBridge();
    if (!bridge) return [];
    try {
      return await bridge.getPrinters();
    } catch {
      return [];
    }
  }
}
