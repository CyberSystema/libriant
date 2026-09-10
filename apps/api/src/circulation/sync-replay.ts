import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';

/**
 * `sync_client_changes` — exactly-once, durable, transactional.
 *
 * §6 phase 16: "Replaying a `client_change_id` returns the stored response and
 * re-applies nothing; a mismatched `request_hash` 409s." §3 adds the property
 * that makes it worth having: "Written **inside the same transaction as the
 * effect**, retained 180 days," and "kills A7-02" — the 18-hour cap that
 * `apps/web/lib/offline-queue.ts` currently imposes because the only idempotency
 * this system has is a 24-hour Redis key.
 *
 * ## Two mechanisms, and they must never both own a request
 *
 * The Redis `IdempotencyInterceptor` stays, for the interactive HTTP path, and
 * §3 says so. It is a DIFFERENT mechanism with different properties, and the
 * differences are the reason a device must not use it:
 *
 *              Redis interceptor              sync_client_changes
 *   lifetime   24 h, evictable                180 days, in the tenant database
 *   atomicity  released on error              committed with the effect, or not at all
 *   on error   the key is released            the refusal IS the stored response
 *   fails      open                           it cannot fail open; it is a row
 *
 * The last two are the ones that matter. A device that queued a checkout the
 * server REFUSED must be told the refusal again on replay — an offline queue
 * that flushes a refused checkout and gets a success has lent a book the
 * librarian was told could not be lent. So a refusal is a stored response here,
 * and it is NOT a stored response in Redis, and the two would disagree if both
 * ran on the same request. The rule is therefore: a request that carries a
 * device claim skips the Redis layer entirely.
 *
 * ## What is hashed, which is the whole design
 *
 * "Mismatch on replay ⇒ 409, never a silent re-apply." The check only means
 * something if the hash covers what a REPLAY must not be allowed to change, and
 * excludes what legitimately differs between the original and the replay.
 *
 *   IN   the operation (`checkout`, `checkin`, `renew`) — a replayed id that
 *        now claims to be a different verb is the single most dangerous case.
 *   IN   every business identifier: the barcode or item id, the patron id, the
 *        branch. Changing any of them is a different act wearing an old id.
 *   IN   `effectiveAt`, the client's own instant. A replay claiming a different
 *        physical time is a different act: it prices differently.
 *   OUT  the server's clock. It differs on every attempt by definition.
 *   OUT  the auth token and the session. A device may re-authenticate between
 *        the original and the replay, and must still be able to flush its queue.
 *   OUT  `deviceSeq`. It is the device's own ordering, not part of the act, and
 *        a device that re-orders its queue after a partial flush would otherwise
 *        get a 409 on every remaining item.
 *   OUT  anything the SERVER derives — the due date, the policy snapshot, the
 *        loan id. Hashing a derived value would turn "the library changed its
 *        rules" into "your queue is corrupt".
 *
 * The digest is over a CANONICAL string built here, not over `JSON.stringify` of
 * a caller's object: property order in JS is insertion order, so two callers
 * building the same logical request in a different order would hash
 * differently and 409 each other for ever.
 */
export type DeviceClaim = {
  readonly deviceId: string;
  /** A UUID the device minted. The primary key, with `deviceId`. */
  readonly clientChangeId: string;
  /** The device's own monotonic counter. Recorded, not enforced — see below. */
  readonly deviceSeq: bigint;
};

/** The business identity of a request, in the order it is hashed. */
export type RequestIdentity = {
  readonly operation: 'checkout' | 'checkin' | 'renew';
  /** Every business field, as `key=value`. Sorted here, so callers need not. */
  readonly fields: Readonly<Record<string, string | null>>;
};

export function requestHash(identity: RequestIdentity): string {
  const parts: string[] = [identity.operation];
  for (const key of Object.keys(identity.fields).sort()) {
    parts.push(`${key}=${identity.fields[key] ?? ''}`);
  }
  // A separator that cannot appear in a cuid, a uuid, a barcode or an RFC 3339
  // instant, so `{a: 'x', b: 'y'}` and `{a: 'xb=y'}` cannot collide.
  return createHash('sha256').update(parts.join(''), 'utf8').digest('hex');
}

/** What a replay found. */
export type ReplayOutcome =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'replay'; readonly response: unknown; readonly serverEventSeq: bigint | null };

export class ReplayMismatchError extends ConflictException {
  constructor(
    readonly deviceId: string,
    readonly clientChangeId: string,
  ) {
    super({
      code: 'circulation.replayMismatch',
      message:
        'This change id has already been applied, with a different request. The server will not ' +
        're-apply it, and it will not silently return the other request’s answer. Fetch the ' +
        'stored response for this id, reconcile, and mint a new id for anything still outstanding.',
      deviceId,
      clientChangeId,
    });
  }
}

/**
 * The cheap pre-flight, OUTSIDE the transaction.
 *
 * One indexed read on the primary key. A replay stops here and never opens a
 * transaction, never takes a lock and never touches a patron or an item — which
 * is what "re-applies nothing" asks for, and is why the common case (not a
 * replay) pays a single row lookup and nothing else.
 *
 * A `null` here is not a guarantee: two concurrent flushes of the same id both
 * see nothing and both proceed. That race is closed by the PRIMARY KEY inside
 * the transaction, where the loser gets `23505` and the whole effect rolls back.
 * This read is an optimisation and the constraint is the correctness.
 */
export async function lookupReplay(
  tx: TxV2,
  claim: DeviceClaim,
  hash: string,
): Promise<ReplayOutcome> {
  const found = await tx.syncClientChange.findUnique({
    where: {
      deviceId_clientChangeId: {
        deviceId: claim.deviceId,
        clientChangeId: claim.clientChangeId,
      },
    },
    select: { requestHash: true, responseJson: true, serverEventSeq: true },
  });
  if (found === null) return { kind: 'fresh' };
  if (found.requestHash !== hash) {
    throw new ReplayMismatchError(claim.deviceId, claim.clientChangeId);
  }
  return { kind: 'replay', response: found.responseJson, serverEventSeq: found.serverEventSeq };
}

/**
 * Record the claim, INSIDE the transaction that produced the effect.
 *
 * Last statement rather than first, and the difference is provable from outside:
 * written last, a rollback takes the row with it, so "the change was applied"
 * and "the change is recorded as applied" are the same fact. Written first and
 * committed separately, they are two facts that can disagree, and the
 * disagreement is a book that was never lent and can never be lent again.
 *
 * `server_event_seq` comes from `libriant.last_event_seq`, which the changelog
 * trigger publishes transaction-locally — so the position a device resumes the
 * feed from costs no query and is not a guess. A transaction that fired several
 * triggers publishes the LAST, which is the position after everything this
 * transaction did.
 */
export async function recordClaim(
  tx: TxV2,
  claim: DeviceClaim,
  hash: string,
  response: unknown,
): Promise<void> {
  const rows = await tx.$queryRaw<{ seq: string | null }[]>`
    SELECT NULLIF(pg_catalog.current_setting('libriant.last_event_seq', true), '') AS seq`;
  const seq = rows[0]?.seq ?? null;

  await tx.syncClientChange.create({
    data: {
      deviceId: claim.deviceId,
      clientChangeId: claim.clientChangeId,
      deviceSeq: claim.deviceSeq,
      requestHash: hash,
      responseJson: response as never,
      serverEventSeq: seq === null ? null : BigInt(seq),
    },
  });
}

/**
 * `device_seq` is RECORDED and not enforced, and that is phase 78's boundary.
 *
 * The primary key is `(device_id, client_change_id)`, so exactly-once does not
 * need the sequence at all. What the sequence is for is GAP DETECTION — "this
 * device has flushed 1, 2, 3, 5; where is 4?" — and that question belongs to the
 * batch push endpoint and the reconciliation report §6 phase 78 owns, both of
 * which see a whole queue rather than one request. Enforcing monotonicity here
 * would refuse a device that legitimately flushes out of order after a partial
 * failure, which is the ordinary case rather than the corrupt one.
 */
export const DEVICE_SEQ_IS_RECORDED_NOT_ENFORCED = true;
