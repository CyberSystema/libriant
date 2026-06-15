/**
 * Producer side of the import queue. Enqueues a validate/commit job for a
 * batch; the worker process (import-worker.ts) consumes it. Mirrors the
 * EmailService BullMQ setup — its own connection derived from the shared
 * RedisService options, with the `lbr-bull` prefix.
 *
 * It also owns the crash-recovery sweep the worker docstring promises: on
 * boot (and periodically) it reconciles batches the DB still believes are
 * running against the live BullMQ queue, so a worker crash mid-run can't leave
 * an import wedged in `validating`/`committing` forever (IMP-02).
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { controlDb } from '@libriant/db-control';
import { RedisService } from '../platform/redis.service.js';
import {
  IMPORT_JOB_NAME,
  IMPORT_QUEUE_NAME,
  IMPORT_QUEUE_PREFIX,
  type ImportPhase,
} from './import.constants.js';

/**
 * How long a batch may sit in a running state without a live BullMQ job before
 * the sweep gives up on it. The job-presence check below already reclaims the
 * common crash case immediately; this TTL is the backstop for the window
 * between `enqueue` writing the DB row and the job actually landing in Redis.
 */
const STUCK_TTL_MS = 15 * 60 * 1000;
const SWEEP_EVERY_MS = 5 * 60 * 1000;

/** Job states that mean the work is still live (so the batch is NOT stuck). */
const LIVE_JOB_STATES = new Set(['waiting', 'waiting-children', 'active', 'delayed', 'paused']);

@Injectable()
export class ImportQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImportQueueService.name);
  private readonly queue: Queue;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(@Inject(RedisService) private readonly redis: RedisService) {
    this.queue = new Queue(IMPORT_QUEUE_NAME, {
      connection: {
        host: this.redis.client.options.host,
        port: this.redis.client.options.port,
        password: this.redis.client.options.password,
        db: this.redis.client.options.db,
      },
      prefix: IMPORT_QUEUE_PREFIX,
      defaultJobOptions: {
        // One attempt: the engine commits each row independently and is
        // resumable via re-running with skip/update, so a blind BullMQ retry
        // of a half-done commit is not what we want.
        attempts: 1,
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    // Cold-start recovery: reclaim anything wedged by a previous crash before
    // the periodic timer takes over.
    await this.sweepStuckBatches().catch((err) => {
      this.logger.warn(`startup import sweep failed: ${(err as Error).message}`);
    });
    this.sweepTimer = setInterval(() => {
      void this.sweepStuckBatches().catch((err) => {
        this.logger.warn(`periodic import sweep failed: ${(err as Error).message}`);
      });
    }, SWEEP_EVERY_MS);
    // Don't keep the event loop alive purely for the sweep.
    this.sweepTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.queue.close().catch(() => undefined);
  }

  async enqueue(batchId: string, phase: ImportPhase): Promise<void> {
    // jobId ties the BullMQ job to (batch, phase) so a double-click can't
    // enqueue the same work twice while it's still pending. (No ':' — BullMQ
    // reserves it in custom ids.)
    const jobId = `${batchId}-${phase}`;
    // IMP-07: a prior run with this jobId may still be retained as completed/
    // failed (removeOnComplete/Fail keep the last N). BullMQ ignores `add` for
    // an existing jobId, which would silently swallow a legitimate re-run after
    // a failure — drop the stale record first so re-running a 'failed' batch
    // actually re-enqueues.
    await this.queue.remove(jobId).catch(() => undefined);
    await this.queue.add(IMPORT_JOB_NAME, { batchId, phase }, { jobId });
    this.logger.debug(`enqueued import ${phase} for batch ${batchId}`);
  }

  /**
   * IMP-02: reconcile batches stuck in `validating`/`committing` with the live
   * queue. A batch is reclaimed (→ `failed`, then re-runnable) when there is no
   * live BullMQ job for it (the worker crashed/was killed) OR it has sat in a
   * running state past STUCK_TTL_MS. Genuinely-running batches (a job is
   * waiting/active/delayed) are left alone. The staged file is kept so the
   * reclaimed batch can be re-run; it's cleaned up on completion or delete.
   */
  async sweepStuckBatches(): Promise<number> {
    const running = await controlDb.importBatch.findMany({
      where: { status: { in: ['validating', 'committing'] } },
      select: { id: true, status: true, stagingPath: true, startedAt: true, updatedAt: true },
    });
    if (running.length === 0) return 0;

    const now = Date.now();
    let reclaimed = 0;
    for (const batch of running) {
      const phase: ImportPhase = batch.status === 'committing' ? 'commit' : 'validate';
      let live = false;
      try {
        const job = await this.queue.getJob(`${batch.id}-${phase}`);
        if (job) {
          const state = await job.getState();
          live = LIVE_JOB_STATES.has(state);
        }
      } catch {
        // Treat an unreadable job as not-live; the TTL still guards false alarms.
        live = false;
      }
      const stamp = (batch.startedAt ?? batch.updatedAt).getTime();
      const stale = now - stamp > STUCK_TTL_MS;
      if (live && !stale) continue;

      try {
        // Guard the write on the status we observed so we don't clobber a batch
        // a worker (or another api replica) just transitioned out from under us.
        const upd = await controlDb.importBatch.updateMany({
          where: { id: batch.id, status: batch.status },
          data: {
            status: 'failed',
            error: 'The import worker stopped before this run finished. Re-run to continue.',
            finishedAt: new Date(),
          },
        });
        if (upd.count === 0) continue; // raced — the run finished normally
        // Keep the staged file: the engine matches on the natural key, so a
        // re-run (now permitted on 'failed', see ImportService.requireRunnable)
        // is idempotent over whatever a half-done commit already wrote. Staging
        // is cleaned up when the batch completes or is deleted.
        reclaimed++;
        this.logger.warn(`reclaimed stuck import batch ${batch.id} (was ${batch.status})`);
      } catch (err) {
        this.logger.warn(`could not reclaim batch ${batch.id}: ${(err as Error).message}`);
      }
    }
    return reclaimed;
  }
}
