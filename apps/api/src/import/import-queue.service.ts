/**
 * Producer side of the import queue. Enqueues a validate/commit job for a
 * batch; the worker process (import-worker.ts) consumes it. Mirrors the
 * EmailService BullMQ setup — its own connection derived from the shared
 * RedisService options, with the `lbr-bull` prefix.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { RedisService } from '../platform/redis.service.js';
import {
  IMPORT_JOB_NAME,
  IMPORT_QUEUE_NAME,
  IMPORT_QUEUE_PREFIX,
  type ImportPhase,
} from './import.constants.js';

@Injectable()
export class ImportQueueService {
  private readonly logger = new Logger(ImportQueueService.name);
  private readonly queue: Queue;

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

  async enqueue(batchId: string, phase: ImportPhase): Promise<void> {
    await this.queue.add(
      IMPORT_JOB_NAME,
      { batchId, phase },
      // jobId ties the BullMQ job to (batch, phase) so a double-click can't
      // enqueue the same work twice while it's still pending. (No ':' — BullMQ
      // reserves it in custom ids.)
      { jobId: `${batchId}-${phase}` },
    );
    this.logger.debug(`enqueued import ${phase} for batch ${batchId}`);
  }
}
