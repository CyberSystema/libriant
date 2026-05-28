import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { loadEnv } from '../config/env.js';

/**
 * Impersonation JWT carries everything `SupportSessionGuard` + `TenantGuard`
 * need to validate without a DB hit on every request: which admin, which
 * tenant, and which session row. The session row is still checked for
 * end/expiry — but only if those fields would matter (so we don't hit
 * the DB twice on every page load).
 */
export type ImpersonationPayload = {
  /** Sentinel that lets middleware distinguish from the admin-only JWT. */
  imp: true;
  adminId: string;
  tenantId: string;
  sessionId: string;
  iat: number;
  exp: number;
};

@Injectable()
export class ImpersonationSessionService {
  private readonly secret: string;
  private readonly ttlSec: number;

  constructor() {
    const env = loadEnv();
    this.secret = env.impersonationSecret;
    this.ttlSec = env.supportSessionTtlSec;
  }

  sign(input: { adminId: string; tenantId: string; sessionId: string }): {
    token: string;
    expiresAt: Date;
  } {
    const token = jwt.sign(
      { imp: true, adminId: input.adminId, tenantId: input.tenantId, sessionId: input.sessionId },
      this.secret,
      { algorithm: 'HS256', expiresIn: this.ttlSec },
    );
    return { token, expiresAt: new Date(Date.now() + this.ttlSec * 1000) };
  }

  verify(token: string): ImpersonationPayload | null {
    try {
      const payload = jwt.verify(token, this.secret, { algorithms: ['HS256'] }) as
        | ImpersonationPayload
        | undefined;
      if (!payload || payload.imp !== true) return null;
      return payload;
    } catch {
      return null;
    }
  }
}
