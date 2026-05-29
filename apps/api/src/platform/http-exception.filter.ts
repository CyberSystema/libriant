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

/**
 * Plain-language exception envelope (UX principle: "Errors are human —
 * never `Error 500`").
 *
 * Behaviour by status:
 *   • 4xx from NestJS HttpException — pass through verbatim. These are
 *     already user-readable: BadRequest, NotFound, Forbidden, etc. The
 *     handlers wrote the message; we shouldn't second-guess it.
 *   • 5xx OR anything that wasn't an HttpException — generate a short
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
      // 5xx HttpExceptions still get re-skinned — server-side bugs that
      // were thrown deliberately (e.g. InternalServerErrorException) are
      // just as much "Error 500" to the user.
      this.handle5xx(req, res, status, exception, body);
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
    this.logger.error(
      JSON.stringify({
        supportCode,
        status,
        method: req.method,
        url: req.originalUrl,
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
