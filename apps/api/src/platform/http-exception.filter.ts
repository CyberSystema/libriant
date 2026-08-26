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
        // reliability-13, the half a 413 hid. NestJS converts the two errors
        // Express raises before routing into HttpExceptions of its own —
        // `SyntaxError` from a malformed JSON body and `URIError` from a bad
        // percent-encoding in the path both become `BadRequestException`
        // (routes-resolver.ts `mapExternalException`) — so they arrive HERE,
        // as Path 1, not at the framework-error branch below, and this branch
        // answered them without a single log line. Worse than the 413 that
        // finding started from: pino-http lives in the middleware chain, which
        // is BEHIND the body parsers, so those requests never got the "request
        // completed" line every other request gets either. `POST /auth/login`
        // with `{oops` — the one unauthenticated endpoint anyone can reach —
        // was a 400 with NO server-side record of any kind. Nothing to grep
        // when someone reports being unable to sign in, and nothing to see
        // when a scanner walks the endpoint.
        //
        // `req.log` is the tell, and it is exact: pino-http attaches the
        // request-scoped child logger it writes that line from, so its absence
        // means nothing else recorded this request and this filter is the only
        // thing that can. Measured against a running API: the CSRF 403, the
        // unknown-tenant 404 and every controller 4xx all carry `req.log`; the
        // malformed body and `/t/%FF/members` do not.
        //
        // Logged, then answered with the ORIGINAL body. Re-skinning it the way
        // Path 1.5 does would be a much larger change than the finding asks
        // for: these bodies carry the `code` strings the web app switches on
        // (`auth.setupAlreadyComplete`, `catalog.authorNameTaken`, and every
        // other translated message), and replacing them with a generic
        // "BadRequest" would turn precise Greek error text into a shrug. The
        // defect was silence, so silence is what gets fixed.
        if (status >= HttpStatus.BAD_REQUEST && !wasAccessLogged(req)) {
          this.logClientError(req, status, exception);
        }
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

    // Path 1.5: framework/middleware errors that carry a client-error status
    // but aren't NestJS HttpExceptions — body-parser's `PayloadTooLargeError`
    // (413), an unsupported charset, an aborted upload. These are the user's
    // fault, not a server bug, so surface the real 4xx with a plain message
    // rather than masking it as a 500.
    //
    // NOT the malformed-body `SyntaxError` this comment used to claim: NestJS
    // turns that one into a `BadRequestException` before any filter runs, so
    // it is handled up in Path 1. Same answer, one branch earlier.
    const clientStatus = clientErrorStatus(exception);
    if (clientStatus !== null) {
      this.reportClientError(req, res, clientStatus, exception);
      return;
    }

    // Path 2: anything else — unhandled throw, db connection lost, etc.
    this.handle5xx(req, res, HttpStatus.INTERNAL_SERVER_ERROR, exception, null);
  }

  /**
   * One warn line for a client error, in the shape an operator greps.
   *
   * reliability-13: both 4xx branches used to return without a single log call.
   * Combined with a `clientErrorStatus` that accepted ANY object carrying a
   * numeric 4xx — the shape of a Stripe SDK error and of most HTTP client
   * wrappers — a Stripe 402/429, or the GitHub desktop-release proxy 404ing,
   * reached the user as "We couldn't process that request" with no support
   * code, no stack and no server-side record of the real cause. Silent 4xx is
   * the failure mode nobody notices.
   *
   * Warn rather than error, because an oversized upload or a truncated body is
   * an ordinary event and must not read as an incident; one JSON line, matching
   * the 5xx record so both grep alike.
   *
   * Separate from {@link reportClientError} because the two branches need
   * different halves: Path 1.5 logs AND replaces the body, Path 1 logs and
   * keeps the body it was given. So the two do NOT read alike, deliberately —
   * a malformed body relabelled by NestJS keeps NestJS's message, because that
   * message is the `code` string the web app translates.
   */
  private logClientError(req: Request, status: number, exception: unknown): void {
    this.logger.warn(
      JSON.stringify({
        status,
        method: req.method,
        url: scrubUrl(req.originalUrl),
        kind: describeKind(exception),
        message: (exception as Error)?.message ?? String(exception),
      }),
    );
  }

  private reportClientError(req: Request, res: Response, status: number, exception: unknown): void {
    this.logClientError(req, status, exception);
    res.status(status).json({
      statusCode: status,
      error: 'BadRequest',
      message: friendlyClientMessage(status),
    });
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
 * The `type` values body-parser / raw-body stamp on the errors they throw.
 * These are the errors this branch was written for.
 *
 * `entity.parse.failed` is in the list but never arrives here, and that is
 * worth stating rather than quietly leaving a dead entry: body-parser raises it
 * by decorating the SyntaxError from `JSON.parse`, and NestJS maps a SyntaxError
 * to a `BadRequestException` before any filter runs, so it is answered up in
 * Path 1. Kept because the list is "what body-parser can throw", not "what
 * reaches this line" — the day Nest stops relabelling it, it lands here already
 * handled instead of falling through to a 500 with a support code.
 * Verified against a running API: `POST /auth/login` with `{oops` logs
 * `"kind":"BadRequestException"`, not a body-parser error.
 */
const BODY_PARSER_ERROR_TYPES = new Set([
  'charset.unsupported',
  'encoding.unsupported',
  'entity.parse.failed',
  'entity.too.large',
  'entity.verify.failed',
  'parameters.too.many',
  'request.aborted',
  'request.size.invalid',
  'stream.encoding.set',
  'stream.not.readable',
]);

/**
 * If `exception` is an error-like object carrying a client-error status
 * (4xx) — the shape http-errors / body-parser use — return that status,
 * else null. We only trust 4xx here: 5xx-ish library errors fall through
 * to the generic 500 path so they get a support code + full logging.
 *
 * reliability-13: "has a numeric 4xx `status`" was too generous a test. Stripe's
 * SDK errors carry `statusCode`, and http client wrappers carry `status`, so a
 * Stripe 402 or 429 escaping a handler was relabelled as the librarian's own
 * bad input and dropped. The extra condition is the `expose` flag http-errors
 * sets on errors whose message is meant for the caller, or one of the
 * body-parser `type`s above; a Stripe error has neither, so it now falls
 * through to the 5xx path and gets a support code and a stack like any other
 * upstream failure.
 */
function clientErrorStatus(exception: unknown): number | null {
  if (!exception || typeof exception !== 'object') return null;
  const e = exception as {
    status?: unknown;
    statusCode?: unknown;
    type?: unknown;
    expose?: unknown;
  };
  const raw = typeof e.status === 'number' ? e.status : e.statusCode;
  if (typeof raw !== 'number' || raw < 400 || raw >= 500) return null;
  const fromBodyParser = typeof e.type === 'string' && BODY_PARSER_ERROR_TYPES.has(e.type);
  return fromBodyParser || e.expose === true ? raw : null;
}

/** Constructor name if there is one — the single most useful field when a
 *  library error turns up somewhere it was not expected. */
function describeKind(exception: unknown): string {
  if (exception === null || exception === undefined) return String(exception);
  return (exception as object).constructor?.name ?? typeof exception;
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

/**
 * Did anything else already record this request?
 *
 * `nestjs-pino` attaches a request-scoped child logger as `req.log` at the top
 * of its middleware, and that is the object it writes the "request completed"
 * line from. Its ABSENCE is therefore exact evidence that the request died
 * before the logging middleware ran — which is precisely the case this filter
 * has to cover, because Express's body parsers sit in front of it.
 *
 * Measured against a running API: the CSRF 403, the unknown-tenant 404 and
 * every controller 4xx all carry `req.log`; a malformed JSON body and a bad
 * percent-encoding in the path do not. Checking the property beats keeping our
 * own list of error types, which would drift the moment Express adds one.
 */
function wasAccessLogged(req: Request): boolean {
  return Boolean((req as Request & { log?: unknown }).log);
}
