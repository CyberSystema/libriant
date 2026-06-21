import { clearQueue } from '@/lib/offline-queue';

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
 * Wipe offline state that may hold tenant data — cached pages/data AND the
 * pending circulation queue. Called on logout so a shared device never serves
 * the previous user's cached data, and never replays their queued actions under
 * the next user's session. Belt-and-braces: messages the active SW AND deletes
 * the runtime caches directly (covers the case where the SW isn't controlling
 * this page yet).
 */
export async function clearOfflineCaches(): Promise<void> {
  await clearOfflineReadCaches();
  await clearQueue().catch(() => undefined);
}

/**
 * A10-02: wipe ONLY the cached pages/data (which may hold tenant PII), leaving
 * the pending circulation queue intact. Called on session loss (a 401), where —
 * unlike an explicit logout — the same user may re-authenticate and still wants
 * their queued, idempotent offline writes to flush. Clearing while still online
 * (at the moment of the 401) is what prevents the NEXT user from being served
 * the previous user's cached data offline.
 */
export async function clearOfflineReadCaches(): Promise<void> {
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
