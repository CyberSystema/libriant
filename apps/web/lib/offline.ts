/**
 * Client-side service-worker helpers. The SW itself lives at `public/sw.js`.
 */

/** Register the service worker. Safe to call on every load — the browser
 *  no-ops a re-register. Only meaningful over a secure context (https /
 *  localhost), which the browser enforces. */
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // Defer to idle so registration never competes with first paint.
  const run = () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  };
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run, { once: true });
}

/**
 * Wipe offline caches that may hold tenant data. Called on logout so a shared
 * device never serves the previous user's cached pages/data. Belt-and-braces:
 * messages the active SW AND deletes the runtime caches directly (covers the
 * case where the SW isn't controlling this page yet).
 */
export async function clearOfflineCaches(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      reg?.active?.postMessage({ type: 'LBR_CLEAR_OFFLINE' });
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('lbr-pages-') || k.startsWith('lbr-data-'))
          .map((k) => caches.delete(k)),
      );
    }
  } catch {
    /* ignore */
  }
}
