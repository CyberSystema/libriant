import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, of, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { RedisService } from './redis.service.js';

const HEADER = 'idempotency-key';
const PENDING = '__pending__';
/** A crashed/abandoned in-flight request frees the key within this window. */
const PENDING_TTL_SEC = 60;
/** How long a completed result is replayable — covers a retry after a network
 *  drop or an offline client reconnecting and re-sending its queued action. */
const RESULT_TTL_SEC = 24 * 60 * 60;
/** Bound the header so a hostile client can't store giant Redis keys. */
const MAX_KEY_LEN = 200;

/**
 * Idempotency-Key support for non-idempotent state-changing routes
 * (checkout / return / renew / mark-lost). The client sends a stable
 * `Idempotency-Key` header per logical action; a retry, double-submit, or
 * offline replay with the SAME key never re-runs the operation — it replays the
 * original response. This is what stops a returned-twice double fine and is the
 * prerequisite for the offline circulation queue (Roadmap #5).
 *
 * Protocol (per `idem:<tenant>:<method>:<path>:<key>`):
 *   1. SETNX a `pending` marker. Won the claim → run the handler; on success
 *      store the response body (replayable for 24h); on error DELETE the marker
 *      so a corrected retry can proceed (the handler's work rolled back — these
 *      routes are transactional).
 *   2. Lost the claim → if a stored result exists, REPLAY it (Nest re-applies
 *      the route's normal status; we tag it `X-Idempotent-Replay`). If it's
 *      still `pending` (a genuine concurrent duplicate), return 409 so the
 *      caller backs off rather than double-acting.
 *
 * Opt-in: no header → normal behaviour (compat for callers that don't send one).
 * Fails OPEN if Redis is unavailable — circulation must keep working during a
 * cache outage; the UI's submit-disable still guards the common double-click.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const key = req.header(HEADER);
    if (key === undefined) return next.handle(); // opt-in — no key, no dedup

    if (typeof key !== 'string' || key.length < 1 || key.length > MAX_KEY_LEN) {
      throw new BadRequestException(`Idempotency-Key must be 1–${MAX_KEY_LEN} characters.`);
    }

    const tenantId = req.tenant?.id ?? 'none';
    const rkey = `idem:${tenantId}:${req.method}:${req.path}:${key}`;

    let claimed: string | null;
    try {
      claimed = await this.redis.client.set(rkey, PENDING, 'EX', PENDING_TTL_SEC, 'NX');
    } catch (err) {
      // Redis down → fail open (no dedup) so the desk can still circulate.
      this.logger.warn(
        `idempotency claim failed (Redis down?), proceeding without dedup: ${
          (err as Error).message
        }`,
      );
      return next.handle();
    }

    if (claimed === 'OK') {
      return next.handle().pipe(
        tap((body) => {
          this.redis.client
            .set(rkey, JSON.stringify({ body: body ?? null }), 'EX', RESULT_TTL_SEC)
            .catch(() => undefined);
        }),
        catchError((err: unknown) => {
          // The operation failed (and these routes are transactional, so it
          // rolled back) — release the key so a fixed retry can run.
          this.redis.client.del(rkey).catch(() => undefined);
          return throwError(() => err);
        }),
      );
    }

    // Key already taken: replay the stored result, or 409 while it's in flight.
    const existing = await this.redis.client.get(rkey).catch(() => null);
    if (existing && existing !== PENDING) {
      try {
        const parsed = JSON.parse(existing) as { body: unknown };
        res.setHeader('X-Idempotent-Replay', 'true');
        return of(parsed.body);
      } catch {
        // fall through to conflict on a corrupt entry
      }
    }
    throw new ConflictException(
      'A previous identical request is still being processed. Please wait a moment and try again.',
    );
  }
}
