import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service.js';
import { RateLimitService } from './rate-limit.service.js';

/**
 * Global so any module can `@Inject(RedisService)` / `@Inject(RateLimitService)`
 * without re-importing. There's only ever one Redis connection per process.
 */
@Global()
@Module({
  providers: [RedisService, RateLimitService],
  exports: [RedisService, RateLimitService],
})
export class RedisModule {}
