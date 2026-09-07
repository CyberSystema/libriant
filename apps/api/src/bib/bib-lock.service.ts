import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';

/**
 * The record lock: who has this record open in the editor.
 *
 * ## What it is not
 *
 * Not a database lock, and it must never gate `write()`. The write path has its
 * own two mechanisms — an advisory lock for the milliseconds of the save, and a
 * content-hash compare-and-swap for staleness — and this is a third thing at a
 * human timescale: an intent to hold a record for ten minutes, which has to
 * survive a connection drop, be visible to somebody else's SELECT, and be taken
 * over.
 *
 * In 10b it is ADVISORY. It tells the editor whom to name in a banner; nothing
 * refuses a save because of it. An import, an overlay, a merge, a batch job and
 * the phase-19 copy-forward all have to be able to write a record a cataloguer
 * has open, and a lock that could stop them would be a lock somebody has to be
 * able to override at 2am.
 *
 * ## A lock is held by a TAB, not by a person
 *
 * That is the strongest measurement in this phase. Guarding on the holder alone
 * and racing a live lock with 25 contenders who are all the SAME cataloguer in
 * 25 different browser tabs: **25 winners, 0 refused** — every tab silently
 * inherits the lock, and she loses her work the first time she opens a second
 * one. With `session_id` in the guard: 0 winners, 25 refused.
 *
 * ## Acquire, renew and take-over are ONE statement
 *
 * An upsert on the primary key, whose WHERE decides which of the three it was.
 * Measured, with all 25 clients provably parked on a barrier before release:
 *
 *     free record, 25 users              1 winner  / 24 refused
 *     EXPIRED lock, 25 users             1 winner  / 24 refused
 *     LIVE lock held by a non-contender  0 winners / 25 refused
 *
 * The last line is the important one: a live lock is never taken by accident.
 * Taking one is a separate, deliberate act that has to quote the incumbent —
 * see {@link acquire}'s `seenSessionId`.
 */

/** How long a lock lives without a heartbeat. */
export const LOCK_TTL_SECONDS = 600;

export type LockView = {
  readonly recordId: string;
  readonly holderUserId: string;
  readonly sessionId: string;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
  readonly heartbeatCount: number;
};

type AcquireRow = {
  holder_user_id: string;
  session_id: string;
  acquired_at: Date;
  expires_at: Date;
  heartbeat_count: number;
  displaced_holder_user_id: string | null;
  displaced_reason: 'expired' | 'taken_over' | null;
  was_insert: boolean;
};

@Injectable()
export class BibLockService {
  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
  ) {}

  /**
   * Take the lock, renew it, or take it from somebody.
   *
   * `seenSessionId` is what separates a renewal from a seizure. To take a LIVE
   * lock the caller must name the session it believes is holding it — the value
   * the banner showed. That makes the take-over a compare-and-swap on the
   * incumbent rather than a blind force, so a stale banner cannot displace
   * whoever happens to hold the record now. Measured: quoting the right
   * incumbent succeeds and records `displaced_reason = 'taken_over'`; quoting a
   * stale one is refused; sending nothing against a live lock is refused.
   */
  async acquire(
    tenant: TenantContext,
    actor: TenantActor,
    input: { recordId: string; sessionId: string; seenSessionId?: string },
  ): Promise<LockView> {
    const client = this.tenantPrisma.getClientV2(tenant);

    // The record has to exist and not be deleted. The foreign key alone is not
    // enough — measured, it happily admits a lock on a SOFT-deleted record,
    // which the write path 404s on.
    const record = await client.marcRecord.findUnique({
      where: { id: input.recordId },
      select: { id: true, deletedAt: true },
    });
    if (!record || record.deletedAt) {
      throw new NotFoundException(`No catalogue record ${input.recordId}.`);
    }

    const rows = await client.$queryRaw<AcquireRow[]>`
      INSERT INTO lbr2.marc_record_locks
        (record_id, holder_user_id, session_id, expires_at)
      VALUES (
        ${input.recordId}, ${actor.actorId}, ${input.sessionId},
        pg_catalog.now() + ${`${LOCK_TTL_SECONDS} seconds`}::interval
      )
      ON CONFLICT (record_id) DO UPDATE
         SET holder_user_id  = EXCLUDED.holder_user_id,
             session_id      = EXCLUDED.session_id,
             acquired_at     = pg_catalog.now(),
             expires_at      = EXCLUDED.expires_at,
             heartbeat_count = 0,
             -- Whom this displaced, and why. NULL when the same tab simply
             -- renewed, which is the common case and is not an event.
             displaced_holder_user_id =
               CASE WHEN lbr2.marc_record_locks.holder_user_id = EXCLUDED.holder_user_id
                     AND lbr2.marc_record_locks.session_id = EXCLUDED.session_id
                    THEN NULL ELSE lbr2.marc_record_locks.holder_user_id END,
             displaced_reason =
               CASE WHEN lbr2.marc_record_locks.holder_user_id = EXCLUDED.holder_user_id
                     AND lbr2.marc_record_locks.session_id = EXCLUDED.session_id
                    THEN NULL
                    WHEN lbr2.marc_record_locks.expires_at <= pg_catalog.now()
                    THEN 'expired'
                    ELSE 'taken_over' END
       WHERE lbr2.marc_record_locks.expires_at <= pg_catalog.now()
          OR (lbr2.marc_record_locks.holder_user_id = EXCLUDED.holder_user_id
              AND lbr2.marc_record_locks.session_id = EXCLUDED.session_id)
          OR (${input.seenSessionId ?? null}::text IS NOT NULL
              AND lbr2.marc_record_locks.session_id = ${input.seenSessionId ?? null}::text)
      RETURNING holder_user_id, session_id, acquired_at, expires_at, heartbeat_count,
                displaced_holder_user_id, displaced_reason, (xmax = 0) AS was_insert`;

    if (rows.length === 0) {
      // Refused. The upsert returns nothing, so the incumbent has to be read
      // separately — there is no way to have both in one statement, and the
      // banner needs a name.
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'catalog.recordLocked',
        message: 'Somebody else has this record open.',
        holder: await this.current(tenant, input.recordId),
      });
    }

    const row = rows[0]!;
    // ONE audit row per event, and never for a renewal. The `displaced_reason`
    // the statement computed is what makes `lock_expired` and `lock_taken_over`
    // distinguishable — without it they are the same row with different prose.
    if (row.displaced_reason === 'taken_over') {
      await this.audit.record(tenant, actor, {
        action: 'catalog.record.lock_taken_over',
        targetType: 'marc_record',
        targetId: input.recordId,
        before: { holderUserId: row.displaced_holder_user_id },
        after: { holderUserId: row.holder_user_id, sessionId: row.session_id },
      });
    } else if (row.displaced_reason === 'expired') {
      // LAZY CAPTURE. The lock had lapsed and nobody had swept it yet, so the
      // acquire is what noticed. See the sweep job for why both mechanisms are
      // needed and why they cannot double-write.
      await this.audit.record(tenant, actor, {
        action: 'catalog.record.lock_expired',
        targetType: 'marc_record',
        targetId: input.recordId,
        before: { holderUserId: row.displaced_holder_user_id },
        after: { noticedBy: 'acquire' },
      });
      await this.audit.record(tenant, actor, {
        action: 'catalog.record.lock_acquired',
        targetType: 'marc_record',
        targetId: input.recordId,
        after: { sessionId: row.session_id },
      });
    } else if (row.was_insert) {
      await this.audit.record(tenant, actor, {
        action: 'catalog.record.lock_acquired',
        targetType: 'marc_record',
        targetId: input.recordId,
        after: { sessionId: row.session_id },
      });
    }

    return view(input.recordId, row);
  }

  /**
   * Keep a lock alive.
   *
   * Guarded on record + holder + session + liveness, all four. Measured: the
   * true holder gets one row; an impostor, the SAME USER IN A DIFFERENT TAB, and
   * the true holder after expiry each get zero. The third of those is what
   * `session_id` is for.
   *
   * A lapsed lock is NOT silently renewed. Refusing is what tells the editor to
   * stop and re-acquire, which is the moment somebody else may have taken the
   * record — and pretending otherwise would let two tabs believe they hold it.
   */
  async heartbeat(
    tenant: TenantContext,
    actor: TenantActor,
    input: { recordId: string; sessionId: string },
  ): Promise<LockView> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const rows = await client.$queryRaw<AcquireRow[]>`
      UPDATE lbr2.marc_record_locks
         SET expires_at = pg_catalog.now() + ${`${LOCK_TTL_SECONDS} seconds`}::interval,
             heartbeat_count = heartbeat_count + 1
       WHERE record_id = ${input.recordId}
         AND holder_user_id = ${actor.actorId}
         AND session_id = ${input.sessionId}
         AND expires_at > pg_catalog.now()
      RETURNING holder_user_id, session_id, acquired_at, expires_at, heartbeat_count,
                displaced_holder_user_id, displaced_reason, false AS was_insert`;

    if (rows.length === 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'catalog.lockLost',
        message:
          'This lock is no longer yours — it lapsed, or somebody took the record. Reopen it ' +
          'before saving.',
        holder: await this.current(tenant, input.recordId),
      });
    }

    const row = rows[0]!;
    // ONCE per session, on the first beat. A beat is ~0.12 ms and happens every
    // sixty seconds; auditing every one would write ten permanent rows per
    // record per session to record that somebody left a tab open. The first beat
    // is the useful one — it is the moment the editor proved it is really there.
    if (row.heartbeat_count === 1) {
      await this.audit.record(tenant, actor, {
        action: 'catalog.record.lock_heartbeat',
        targetType: 'marc_record',
        targetId: input.recordId,
        after: { sessionId: row.session_id },
      });
    }
    return view(input.recordId, row);
  }

  /**
   * Give the record back.
   *
   * Not named by the acceptance criterion, and it exists anyway: without it a
   * cataloguer who closes the editor holds the record for the rest of the TTL,
   * and the only way to get it back is to wait or to take it over — which then
   * writes a `lock_taken_over` row saying somebody was displaced when nobody
   * was.
   *
   * A DELETE, not a flag. The TTL constraint (`expires_at > acquired_at`) makes
   * "release by backdating" illegal on purpose, so there is exactly one way to
   * give a record back, and the durable record of it is the audit row.
   */
  async release(
    tenant: TenantContext,
    actor: TenantActor,
    input: { recordId: string; sessionId: string },
  ): Promise<{ released: boolean }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const deleted = await client.marcRecordLock.deleteMany({
      where: {
        recordId: input.recordId,
        holderUserId: actor.actorId,
        sessionId: input.sessionId,
      },
    });
    // Idempotent: releasing a lock you no longer hold is a no-op, not an error.
    // A closing editor cannot know whether its lock already lapsed, and making
    // that a 409 would put a red banner on the way out of a screen.
    if (deleted.count > 0) {
      await this.audit.record(tenant, actor, {
        action: 'catalog.record.lock_released',
        targetType: 'marc_record',
        targetId: input.recordId,
        after: { sessionId: input.sessionId },
      });
    }
    return { released: deleted.count > 0 };
  }

  /** Who holds this record, if anybody. Live locks only. */
  async current(tenant: TenantContext, recordId: string): Promise<LockView | null> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const row = await client.marcRecordLock.findFirst({
      where: { recordId, expiresAt: { gt: new Date() } },
    });
    return row
      ? {
          recordId,
          holderUserId: row.holderUserId,
          sessionId: row.sessionId,
          acquiredAt: row.acquiredAt,
          expiresAt: row.expiresAt,
          heartbeatCount: row.heartbeatCount,
        }
      : null;
  }
}

function view(recordId: string, row: AcquireRow): LockView {
  return {
    recordId,
    holderUserId: row.holder_user_id,
    sessionId: row.session_id,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatCount: row.heartbeat_count,
  };
}
