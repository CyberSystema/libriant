import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

/**
 * Append-only logger for every request made under an active impersonation
 * session. Captures method, path, status, and timestamp; before/after
 * diffs for writes are TODO — they need Prisma middleware on the tenant
 * client, which is a separate piece of plumbing.
 *
 * Writes asynchronously after the response is sent so we don't slow the
 * request path down. A DB outage on the audit write just logs to stderr —
 * we prefer "request completed but no audit row" over "request failed
 * because audit row failed", since the alternative would let an admin
 * appear to have done nothing by sabotaging the audit table.
 */
@Injectable()
export class SupportAuditInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      tap({
        next: () => this.write(req, res, null),
        error: (err: unknown) => this.write(req, res, err),
      }),
    );
  }

  private async write(req: Request, res: Response, err: unknown): Promise<void> {
    const imp = req.impersonation;
    if (!imp) return;
    const status =
      err &&
      typeof err === 'object' &&
      'status' in err &&
      typeof (err as { status: number }).status === 'number'
        ? (err as { status: number }).status
        : res.statusCode;
    const path = req.originalUrl.split('?')[0] ?? req.path;
    try {
      await controlDb.supportActionLog.create({
        data: {
          sessionId: imp.sessionId,
          method: req.method,
          path,
          status,
        },
      });
    } catch (writeErr) {
      console.error('[support-audit] failed to write log row', writeErr);
    }
  }
}
