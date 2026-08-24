/**
 * Tests for the offline circulation queue — specifically for the promise
 * frontend-06 says it must keep: an action that was performed in the building
 * but never reached the database is never thrown away.
 *
 * The original defect was that "stop replaying this" and "delete this" were the
 * same line of code, in three places, with a five-second toast as the only
 * trace. So the invariant these tests hold is deliberately blunt: after
 * `settleQueued`, the action is still findable — either still pending, or on
 * the failed list with a reason. There is no third outcome except a storage
 * refusal, and that one is pinned here too so the trade-off cannot drift.
 *
 * IndexedDB is faked rather than mocked away: the store layout, the shared
 * transaction that makes "move to failed" atomic, and the version upgrade are
 * the parts most likely to be wrong.
 *
 * Run from `apps/web`: `node --import tsx --test "lib/**\/*.test.ts"`. tsx is a
 * root devDependency and reads `apps/web/tsconfig.json` for the `@/*` alias,
 * which is why the working directory matters.
 */
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { ApiError } from '@/lib/api';
import {
  enqueueAction,
  FAILED_RETENTION_MS,
  listFailed,
  listQueued,
  MAX_QUEUE_AGE_MS,
  MAX_REPLAY_ATTEMPTS,
  planReplayFailure,
  planReplaySend,
  requeueFailed,
  settleQueued,
  type FailedAction,
  type QueuedAction,
} from '@/lib/offline-queue';

/* --- a fake IndexedDB, just large enough for this module ------------------- */

type Row = { id: string } & Record<string, unknown>;
type Handler = (() => void) | null;

/**
 * Writes are buffered and applied on commit, so a refused write really does
 * roll back the whole transaction — which is the property `failQueued` relies
 * on when it deletes from one store and writes to the other.
 */
class FakeDb {
  readonly stores = new Map<string, Map<string, Row>>();
  version = 0;
  /** Set to a store name to make every write to it fail (quota / private mode). */
  refuseWritesTo: string | null = null;

  reset(): void {
    this.stores.clear();
    this.version = 0;
    this.refuseWritesTo = null;
  }

  rows(store: string): Map<string, Row> {
    let map = this.stores.get(store);
    if (!map) {
      map = new Map();
      this.stores.set(store, map);
    }
    return map;
  }

  open(_name: string, version: number) {
    const req: { result: unknown; error: unknown } & Record<string, Handler> = {
      result: null,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    };
    setTimeout(() => {
      req.result = this.makeConnection();
      if (version > this.version) {
        this.version = version;
        req.onupgradeneeded?.();
      }
      req.onsuccess?.();
    }, 0);
    return req;
  }

  private makeConnection() {
    return {
      objectStoreNames: { contains: (name: string) => this.stores.has(name) },
      createObjectStore: (name: string) => {
        this.rows(name);
        return {};
      },
      transaction: (names: string | string[], _mode: string) => this.makeTx(names),
      close: () => undefined,
    };
  }

  private makeTx(names: string | string[]) {
    const scope = new Set(Array.isArray(names) ? names : [names]);
    const buffered: (() => void)[] = [];
    let failed = false;
    const tx: { error: unknown } & Record<string, unknown> = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore: (name: string) => {
        assert.ok(scope.has(name), `store '${name}' is outside the transaction scope`);
        return this.makeStore(name, buffered, () => {
          failed = true;
          tx.error = new Error('QuotaExceededError');
        });
      },
    };
    setTimeout(() => {
      if (failed) {
        (tx.onerror as Handler)?.();
        return;
      }
      for (const apply of buffered) apply();
      (tx.oncomplete as Handler)?.();
    }, 0);
    return tx;
  }

  private makeStore(name: string, buffered: (() => void)[], fail: () => void) {
    const write = (apply: () => void) => {
      if (this.refuseWritesTo === name) fail();
      else buffered.push(apply);
      return { result: undefined };
    };
    return {
      put: (value: Row) => write(() => this.rows(name).set(value.id, value)),
      delete: (id: string) => write(() => this.rows(name).delete(id)),
      clear: () => write(() => this.rows(name).clear()),
      getAll: () => ({ result: [...this.rows(name).values()] }),
    };
  }
}

const fakeDb = new FakeDb();
// The module reads the global lazily (`typeof indexedDB !== 'undefined'`), so
// installing it here is enough.
(globalThis as { indexedDB?: unknown }).indexedDB = fakeDb as unknown as IDBFactory;

beforeEach(() => fakeDb.reset());

/* --- fixtures -------------------------------------------------------------- */

let seq = 0;
function checkout(overrides: Partial<QueuedAction> = {}): QueuedAction {
  seq += 1;
  return {
    id: `q${seq}`,
    idempotencyKey: `key-${seq}`,
    path: '/t/acme/loans',
    body: { bookId: 'b1', memberId: 'm1' },
    kind: 'checkout',
    label: `Dune → Ada Lovelace #${seq}`,
    tenantSlug: 'acme',
    createdAt: Date.now(),
    ...overrides,
  };
}

const HOURS = 60 * 60 * 1000;

/* --- the pure decision ----------------------------------------------------- */

test('an entry past the idempotency window is retired, not replayed', () => {
  const stale = checkout({ createdAt: Date.now() - MAX_QUEUE_AGE_MS - 1000 });
  assert.deepEqual(planReplaySend(stale), { kind: 'retire', reason: 'expired' });
  assert.deepEqual(planReplaySend(checkout()), { kind: 'send' });
});

test('being offline costs the entry nothing', () => {
  // `api()` surfaces "we never reached the server" as a non-ApiError.
  assert.deepEqual(planReplayFailure(checkout(), new TypeError('Failed to fetch')), {
    kind: 'wait',
  });
});

test('transient server faults retry up to the cap, then retire', () => {
  const action = checkout({ attempts: 0 });
  assert.deepEqual(planReplayFailure(action, new ApiError(503, {})), {
    kind: 'retry',
    attempts: 1,
  });
  assert.deepEqual(planReplayFailure(action, new ApiError(429, {})), {
    kind: 'retry',
    attempts: 1,
  });
  const spent = checkout({ attempts: MAX_REPLAY_ATTEMPTS - 1 });
  assert.deepEqual(planReplayFailure(spent, new ApiError(500, {})), {
    kind: 'retire',
    reason: 'exhausted',
  });
});

test('a settled 4xx retires immediately', () => {
  assert.deepEqual(planReplayFailure(checkout(), new ApiError(409, { code: 'LOAN_CLOSED' })), {
    kind: 'retire',
    reason: 'rejected',
  });
});

/* --- the invariant: a retired action is still findable --------------------- */

for (const [label, plan] of [
  ['expired', { kind: 'retire', reason: 'expired' }],
  ['rejected', { kind: 'retire', reason: 'rejected' }],
  ['exhausted', { kind: 'retire', reason: 'exhausted' }],
] as const) {
  test(`an action retired as '${label}' moves to the failed list, not the bin`, async () => {
    const action = checkout();
    assert.equal(await enqueueAction(action), true);

    const place = await settleQueued(action, plan, 'the server refused it');
    assert.equal(place, 'failed');

    assert.deepEqual(await listQueued(), []);
    const failed = await listFailed();
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.id, action.id);
    assert.equal(failed[0]?.reason, plan.reason);
    assert.equal(failed[0]?.label, action.label);
    assert.equal(failed[0]?.detail, 'the server refused it');
  });
}

test('the Monday-morning batch survives the weekend (frontend-06)', async () => {
  // Ten checkouts made during a Friday network cut; the laptop is opened on
  // Monday, so every entry is past the replay window and the mount-time flush
  // retires the lot. Before this fix that flush deleted all ten and announced
  // them in toasts that expired while nobody was at the desk — ten books out of
  // the building and the catalogue saying they were on the shelf.
  const friday = Date.now() - 72 * HOURS;
  const batch = Array.from({ length: 10 }, (_, i) =>
    checkout({ createdAt: friday, label: `Book ${i} → Reader ${i}` }),
  );
  for (const action of batch) assert.equal(await enqueueAction(action), true);

  for (const action of batch) {
    const plan = planReplaySend(action);
    assert.equal(plan.kind, 'retire');
    await settleQueued(action, plan);
  }

  assert.deepEqual(await listQueued(), []);
  const failed = await listFailed();
  assert.equal(failed.length, 10);
  assert.deepEqual(failed.map((a) => a.label).sort(), batch.map((a) => a.label).sort());
  assert.ok(failed.every((a) => a.reason === 'expired'));
});

test('a non-terminal plan leaves the entry pending', async () => {
  const action = checkout({ attempts: 1 });
  await enqueueAction(action);

  assert.equal(await settleQueued(action, { kind: 'wait' }), 'pending');
  assert.equal((await listQueued())[0]?.attempts, 1);

  assert.equal(await settleQueued(action, { kind: 'retry', attempts: 2 }), 'pending');
  assert.equal((await listQueued())[0]?.attempts, 2);
  assert.deepEqual(await listFailed(), []);
});

test('a refused failed-store write is reported, not swallowed', async () => {
  // Private-browsing IndexedDB or a quota refusal. The entry still has to leave
  // the pending queue — an expired one would otherwise be re-retired and
  // re-announced every thirty seconds — so `gone` is the signal to the caller
  // that its toast is now the only record. Pinned here so the trade-off is a
  // decision rather than a surprise.
  const action = checkout();
  await enqueueAction(action);
  fakeDb.refuseWritesTo = 'failed-actions';

  assert.equal(await settleQueued(action, { kind: 'retire', reason: 'expired' }), 'gone');
  assert.deepEqual(await listQueued(), []);
});

test('the move to the failed list is one transaction, so it cannot half-happen', async () => {
  // Two writes: put into `failed-actions`, delete from `circulation-queue`. As
  // separate transactions a refusal between them leaves the action in NEITHER
  // store — the exact loss this store exists to stop. Refusing the delete half
  // makes that visible: both halves must roll back together.
  const action = checkout();
  await enqueueAction(action);
  fakeDb.refuseWritesTo = 'circulation-queue';

  await settleQueued(action, { kind: 'retire', reason: 'rejected' }, 'refused');

  const pending = (await listQueued()).map((a) => a.id);
  const failed = (await listFailed()).map((a) => a.id);
  assert.ok(
    pending.includes(action.id) || failed.includes(action.id),
    'the action must never be absent from both stores',
  );
  assert.deepEqual(failed, [], 'a rolled-back transaction wrote nothing');
  assert.deepEqual(pending, [action.id], '…and removed nothing');
});

/* --- working the list off -------------------------------------------------- */

test('a retry-able failure can be put back on the queue with a clean slate', async () => {
  const action = checkout({ attempts: MAX_REPLAY_ATTEMPTS });
  await enqueueAction(action);
  await settleQueued(action, { kind: 'retire', reason: 'exhausted' });

  assert.equal(await requeueFailed(action.id), true);
  const pending = await listQueued();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.attempts, 0, 'a manual retry starts the retry budget over');
  assert.deepEqual(await listFailed(), []);
});

test('an expired failure refuses to be re-queued even if the button is clicked', async () => {
  // The panel hides the retry button for these, but the modal is not re-rendered
  // on a timer, so an entry can expire while it is on screen. Replaying past the
  // server's idempotency window could apply the loan a second time.
  const action = checkout({ createdAt: Date.now() - MAX_QUEUE_AGE_MS - 1000 });
  await enqueueAction(action);
  await settleQueued(action, { kind: 'retire', reason: 'expired' });

  assert.equal(await requeueFailed(action.id), false);
  assert.deepEqual(await listQueued(), []);
  assert.equal((await listFailed()).length, 1, 'refusing to retry must not drop the record');
});

test('failed records are pruned once they are far past being actionable', async () => {
  const old: FailedAction = {
    ...checkout(),
    failedAt: Date.now() - FAILED_RETENTION_MS - 1000,
    reason: 'expired',
  };
  const recent: FailedAction = { ...checkout(), failedAt: Date.now(), reason: 'rejected' };
  fakeDb.rows('failed-actions').set(old.id, old as unknown as Row);
  fakeDb.rows('failed-actions').set(recent.id, recent as unknown as Row);

  const failed = await listFailed();
  assert.deepEqual(
    failed.map((a) => a.id),
    [recent.id],
  );
  assert.equal(
    fakeDb.rows('failed-actions').size,
    1,
    'the prune is written back, not just filtered',
  );
});

/* --- queueing -------------------------------------------------------------- */

test('an impatient double-tap while offline queues one action, not two', async () => {
  const action = checkout();
  assert.equal(await enqueueAction(action), true);
  assert.equal(await enqueueAction({ ...action, id: 'other-id' }), true);
  assert.equal((await listQueued()).length, 1);
});

test('the queue replays oldest first', async () => {
  const later = checkout({ createdAt: Date.now() });
  const earlier = checkout({ createdAt: Date.now() - 2 * HOURS });
  await enqueueAction(later);
  await enqueueAction(earlier);
  assert.deepEqual(
    (await listQueued()).map((a) => a.id),
    [earlier.id, later.id],
  );
});
