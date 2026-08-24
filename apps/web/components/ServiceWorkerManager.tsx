'use client';
import * as React from 'react';
import { registerServiceWorker } from '@/lib/offline';

/**
 * Registers the service worker (production only — a SW in dev fights HMR) and
 * shows a small status bar when the browser goes offline, so the librarian
 * knows why writes might be queued/blocked and why some data may be stale.
 *
 * Renders nothing while online. The offline state is set in an effect (not at
 * render) so server and first client render agree (no hydration mismatch).
 *
 * frontend-28: the bar publishes its measured height as `--lbr-offline-bar-h`.
 * Three overlays anchor to the bottom of the viewport — this bar, the queue
 * dock and the toast stack — and they used to be stacked by z-index, which
 * meant the "3 actions pending" pill was painted *underneath* the offline bar
 * in the one state where both appear at once: offline, with queued checkouts.
 * They now sit on top of each other in a column, and the height has to be
 * measured because the bar wraps to two lines in Greek on a narrow phone.
 */
export function ServiceWorkerManager({ offlineLabel }: { offlineLabel: string }) {
  const [offline, setOffline] = React.useState(false);
  const barRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (process.env.NODE_ENV === 'production') registerServiceWorker();
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  React.useEffect(() => {
    const root = document.documentElement;
    const node = barRef.current;
    if (!offline || !node) {
      root.style.setProperty('--lbr-offline-bar-h', '0px');
      return undefined;
    }
    const publish = () => {
      root.style.setProperty('--lbr-offline-bar-h', `${Math.ceil(node.offsetHeight)}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.setProperty('--lbr-offline-bar-h', '0px');
    };
  }, [offline]);

  if (!offline) return null;
  return (
    <div ref={barRef} role="status" aria-live="polite" className="lbr-offline-bar">
      {offlineLabel}
    </div>
  );
}
