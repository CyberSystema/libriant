'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { api } from '@/lib/api';
import {
  classifyReplayError,
  enqueueAction,
  listQueued,
  MAX_REPLAY_ATTEMPTS,
  removeQueued,
  updateQueued,
  type CirculationKind,
  type QueuedAction,
} from '@/lib/offline-queue';

type EnqueueInput = {
  idempotencyKey: string;
  path: string;
  body: unknown;
  kind: CirculationKind;
  label: string;
};

type OfflineQueueValue = {
  /** Persist a circulation action for replay when back online. Resolves true
   *  once it's durably queued, false if offline storage is unavailable. */
  enqueue: (action: EnqueueInput) => Promise<boolean>;
  pendingCount: number;
};

const noop: OfflineQueueValue = {
  enqueue: async () => {
    if (typeof console !== 'undefined') console.warn('OfflineQueue used outside its provider');
    return false;
  },
  pendingCount: 0,
};

const OfflineQueueContext = React.createContext<OfflineQueueValue>(noop);

export function useOfflineQueue(): OfflineQueueValue {
  return React.useContext(OfflineQueueContext);
}

/**
 * Mounted once per tenant shell. Owns the offline circulation queue: lets
 * descendants enqueue actions, and replays them serially when the device is
 * online. Replays use the action's stored idempotency key, so a partially-sent
 * action never double-applies. Replay is scoped to THIS tenant's slug, and the
 * whole queue is cleared on logout (see lib/offline.ts callers) so a shared
 * device never syncs one user's actions under another's session.
 */
export function OfflineQueueProvider({
  slug,
  catalog,
  locale,
  children,
}: {
  slug: string;
  catalog: Catalog;
  locale: Locale;
  children: React.ReactNode;
}) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const toast = useToast();
  const [pendingCount, setPendingCount] = React.useState(0);
  const [syncing, setSyncing] = React.useState(false);
  const flushing = React.useRef(false);

  // Keep the latest helpers reachable from the flush loop without making it a
  // dependency churn — flush is created once and reads current values.
  const ctx = React.useRef({ t, router, toast, slug });
  ctx.current = { t, router, toast, slug };

  const refreshCount = React.useCallback(async () => {
    const all = await listQueued().catch(() => []);
    setPendingCount(all.filter((a) => a.tenantSlug === ctx.current.slug).length);
  }, []);

  const flush = React.useCallback(async () => {
    if (flushing.current) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    flushing.current = true;
    setSyncing(true);
    let synced = 0;
    try {
      const queue = (await listQueued().catch(() => [])).filter(
        (a) => a.tenantSlug === ctx.current.slug,
      );
      for (const action of queue) {
        try {
          await api(action.path, {
            method: 'POST',
            body: action.body,
            idempotencyKey: action.idempotencyKey,
          });
          await removeQueued(action.id);
          synced += 1;
          ctx.current.toast.show({
            severity: 'success',
            title: ctx.current.t('loans.queue.synced', { label: action.label }),
          });
        } catch (err) {
          const verdict = classifyReplayError(err);
          if (verdict === 'offline') {
            // Connectivity gone mid-pass — stop, keep the entry untouched, retry
            // on the next online event or tick. No penalty for being offline.
            break;
          }
          if (verdict === 'retry') {
            const attempts = (action.attempts ?? 0) + 1;
            if (attempts < MAX_REPLAY_ATTEMPTS) {
              await updateQueued({ ...action, attempts });
              break; // transient server fault — back off, try the pass again later
            }
            // else: exhausted — fall through and drop so it can't wedge the queue.
          }
          // Settled server-side (4xx conflict / invalid / quota) or out of
          // retries — drop it and tell the librarian it didn't go through.
          await removeQueued(action.id);
          const reason = err instanceof Error ? err.message : ctx.current.t('common.states.error');
          ctx.current.toast.show({
            severity: 'critical',
            title: ctx.current.t('loans.queue.syncFailed', { label: action.label, reason }),
          });
        }
      }
    } finally {
      flushing.current = false;
      setSyncing(false);
      await refreshCount();
      if (synced > 0) ctx.current.router.refresh();
    }
  }, [refreshCount]);

  const enqueue = React.useCallback(
    async (input: EnqueueInput): Promise<boolean> => {
      const action: QueuedAction = {
        id: crypto.randomUUID(),
        idempotencyKey: input.idempotencyKey,
        path: input.path,
        body: input.body,
        kind: input.kind,
        label: input.label,
        tenantSlug: ctx.current.slug,
        createdAt: Date.now(),
      };
      const ok = await enqueueAction(action);
      if (ok) {
        await refreshCount();
        // If we're actually online (a one-off fetch blip), sync right away.
        void flush();
      }
      return ok;
    },
    [refreshCount, flush],
  );

  // Replay on mount, whenever we come back online, and periodically while there
  // are still-pending actions.
  React.useEffect(() => {
    void refreshCount();
    void flush();
    const onOnline = () => void flush();
    window.addEventListener('online', onOnline);
    const timer = window.setInterval(() => {
      if (navigator.onLine) void flush();
    }, 30_000);
    return () => {
      window.removeEventListener('online', onOnline);
      window.clearInterval(timer);
    };
  }, [flush, refreshCount]);

  const value = React.useMemo<OfflineQueueValue>(
    () => ({ enqueue, pendingCount }),
    [enqueue, pendingCount],
  );

  return (
    <OfflineQueueContext.Provider value={value}>
      {children}
      {pendingCount > 0 ? (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            right: 'var(--sp-3, 0.75rem)',
            bottom: 'calc(var(--sp-3, 0.75rem) + env(safe-area-inset-bottom, 0px))',
            zIndex: 1900,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--sp-2, 0.5rem)',
            padding: 'var(--sp-2, 0.5rem) var(--sp-3, 0.75rem)',
            borderRadius: '999px',
            background: 'var(--color-surface-raised, #fff)',
            color: 'var(--color-text, #0d1117)',
            border: '1px solid var(--color-border, #d0d7de)',
            boxShadow: 'var(--shadow-md, 0 4px 12px rgba(0,0,0,0.12))',
            fontSize: 'var(--fs-sm, 0.875rem)',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: syncing
                ? 'var(--color-success, #1a7f37)'
                : 'var(--color-warning, #bf8700)',
            }}
          />
          {syncing ? t('loans.queue.syncing') : t('loans.queue.pending', { count: pendingCount })}
        </div>
      ) : null}
    </OfflineQueueContext.Provider>
  );
}
