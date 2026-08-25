import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { controlDb, type Prisma } from '@libriant/db-control';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { loadEnv } from '../config/env.js';
import type { ImpersonationPayload } from './impersonation-session.service.js';
import {
  classifyImpersonatedRequest,
  summarizeBodyKeys,
  type ImpersonationVerdict,
} from './impersonation-policy.js';

/**
 * The gate and the ledger for every request made under an active impersonation
 * session. Two jobs, deliberately in one place.
 *
 * ## 1. It refuses what the window must not reach (authn-authz-05)
 *
 * See `impersonation-policy.ts` for the rules and the probe that motivated
 * them. The short version: an impersonation cookie *alone* — no tenant session
 * at all — returned 200 with a plaintext staff password in the body, and 204 on
 * deleting the library's pending support key.
 *
 * **Why enforcement lives in an interceptor rather than a guard.** A guard is
 * the conventional home for an authorization decision, and if a guard threw
 * here it would run *before* interceptors — so this interceptor would never see
 * the refusal, and the refusal would never be logged. The one thing the library
 * most needs in its log is the attempt that was stopped. Keeping the decision
 * and the log writes on one code path makes "refused" and "recorded" the same
 * event, so neither can happen without the other. Interceptors run before the
 * route handler, so throwing from `intercept()` stops the handler just as dead
 * as a guard would.
 *
 * Registered once, globally, as an `APP_INTERCEPTOR` in `app.module.ts` — not
 * opt-in per controller, because a fence a controller has to remember to ask
 * for is a fence the next controller forgets.
 *
 * ## 2. It writes the library's own audit row, not just ours
 *
 * The previous version wrote `{ sessionId, method, path, status }` to the
 * control-plane `support_action_log` and nothing else. The row a librarian read
 * said `POST /t/<slug>/staff/<id>/reset-password 200` and left them no way to
 * tell which account's credential had been disclosed — the `targetType` /
 * `targetId` columns existed and were never populated. Worse, that table is
 * ours; the log a librarian actually opens is their own tenant `audit_log` at
 * `GET /t/:slug/audit`, and impersonated requests never appeared there at all.
 *
 * So every impersonated **write**, and every **refusal**, now also lands in the
 * tenant's own audit log as an `admin` actor stamped with the support session
 * id — which `AuditService` already surfaces to the librarian as
 * `viaSupport: true`. Reads stay out of the tenant log on purpose: they are in
 * the control-plane row the library can already read at
 * `GET /t/:slug/support/sessions/log`, and folding a row per page load into the
 * librarian's activity feed would bury the writes that matter.
 *
 * ## Failure posture
 *
 * ALLOWED path: the writes happen after the response and a DB failure is logged
 * and swallowed — "request completed but no audit row" beats "request failed
 * because the audit row failed", since the alternative lets an admin appear to
 * have done nothing by sabotaging the audit table.
 *
 * REFUSED path: the writes are awaited before the 403 goes out, because there
 * is no successful response to protect and a refusal nobody can see is not a
 * control. A failing audit write is logged at error level and the request is
 * refused anyway — the fence never depends on the ledger working.
 */
@Injectable()
export class SupportAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(SupportAuditInterceptor.name);
  private readonly tenantPathPrefix: string;

  constructor(@Inject(TenantAuditService) private readonly tenantAudit: TenantAuditService) {
    this.tenantPathPrefix = loadEnv().tenantPathPrefix;
  }

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const imp = req.impersonation;
    // Not a support session — the overwhelmingly common case. Do nothing at all.
    if (!imp) return next.handle();

    const path = req.originalUrl.split('?')[0] ?? req.path;
    const verdict = classifyImpersonatedRequest({
      method: req.method,
      path,
      // Express fills `req.params` from the matched route, which is the only
      // reliable way to tell an id segment from a literal one.
      params: req.params as Record<string, unknown> | undefined,
      tenantPathPrefix: this.tenantPathPrefix,
    });

    if (!verdict.allowed) {
      this.logger.warn(
        `Refused impersonated ${req.method} ${path} (rule=${verdict.rule}, ` +
          `session=${imp.sessionId}, admin=${imp.adminId}).`,
      );
      try {
        await this.record(req, imp, verdict, HttpStatus.FORBIDDEN, path);
      } catch (writeErr) {
        // Log loudly, then refuse regardless: the fence must not be able to
        // fail open just because Postgres hiccuped on the audit insert.
        this.logger.error(
          `refused ${req.method} ${path} but could NOT record it (session=${imp.sessionId})`,
          writeErr,
        );
      }
      throw new ForbiddenException(verdict.message);
    }

    return next.handle().pipe(
      tap({
        next: () => void this.recordAfterResponse(req, res, imp, verdict, path, null),
        error: (err: unknown) => void this.recordAfterResponse(req, res, imp, verdict, path, err),
      }),
    );
  }

  /** Post-response write. Never rejects — see the failure posture note above. */
  private async recordAfterResponse(
    req: Request,
    res: Response,
    imp: ImpersonationPayload,
    verdict: ImpersonationVerdict,
    path: string,
    err: unknown,
  ): Promise<void> {
    try {
      await this.record(req, imp, verdict, statusOf(err, res.statusCode), path);
    } catch (writeErr) {
      this.logger.error(`failed to write support audit rows for ${req.method} ${path}`, writeErr);
    }
  }

  /**
   * One action, two ledgers: ours (`support_action_log`, keyed to the session)
   * and — for writes and refusals — the library's own tenant `audit_log`.
   */
  private async record(
    req: Request,
    imp: ImpersonationPayload,
    verdict: ImpersonationVerdict,
    status: number,
    path: string,
  ): Promise<void> {
    // Field NAMES only, never values. A plaintext password leaving the building
    // is the finding this file exists for; copying request bodies into the
    // control plane would be that same mistake with extra steps.
    const bodyKeys = summarizeBodyKeys(req.body);
    const summary: Prisma.InputJsonValue = {
      outcome: verdict.allowed ? 'allowed' : 'blocked',
      ...(verdict.rule ? { rule: verdict.rule } : {}),
      ...(bodyKeys ? { bodyKeys } : {}),
    };

    await controlDb.supportActionLog.create({
      data: {
        sessionId: imp.sessionId,
        method: req.method,
        path,
        status,
        targetType: verdict.targetType,
        targetId: verdict.targetId,
        afterJson: summary,
      },
    });

    // Reads are covered by the row above; only writes and refusals belong in
    // the librarian's activity feed.
    if (verdict.action === 'support.read') return;
    const tenant = req.tenant as TenantContext | undefined;
    // No tenant means this was an /admin/* route (e.g. the admin ending their
    // own session). There is no tenant database to write into.
    if (!tenant) return;

    await this.tenantAudit.record(
      tenant,
      {
        userId: null,
        actorId: imp.adminId,
        actorType: 'admin',
        supportSessionId: imp.sessionId,
      },
      {
        action: verdict.action,
        targetType: verdict.targetType ?? undefined,
        targetId: verdict.targetId ?? undefined,
        after: { method: req.method, path, status, ...(summary as Record<string, unknown>) },
      },
    );
  }
}

function statusOf(err: unknown, fallback: number): number {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return fallback;
}
