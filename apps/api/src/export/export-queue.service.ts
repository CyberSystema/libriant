import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { RedisService } from '../platform/redis.service.js';
import { EXPORT_JOB_NAME, EXPORT_QUEUE_NAME, EXPORT_QUEUE_PREFIX } from './export.constants.js';

/** Producer for the export queue. Same BullMQ shape as the import/maintenance queues. */
@Injectable()
export class ExportQueueService {
  private readonly logger = new Logger(ExportQueueService.name);
  private readonly queue: Queue;

  constructor(@Inject(RedisService) private readonly redis: RedisService) {
    this.queue = new Queue(EXPORT_QUEUE_NAME, {
      connection: {
        host: this.redis.client.options.host,
        port: this.redis.client.options.port,
        password: this.redis.client.options.password,
        db: this.redis.client.options.db,
      },
      prefix: EXPORT_QUEUE_PREFIX,
      defaultJobOptions: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
    });
  }

  async enqueue(jobId: string): Promise<void> {
    await this.queue.add(EXPORT_JOB_NAME, { jobId }, { jobId });
    this.logger.debug(`enqueued export ${jobId}`);
  }
}
