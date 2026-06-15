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
 */
export function ServiceWorkerManager({ offlineLabel }: { offlineLabel: string }) {
  const [offline, setOffline] = React.useState(false);

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

  if (!offline) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 2000,
        padding: 'calc(var(--sp-2, 0.5rem)) var(--sp-3, 0.75rem)',
        paddingBottom: 'calc(var(--sp-2, 0.5rem) + env(safe-area-inset-bottom, 0px))',
        background: 'var(--color-text, #0d1117)',
        color: 'var(--color-text-on-primary, #fff)',
        fontSize: 'var(--fs-sm, 0.875rem)',
        textAlign: 'center',
      }}
    >
      {offlineLabel}
    </div>
  );
}
