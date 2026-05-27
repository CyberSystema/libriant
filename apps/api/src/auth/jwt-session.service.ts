import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { loadEnv } from '../config/env.js';

/**
 * What's inside the session cookie. Compact field names keep the cookie
 * small. We never put PII here — only IDs and the issuance metadata.
 */
export type SessionPayload = {
  /** Subject = User.id (control-plane cuid). */
  sub: string;
  /** Tenant id this user belongs to. Cross-checked against the URL tenant
   *  by `TenantGuard` to prevent cross-tenant access. */
  tid: string;
  /** Role at signing time. May be stale — authoritative role lives in DB. */
  role: 'owner' | 'admin' | 'librarian' | 'volunteer';
  /** Issued-at, in seconds. */
  iat: number;
  /** Expires-at, in seconds. */
  exp: number;
};

@Injectable()
export class JwtSessionService {
  private readonly secret: string;
  private readonly ttlSec: number;

  constructor() {
    const env = loadEnv();
    this.secret = env.sessionSecret;
    this.ttlSec = env.sessionTtlSec;
  }

  /** Sign a fresh session token for the given user/tenant/role. */
  sign(input: Pick<SessionPayload, 'sub' | 'tid' | 'role'>): { token: string; expiresAt: Date } {
    // jsonwebtoken stamps `iat` itself and refuses to honor an explicit one
    // unless `noTimestamp` is set — and `noTimestamp` strips iat from the
    // payload entirely, which then trips our typed-claim guard on verify.
    // Easiest: let the library handle iat + expiresIn for us.
    const expiresInSec = this.ttlSec;
    const token = jwt.sign({ sub: input.sub, tid: input.tid, role: input.role }, this.secret, {
      algorithm: 'HS256',
      expiresIn: expiresInSec,
    });
    return { token, expiresAt: new Date(Date.now() + expiresInSec * 1000) };
  }

  /**
   * Verify a token's signature and expiry. Returns the payload on success,
   * null on any failure (bad signature, expired, malformed).
   */
  verify(token: string): SessionPayload | null {
    try {
      const decoded = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
      if (typeof decoded !== 'object' || decoded === null) return null;
      const obj = decoded as Record<string, unknown>;
      if (
        typeof obj.sub !== 'string' ||
        typeof obj.tid !== 'string' ||
        typeof obj.role !== 'string' ||
        typeof obj.iat !== 'number' ||
        typeof obj.exp !== 'number'
      ) {
        return null;
      }
      return obj as unknown as SessionPayload;
    } catch {
      return null;
    }
  }
}
