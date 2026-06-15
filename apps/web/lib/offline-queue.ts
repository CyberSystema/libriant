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

/** After this many transient server failures, give up on an entry so one
 *  poison action can't wedge the whole queue. */
export const MAX_REPLAY_ATTEMPTS = 6;

const DB_NAME = 'libriant-offline';
const DB_VERSION = 1;
const STORE = 'circulation-queue';

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function runStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest | null,
): Promise<T> {
  return new Promise((resolve, reject) => {
    openDb().then(
      (db) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let request: IDBRequest | null;
        try {
          request = fn(store);
        } catch (err) {
          db.close();
          reject(err);
          return;
        }
        tx.oncomplete = () => {
          db.close();
          resolve((request ? request.result : undefined) as T);
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
    await runStore('readwrite', (store) => store.put(action));
    return true;
  } catch {
    return false;
  }
}

export async function listQueued(): Promise<QueuedAction[]> {
  if (!hasIndexedDb()) return [];
  const all = await runStore<QueuedAction[]>('readonly', (store) => store.getAll());
  return (all ?? []).slice().sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeQueued(id: string): Promise<void> {
  if (!hasIndexedDb()) return;
  await runStore('readwrite', (store) => store.delete(id));
}

/** Persist an updated entry (e.g. a bumped attempt count). Best-effort. */
export async function updateQueued(action: QueuedAction): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await runStore('readwrite', (store) => store.put(action));
  } catch {
    /* best-effort */
  }
}

export async function clearQueue(): Promise<void> {
  if (!hasIndexedDb()) return;
  await runStore('readwrite', (store) => store.clear());
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
