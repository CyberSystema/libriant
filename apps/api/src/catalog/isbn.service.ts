import { Inject, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../platform/redis.service.js';
import { digitsOnly } from './normalize.js';
import { fetchOpenLibraryBook, isValidIsbnShape, type IsbnLookupResult } from './openlibrary.js';

export type { IsbnLookupResult };

type CacheEntry = { found: true; data: IsbnLookupResult } | { found: false };

const POSITIVE_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
const NEGATIVE_TTL_SEC = 60 * 60; // 1 hour — re-check unknown ISBNs every hour

@Injectable()
export class IsbnLookupService {
  private readonly logger = new Logger(IsbnLookupService.name);

  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  /**
   * Resolve an ISBN against OpenLibrary, cached in Redis. Returns null
   * when the ISBN looks invalid or genuinely isn't on OpenLibrary.
   */
  async lookup(rawIsbn: string): Promise<IsbnLookupResult | null> {
    const isbn = digitsOnly(rawIsbn);
    if (!isbn || !isValidIsbnShape(isbn)) return null;
    const key = `isbn:${isbn}`;
    const cached = await this.readCache(key);
    if (cached) return cached.found ? cached.data : null;

    let parsed: IsbnLookupResult | null = null;
    try {
      parsed = await fetchOpenLibraryBook(isbn);
    } catch (err) {
      this.logger.warn(
        `OpenLibrary lookup failed for ${isbn}: ${err instanceof Error ? err.message : err}`,
      );
      // Don't cache transient failures — let the next request retry.
      return null;
    }

    if (!parsed) {
      await this.writeCache(key, { found: false }, NEGATIVE_TTL_SEC);
      return null;
    }
    await this.writeCache(key, { found: true, data: parsed }, POSITIVE_TTL_SEC);
    return parsed;
  }

  // --- internals ---------------------------------------------------------

  /**
   * FAILS OPEN. This is a cache in front of an upstream metadata lookup, and a
   * cache we cannot read is a miss, not an error.
   *
   * It used to be a bare `get`, which meant a Redis outage returned HTTP 500
   * from the ISBN endpoint — so a librarian at the desk could not scan a
   * barcode to catalogue a book, and got an opaque support code instead of a
   * slower answer. The upstream lookup is still perfectly reachable.
   */
  private async readCache(key: string): Promise<CacheEntry | null> {
    let raw: string | null;
    try {
      raw = await this.redis.client.get(key);
    } catch (err) {
      this.logger.warn(
        `Redis unavailable for the ISBN cache (${(err as Error).message}) — going upstream.`,
      );
      return null;
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CacheEntry;
    } catch {
      // A corrupt entry is worth removing, but failing to remove it is not
      // worth failing the request over.
      await this.redis.client.del(key).catch(() => undefined);
      return null;
    }
  }

  /** Best-effort: a lookup that succeeded must not fail because we cannot cache it. */
  private async writeCache(key: string, value: CacheEntry, ttlSec: number): Promise<void> {
    try {
      await this.redis.client.set(key, JSON.stringify(value), 'EX', ttlSec);
    } catch {
      // Intentionally silent at warn level — readCache already logged the
      // outage, and this runs on every lookup while it lasts.
    }
  }
}
