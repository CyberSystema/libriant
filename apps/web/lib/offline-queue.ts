import { ApiError } from '@/lib/api';

/**
 * Durable offline queue for circulation writes (checkout / return / renew /
 * mark-lost). When a request fails because the device is offline, the action is
 * stored in IndexedDB and replayed when connectivity returns — see
 * `OfflineQueueProvider`.
 *
 * Safety rests on idempotency keys (server-side, Roadmap #2): each queued
 * action carries the SAME `Idempotency-Key` it would have sent live, so a
 * replay never double-acts even if the original request had actually reached
 * the server before the connection dropped.
 */

export type CirculationKind = 'checkout' | 'return' | 'renew' | 'mark-lost';

export type QueuedAction = {
  /** Unique queue-entry id. */
  id: string;
  /** Stable idempotency key for the operation (dedupes replays server-side). */
  idempotencyKey: string;
  /** API path relative to the client base, e.g. `/t/acme/loans/L1/return`. */
  path: string;
  body: unknown;
  kind: CirculationKind;
  /** Human-readable summary for toasts ("Dune → Ada Lovelace"). */
  label: string;
  /** Tenant slug this action belongs to — replayed only under that tenant. */
  tenantSlug: string;
  createdAt: number;
  /** Count of replays that hit a transient SERVER error (5xx). Offline retries
   *  don't count — they mean "no connectivity", not "this action is bad". */
  attempts?: number;
};

/**
 * Why an action stopped being replayed. Each maps to a different next step for
 * the librarian, which is why the code is stored rather than a message:
 *   - `expired`   — sat longer than {@link MAX_QUEUE_AGE_MS}; replaying is no
 *                   longer safe, so it can only be redone by hand.
 *   - `rejected`  — the server answered 4xx: settled, and not coming back.
 *   - `exhausted` — the server kept faulting (5xx) past the retry cap. This is
 *                   the one case where trying again can still work.
 */
export type FailureReason = 'expired' | 'rejected' | 'exhausted';

/** A queued action that will never be replayed automatically again. */
export type FailedAction = QueuedAction & {
  failedAt: number;
  reason: FailureReason;
  /** The server's explanation, already translated when it was recorded. */
  detail?: string;
};

/** After this many transient server failures, give up on an entry so one
 *  poison action can't wedge the whole queue. */
export const MAX_REPLAY_ATTEMPTS = 6;

/**
 * A7-02: drop a queued action once it is older than this, WITHOUT replaying it.
 * The server only remembers an idempotency result for 24h
 * (`IdempotencyInterceptor.RESULT_TTL_SEC`). If the original request actually
 * reached the server but the connection dropped before we got the response, a
 * replay after that window would no longer dedupe and would APPLY THE ACTION A
 * SECOND TIME (a double return / double fine / double renew). We keep a safe
 * margin under 24h so a stale entry is surfaced to the librarian to redo
 * manually rather than silently double-applied.
 */
export const MAX_QUEUE_AGE_MS = 18 * 60 * 60 * 1000;

/** True when an entry is too old to safely replay (see {@link MAX_QUEUE_AGE_MS}). */
export function isExpired(action: QueuedAction, now: number = Date.now()): boolean {
  return now - action.createdAt > MAX_QUEUE_AGE_MS;
}

const DB_NAME = 'libriant-offline';
/** v2 added FAILED_STORE (frontend-06). */
const DB_VERSION = 2;
const STORE = 'circulation-queue';
/**
 * frontend-06: a queued action that could never succeed used to be `delete`d,
 * announced once in a toast, and gone. A librarian who checked out ten books
 * during a Friday network cut and reopened the laptop on Monday lost all ten —
 * every entry was past the replay window, so the mount-time flush dropped the
 * lot, and the only trace was a stack of toasts nobody was there to read. Ten
 * books physically out of the library, and the system saying they were on the
 * shelf.
 *
 * Dropped entries now move HERE instead of being deleted, and the tenant shell
 * keeps showing them until a human says they have been dealt with. This store
 * is the record of work that happened in the building but not in the database,
 * so it deliberately outlives page loads and restarts.
 */
const FAILED_STORE = 'failed-actions';

/** Failed records are pruned after this long — they describe loans that were
 *  redone weeks ago, and the store is not an audit log. */
export const FAILED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(FAILED_STORE)) {
        db.createObjectStore(FAILED_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function runStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest | null,
): Promise<T> {
  let request: IDBRequest | null = null;
  return runTx(storeName, mode, (tx) => {
    request = fn(tx.objectStore(storeName));
  }).then(() => (request ? request.result : undefined) as T);
}

/**
 * Run `fn` inside one transaction and resolve when it commits. Spanning both
 * stores in a single transaction is what makes "move to failed" atomic — a
 * delete-then-put pair can lose the entry in the gap between the two, which is
 * exactly the loss this store exists to stop.
 */
function runTx(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    openDb().then(
      (db) => {
        const tx = db.transaction(storeNames, mode);
        try {
          fn(tx);
        } catch (err) {
          db.close();
          reject(err);
          return;
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      },
      (err) => reject(err),
    );
  });
}

/**
 * Add an action to the queue. Deduped by idempotency key — re-queuing the same
 * logical action (e.g. an impatient double-tap while offline) is a no-op.
 * Returns whether the action is now durably queued, so callers don't claim
 * "saved offline" when storage is unavailable (private mode / disabled IDB).
 */
export async function enqueueAction(action: QueuedAction): Promise<boolean> {
  if (!hasIndexedDb()) return false;
  try {
    const existing = await listQueued();
    if (existing.some((a) => a.idempotencyKey === action.idempotencyKey)) return true;
    await runStore(STORE, 'readwrite', (store) => store.put(action));
    return true;
  } catch {
    return false;
  }
}

export async function listQueued(): Promise<QueuedAction[]> {
  if (!hasIndexedDb()) return [];
  const all = await runStore<QueuedAction[]>(STORE, 'readonly', (store) => store.getAll());
  return (all ?? []).slice().sort((a, b) => a.createdAt - b.createdAt);
}

/** Take a SUCCEEDED entry off the queue. For anything else use
 *  {@link settleQueued}, which records why. */
export async function removeQueued(id: string): Promise<void> {
  if (!hasIndexedDb()) return;
  await runStore(STORE, 'readwrite', (store) => store.delete(id));
}

/** Persist an updated entry (e.g. a bumped attempt count). Best-effort.
 *  Module-private: the replay loop reaches it through {@link settleQueued}. */
async function updateQueued(action: QueuedAction): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await runStore(STORE, 'readwrite', (store) => store.put(action));
  } catch {
    /* best-effort */
  }
}

export async function clearQueue(): Promise<void> {
  if (!hasIndexedDb()) return;
  await runStore(STORE, 'readwrite', (store) => store.clear());
}

/**
 * Move a queued action into the failed store: it stops being replayed, and it
 * starts being *listed*. One transaction, so the entry is never in neither
 * store.
 *
 * Module-private on purpose. The queue now offers exactly two ways for an
 * entry to end — {@link removeQueued} (it succeeded) and {@link settleQueued}
 * (it did not, and here is the reason) — so "stop replaying it" cannot be
 * spelled as "delete it" from outside this file. That conflation is what
 * frontend-06 was.
 *
 * Returns false when the record could not be written — private-browsing IDB,
 * a quota refusal. The caller still has to get the entry out of the pending
 * queue in that case (an `expired` entry would otherwise be re-dropped, and
 * re-announced, on every 30-second pass), so the sticky critical toast is the
 * only record left. That is the old behaviour, and it is why this returns a
 * boolean rather than swallowing the failure.
 */
async function failQueued(
  action: QueuedAction,
  reason: FailureReason,
  detail?: string,
): Promise<boolean> {
  if (!hasIndexedDb()) return false;
  const record: FailedAction = {
    ...action,
    failedAt: Date.now(),
    reason,
    ...(detail ? { detail } : {}),
  };
  try {
    await runTx([STORE, FAILED_STORE], 'readwrite', (tx) => {
      tx.objectStore(FAILED_STORE).put(record);
      tx.objectStore(STORE).delete(action.id);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything that failed, newest first — the librarian works through the most
 * recent cut first. Entries past {@link FAILED_RETENTION_MS} are pruned here
 * rather than on a timer, because this is the only code path guaranteed to run.
 */
export async function listFailed(): Promise<FailedAction[]> {
  if (!hasIndexedDb()) return [];
  const all = await runStore<FailedAction[]>(FAILED_STORE, 'readonly', (store) => store.getAll());
  const cutoff = Date.now() - FAILED_RETENTION_MS;
  const kept = (all ?? []).filter((a) => a.failedAt >= cutoff);
  if (kept.length !== (all ?? []).length) {
    const stale = (all ?? []).filter((a) => a.failedAt < cutoff).map((a) => a.id);
    await runTx(FAILED_STORE, 'readwrite', (tx) => {
      const store = tx.objectStore(FAILED_STORE);
      for (const id of stale) store.delete(id);
    }).catch(() => undefined);
  }
  return kept.sort((a, b) => b.failedAt - a.failedAt);
}

/** The librarian has redone this by hand — drop the record. */
export async function dismissFailed(id: string): Promise<void> {
  if (!hasIndexedDb()) return;
  await runStore(FAILED_STORE, 'readwrite', (store) => store.delete(id)).catch(() => undefined);
}

/**
 * Put a failed action back on the pending queue for another automatic attempt.
 *
 * Refuses an entry past {@link MAX_QUEUE_AGE_MS}: the server has forgotten the
 * idempotency key by then, so a replay would no longer dedupe and could apply
 * the loan a second time. The panel hides the button for those, and this is the
 * check that makes hiding it more than a suggestion — the modal is not
 * re-rendered on a timer, so an entry can expire while it is on screen.
 */
export async function requeueFailed(id: string): Promise<boolean> {
  if (!hasIndexedDb()) return false;
  try {
    const record = (await listFailed()).find((a) => a.id === id);
    if (!record || isExpired(record)) return false;
    const { failedAt: _failedAt, reason: _reason, detail: _detail, ...action } = record;
    await runTx([STORE, FAILED_STORE], 'readwrite', (tx) => {
      tx.objectStore(STORE).put({ ...action, attempts: 0 } satisfies QueuedAction);
      tx.objectStore(FAILED_STORE).delete(id);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * A failure that means "we never reached the server" (offline / DNS / dropped
 * connection) — `api()` lets these propagate as a non-`ApiError` because the
 * raw `fetch` rejected. These are the ones worth queuing.
 */
export function isNetworkError(err: unknown): boolean {
  return !(err instanceof ApiError);
}

/**
 * On replay, classify the failure:
 *   - offline: no server contact (fetch rejected). Stop the pass and wait for
 *     connectivity — this does NOT count against the retry cap.
 *   - retry:   a transient server fault (5xx / 408 / 429). Counts toward the
 *     cap so a persistently-failing entry eventually gets dropped.
 *   - drop:    any other server response (4xx) — the action is settled. With
 *     idempotency that includes a 409 from the in-flight guard (the original
 *     succeeded) and business conflicts like "already returned"; in every case
 *     the right move is to stop replaying and tell the librarian.
 */
export function classifyReplayError(err: unknown): 'offline' | 'retry' | 'drop' {
  if (!(err instanceof ApiError)) return 'offline';
  if (err.status >= 500 || err.status === 408 || err.status === 429) return 'retry';
  return 'drop';
}

/**
 * What the replay loop should do with one entry.
 *
 *   - `send`   — go ahead and replay it.
 *   - `wait`   — no server contact; leave the entry exactly as it is and stop
 *                the pass. Being offline is not the entry's fault.
 *   - `retry`  — a transient server fault; bump the counter and back off.
 *   - `retire` — this entry will never be replayed again. It ALWAYS carries a
 *                reason, and a reason is what makes it recordable.
 *
 * frontend-06 was, at bottom, that "will never be replayed again" and "delete
 * it" were the same line of code in three different places in the provider.
 * The decision now lives here as a pure function and the storage effect lives
 * in {@link settleQueued}, so there is exactly one place that can end an entry
 * and it cannot end one without a reason to show the librarian.
 */
export type ReplayPlan =
  | { kind: 'send' }
  | { kind: 'wait' }
  | { kind: 'retry'; attempts: number }
  | { kind: 'retire'; reason: FailureReason };

/**
 * Decide before sending. The only pre-flight rejection is age: past
 * {@link MAX_QUEUE_AGE_MS} the server has forgotten the idempotency key, so a
 * replay could apply the loan a second time (see the constant's note).
 */
export function planReplaySend(action: QueuedAction, now: number = Date.now()): ReplayPlan {
  if (isExpired(action, now)) return { kind: 'retire', reason: 'expired' };
  return { kind: 'send' };
}

/**
 * Decide after a send failed. `attempts` counts only transient SERVER faults —
 * a device that is offline gets no penalty, or a library with a bad Friday
 * would arrive on Monday with its queue burned through.
 */
export function planReplayFailure(action: QueuedAction, err: unknown): ReplayPlan {
  const verdict = classifyReplayError(err);
  if (verdict === 'offline') return { kind: 'wait' };
  if (verdict === 'retry') {
    const attempts = (action.attempts ?? 0) + 1;
    if (attempts < MAX_REPLAY_ATTEMPTS) return { kind: 'retry', attempts };
    return { kind: 'retire', reason: 'exhausted' };
  }
  return { kind: 'retire', reason: 'rejected' };
}

/** Where an entry ended up after {@link settleQueued}. `gone` is the failure
 *  case — nothing on disk remembers the action any more. */
export type SettledPlace = 'pending' | 'failed' | 'gone';

/**
 * Apply a {@link ReplayPlan}'s storage effect. This is the ONLY way an entry
 * leaves the pending queue other than succeeding, which is what makes
 * "terminal ⇒ recorded" checkable rather than a convention: the tests drive
 * every plan through here and assert the entry is still findable afterwards.
 *
 * `gone` is returned only when the failed record could not be written at all
 * (private-browsing IndexedDB, a quota refusal). The entry still has to leave
 * the queue in that case — an expired one would otherwise be re-retired, and
 * re-announced, every thirty seconds — so the caller's sticky critical toast
 * becomes the only record, and the caller is told so it can say something
 * different.
 */
export async function settleQueued(
  action: QueuedAction,
  plan: ReplayPlan,
  detail?: string,
): Promise<SettledPlace> {
  if (plan.kind === 'send' || plan.kind === 'wait') return 'pending';
  if (plan.kind === 'retry') {
    await updateQueued({ ...action, attempts: plan.attempts });
    return 'pending';
  }
  const recorded = await failQueued(action, plan.reason, detail);
  if (recorded) return 'failed';
  await removeQueued(action.id).catch(() => undefined);
  return 'gone';
}
