import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { scrubUrl } from './log-redaction.js';

/**
 * Plain-language exception envelope (UX principle: "Errors are human —
 * never `Error 500`").
 *
 * Behaviour by status:
 *   • 4xx from NestJS HttpException — pass through verbatim. These are
 *     already user-readable: BadRequest, NotFound, Forbidden, etc. The
 *     handlers wrote the message; we shouldn't second-guess it.
 *   • 503 from an HttpException — pass through verbatim, log at warn. A
 *     deliberate refusal is not an incident, and its message (which
 *     dependency is down, whether anything was charged) is the reason it
 *     was raised.
 *   • any other 5xx, or anything that wasn't an HttpException — generate a short
 *     `supportCode` (8 chars, base36), log the full stack server-side
 *     against that code, and return ONLY a generic friendly message +
 *     the support code to the client. Users can copy/paste the code
 *     into a support email; ops can grep the log to find the trace
 *     instantly.
 *
 * The shape is intentionally identical to NestJS's default so existing
 * web-side `ApiError` parsing keeps working:
 *
 *   { statusCode, error, message, ...extras }
 *
 * with one extra: `supportCode` on 5xx.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    // Path 1: explicit HttpException with a 4xx — pass through unchanged.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = normalizeBody(exception);
      if (status < HttpStatus.INTERNAL_SERVER_ERROR) {
        res.status(status).json(body);
        return;
      }
      // 503 is the exception to the exception: it is not a bug, it is a
      // DELIBERATE refusal, and its message is the whole point of raising it.
      // Every one this API throws was written for a human and names something
      // actionable — "Billing is not configured on this server", "Nothing has
      // been charged, please try again", and /readyz's dependency diagnostics,
      // which the audit specifically wanted to survive so an operator can see
      // WHICH dependency is down. Re-skinning those as "something went wrong
      // on our end" threw away the answer and minted a support code for an
      // incident that never happened — which is worse than useless, because it
      // trains everyone to treat real support codes as noise.
      if (status === HttpStatus.SERVICE_UNAVAILABLE) {
        // Logged, because a service refusing work is worth seeing — but at
        // warn and without a stack: the throw site is known and expected, and
        // a health prober hitting a degraded /readyz every few seconds must
        // not read as a storm of errors.
        this.logger.warn(`503 ${req.method} ${scrubUrl(req.originalUrl)}: ${exception.message}`);
        res.status(status).json(body);
        return;
      }

      // Every other 5xx still gets re-skinned — a deliberately thrown
      // InternalServerErrorException is just as much "Error 500" to the user,
      // and its message was written for us, not for them.
      this.handle5xx(req, res, status, exception, body);
      return;
    }

    // Path 1.5: framework/middleware errors that carry a client-error
    // status but aren't NestJS HttpExceptions — e.g. body-parser's
    // `PayloadTooLargeError` (413) or a malformed-body `SyntaxError` (400).
    // These are the user's fault, not a server bug, so surface the real
    // 4xx with a plain message rather than masking it as a 500.
    const clientStatus = clientErrorStatus(exception);
    if (clientStatus !== null) {
      res.status(clientStatus).json({
        statusCode: clientStatus,
        error: 'BadRequest',
        message: friendlyClientMessage(clientStatus),
      });
      return;
    }

    // Path 2: anything else — unhandled throw, db connection lost, etc.
    this.handle5xx(req, res, HttpStatus.INTERNAL_SERVER_ERROR, exception, null);
  }

  private handle5xx(
    req: Request,
    res: Response,
    status: number,
    exception: unknown,
    declaredBody: Record<string, unknown> | null,
  ): void {
    const supportCode = newSupportCode();
    const err = exception as Error;
    // Log the full diagnostic record on ONE line with the supportCode
    // so an operator who's holding the code from the user can grep it.
    //
    // `req.originalUrl` went in verbatim, which defeated reliability-03 from
    // the other end: the signed-download endpoint takes its bearer token as a
    // query parameter (`/_files/signed?token=<jwt>`), so any 5xx on that route
    // wrote a live, replayable credential into the same stdout the access log
    // had just been cleaned up for. `scrubUrl` keeps the path and the parameter
    // names — everything an operator holding a support code needs — and drops
    // the values. Shared with the access log so the two cannot drift.
    this.logger.error(
      JSON.stringify({
        supportCode,
        status,
        method: req.method,
        url: scrubUrl(req.originalUrl),
        message: err?.message ?? String(exception),
        stack: err?.stack ?? null,
        declaredBody,
      }),
    );
    res.status(status).json({
      statusCode: status,
      error: 'InternalServerError',
      message:
        "Sorry — something went wrong on our end. We've logged it. " +
        `Please try again, or send us this code if it keeps happening: ${supportCode}`,
      supportCode,
    });
  }
}

/**
 * If `exception` is an error-like object carrying a client-error status
 * (4xx) — the shape http-errors / body-parser use — return that status,
 * else null. We only trust 4xx here: 5xx-ish library errors fall through
 * to the generic 500 path so they get a support code + full logging.
 */
function clientErrorStatus(exception: unknown): number | null {
  if (!exception || typeof exception !== 'object') return null;
  const e = exception as { status?: unknown; statusCode?: unknown };
  const raw = typeof e.status === 'number' ? e.status : e.statusCode;
  return typeof raw === 'number' && raw >= 400 && raw < 500 ? raw : null;
}

/** Plain-language message for the common middleware-level client errors. */
function friendlyClientMessage(status: number): string {
  if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
    return 'That was too large to accept. Please use a smaller file or shorter text.';
  }
  if (status === HttpStatus.BAD_REQUEST) {
    return "We couldn't read that request. Please refresh and try again.";
  }
  return "We couldn't process that request. Please check your input and try again.";
}

function normalizeBody(exception: HttpException): Record<string, unknown> {
  const raw = exception.getResponse();
  if (typeof raw === 'string') {
    return { statusCode: exception.getStatus(), message: raw };
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  return { statusCode: exception.getStatus(), message: 'Error' };
}

/** 8-char base36, all-uppercase. Memorable enough to read aloud over a phone call. */
function newSupportCode(): string {
  // 5 random bytes → 8 chars when base-encoded at 32 (5 bits per char).
  // We use a simple base36 to keep the alphabet familiar.
  let n = parseInt(randomBytes(5).toString('hex'), 16);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out = ALPHABET[n % 36] + out;
    n = Math.floor(n / 36);
  }
  return out;
}

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
