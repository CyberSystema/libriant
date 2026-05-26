import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service.js';

/**
 * Global so any module can `@Inject(RedisService)` without re-importing.
 * There's only ever one Redis connection per process.
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
