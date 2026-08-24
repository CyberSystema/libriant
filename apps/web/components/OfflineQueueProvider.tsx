'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Modal, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator, formatDateTime } from '@libriant/i18n';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import {
  classifyReplayError,
  dismissFailed,
  enqueueAction,
  failQueued,
  isExpired,
  listFailed,
  listQueued,
  MAX_REPLAY_ATTEMPTS,
  removeQueued,
  requeueFailed,
  updateQueued,
  type CirculationKind,
  type FailedAction,
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
 * Where to send the librarian to redo a lost action by hand. A checkout has no
 * loan to point at (it never existed), so it goes back to the checkout form;
 * everything else acted on a loan whose id is the fifth segment of the queued
 * path, `/t/<slug>/loans/<id>/<verb>`.
 */
function redoHref(action: FailedAction, locale: Locale): string {
  const base = `/${locale}/t/${action.tenantSlug}`;
  if (action.kind === 'checkout') return `${base}/loans/new`;
  const loanId = action.path.split('/')[4];
  return loanId ? `${base}/loans/${loanId}` : `${base}/loans`;
}

/**
 * Mounted once per tenant shell. Owns the offline circulation queue: lets
 * descendants enqueue actions, and replays them serially when the device is
 * online. Replays use the action's stored idempotency key, so a partially-sent
 * action never double-applies. Replay is scoped to THIS tenant's slug, and the
 * pending queue is cleared on logout (see lib/offline.ts callers) so a shared
 * device never syncs one user's actions under another's session.
 *
 * It also owns the other half of that promise (frontend-06): an action that can
 * never be replayed is not thrown away. It moves to the failed store and is
 * listed in a panel that stays on screen — through reloads, restarts and a
 * weekend — until a librarian says it has been dealt with. A queued checkout
 * that quietly disappears means a book is out of the building and the catalogue
 * says it is on the shelf; that is not something a five-second toast can carry.
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
  const [failed, setFailed] = React.useState<FailedAction[]>([]);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const flushing = React.useRef(false);

  // Keep the latest helpers reachable from the flush loop without making it a
  // dependency churn — flush is created once and reads current values.
  const ctx = React.useRef({ t, router, toast, slug });
  ctx.current = { t, router, toast, slug };

  const refresh = React.useCallback(async () => {
    const [queued, dead] = await Promise.all([
      listQueued().catch(() => []),
      listFailed().catch(() => []),
    ]);
    setPendingCount(queued.filter((a) => a.tenantSlug === ctx.current.slug).length);
    setFailed(dead.filter((a) => a.tenantSlug === ctx.current.slug));
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
        // A7-02: never replay an entry older than the server's idempotency
        // window — a stale replay would no longer dedupe and could double-apply.
        // Retire it to the failed list so the librarian can redo it.
        if (isExpired(action)) {
          await retire(action, 'expired');
          ctx.current.toast.show({
            severity: 'critical',
            title: ctx.current.t('loans.queue.expired', { label: action.label }),
          });
          continue;
        }
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
            // else: exhausted — fall through and retire so it can't wedge the queue.
          }
          // Settled server-side (4xx conflict / invalid / quota) or out of
          // retries. The API's rejection text is hardcoded English; the
          // librarian reading "we couldn't sync X" needs the why in their own
          // language, both in the toast and later in the failed list.
          const reason = translateApiError(
            err,
            ctx.current.t,
            ctx.current.t('common.states.error'),
          );
          await retire(action, verdict === 'retry' ? 'exhausted' : 'rejected', reason);
          ctx.current.toast.show({
            severity: 'critical',
            title: ctx.current.t('loans.queue.syncFailed', { label: action.label, reason }),
          });
        }
      }
    } finally {
      flushing.current = false;
      setSyncing(false);
      await refresh();
      if (synced > 0) ctx.current.router.refresh();
    }
  }, [refresh]);

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
        await refresh();
        // If we're actually online (a one-off fetch blip), sync right away.
        void flush();
      }
      return ok;
    },
    [refresh, flush],
  );

  // Replay on mount, whenever we come back online, and periodically while there
  // are still-pending actions.
  React.useEffect(() => {
    void refresh();
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
  }, [flush, refresh]);

  // The panel has nothing left to show once the last entry is handled.
  React.useEffect(() => {
    if (panelOpen && failed.length === 0) setPanelOpen(false);
  }, [panelOpen, failed.length]);

  const dockRef = React.useRef<HTMLDivElement>(null);
  const showDock = pendingCount > 0 || failed.length > 0;
  // frontend-28: publish the dock's real height so the toast stack can sit
  // above it instead of on top of it. Measured rather than assumed — the pill
  // wraps to two lines in Greek on a narrow phone.
  React.useEffect(() => {
    const root = document.documentElement;
    const node = dockRef.current;
    if (!showDock || !node) {
      root.style.setProperty('--lbr-offline-dock-h', '0px');
      return undefined;
    }
    const publish = () => {
      root.style.setProperty('--lbr-offline-dock-h', `${Math.ceil(node.offsetHeight)}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.setProperty('--lbr-offline-dock-h', '0px');
    };
  }, [showDock]);

  const markHandled = React.useCallback(
    async (id: string) => {
      await dismissFailed(id);
      await refresh();
    },
    [refresh],
  );

  const retry = React.useCallback(
    async (action: FailedAction) => {
      if (isExpired(action)) {
        toast.show({ severity: 'critical', title: t('loans.queue.failed.retryUnsafe') });
        return;
      }
      const ok = await requeueFailed(action.id);
      await refresh();
      if (!ok) {
        toast.show({ severity: 'critical', title: t('common.states.error') });
        return;
      }
      toast.show({ severity: 'info', title: t('loans.queue.failed.retried') });
      void flush();
    },
    [flush, refresh, t, toast],
  );

  const redo = React.useCallback(
    (action: FailedAction) => {
      setPanelOpen(false);
      router.push(redoHref(action, locale));
    },
    [locale, router],
  );

  const value = React.useMemo<OfflineQueueValue>(
    () => ({ enqueue, pendingCount }),
    [enqueue, pendingCount],
  );

  return (
    <OfflineQueueContext.Provider value={value}>
      {children}
      {showDock ? (
        <div className="lbr-offline-dock" ref={dockRef} role="status" aria-live="polite">
          {failed.length > 0 ? (
            <button
              type="button"
              className="lbr-offline-dock__alert"
              onClick={() => setPanelOpen(true)}
            >
              <span aria-hidden="true" className="lbr-offline-dock__dot" />
              <span>{t('loans.queue.failed.badge', { count: failed.length })}</span>
              <span className="lbr-offline-dock__cta">{t('loans.queue.failed.review')}</span>
            </button>
          ) : null}
          {pendingCount > 0 ? (
            <div className="lbr-offline-dock__pill">
              <span
                aria-hidden="true"
                className="lbr-offline-dock__dot"
                data-state={syncing ? 'syncing' : 'waiting'}
              />
              {syncing
                ? t('loans.queue.syncing')
                : t('loans.queue.pending', { count: pendingCount })}
            </div>
          ) : null}
        </div>
      ) : null}
      <Modal
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        title={t('loans.queue.failed.title')}
        closeLabel={t('common.actions.close')}
        actions={
          <Button variant="secondary" onClick={() => setPanelOpen(false)}>
            {t('common.actions.close')}
          </Button>
        }
      >
        <p className="lbr-failed__intro">{t('loans.queue.failed.intro')}</p>
        <ul className="lbr-failed">
          {failed.map((action) => {
            const canRetry = action.reason === 'exhausted' && !isExpired(action);
            return (
              <li key={action.id} className="lbr-failed__item">
                <div className="lbr-failed__head">
                  <span className="lbr-failed__kind">
                    {t(`loans.queue.failed.kind.${action.kind}`)}
                  </span>
                  <span className="lbr-failed__when">
                    {t('loans.queue.failed.when', {
                      at: formatDateTime(new Date(action.createdAt), locale),
                    })}
                  </span>
                </div>
                <p className="lbr-failed__label">{action.label}</p>
                <p className="lbr-failed__reason">
                  {t(`loans.queue.failed.reason.${action.reason}`)}
                  {action.detail ? ` ${action.detail}` : ''}
                </p>
                <div className="lbr-failed__actions">
                  {canRetry ? (
                    <Button size="sm" variant="secondary" onClick={() => void retry(action)}>
                      {t('loans.queue.failed.retry')}
                    </Button>
                  ) : null}
                  <Button size="sm" variant="secondary" onClick={() => redo(action)}>
                    {t('loans.queue.failed.redo')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void markHandled(action.id)}>
                    {t('loans.queue.failed.handled')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </Modal>
    </OfflineQueueContext.Provider>
  );
}

/**
 * Take an action off the pending queue and put it on the failed list. If the
 * failed record can't be written (private-browsing IndexedDB, quota), the entry
 * still has to leave the queue — an expired one would otherwise be re-dropped
 * and re-announced every thirty seconds — and the sticky critical toast becomes
 * the only record.
 */
async function retire(
  action: QueuedAction,
  reason: 'expired' | 'rejected' | 'exhausted',
  detail?: string,
): Promise<void> {
  const recorded = await failQueued(action, reason, detail);
  if (!recorded) await removeQueued(action.id);
}
