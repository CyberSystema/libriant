import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { RedisService } from '../platform/redis.service.js';
import {
  MAINTENANCE_JOB_NAME,
  MAINTENANCE_QUEUE_NAME,
  MAINTENANCE_QUEUE_PREFIX,
} from './maintenance.constants.js';

/**
 * Producer side of the maintenance queue. Enqueues a run id; the worker
 * process (maintenance-worker.ts) consumes it. Same BullMQ shape as the
 * import + email queues — own connection from the shared Redis options,
 * `lbr-bull` prefix.
 */
@Injectable()
export class MaintenanceQueueService {
  private readonly logger = new Logger(MaintenanceQueueService.name);
  private readonly queue: Queue;

  constructor(@Inject(RedisService) private readonly redis: RedisService) {
    this.queue = new Queue(MAINTENANCE_QUEUE_NAME, {
      connection: {
        host: this.redis.client.options.host,
        port: this.redis.client.options.port,
        password: this.redis.client.options.password,
        db: this.redis.client.options.db,
      },
      prefix: MAINTENANCE_QUEUE_PREFIX,
      defaultJobOptions: {
        // One attempt: maintenance jobs are idempotent-ish but a blind retry
        // of a half-done VACUUM/migrate isn't useful — the operator re-launches.
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    });
  }

  async enqueue(runId: string): Promise<void> {
    await this.queue.add(MAINTENANCE_JOB_NAME, { runId }, { jobId: runId });
    this.logger.debug(`enqueued maintenance run ${runId}`);
  }
}
