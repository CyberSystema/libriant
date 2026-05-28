import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { loadEnv } from '../config/env.js';

/**
 * Admin session JWT payload. Deliberately disjoint from the tenant
 * `SessionPayload` — admins log in to a different surface, use a separate
 * cookie, and live in a different DB table. The two never mix.
 */
export type AdminSessionPayload = {
  sub: string;
  /** Role at signing time. The DB row is the source of truth at request time. */
  role: 'owner' | 'support';
  iat: number;
  exp: number;
};

@Injectable()
export class AdminSessionService {
  private readonly secret: string;
  private readonly ttlSec: number;

  constructor() {
    const env = loadEnv();
    this.secret = env.adminSessionSecret;
    this.ttlSec = env.adminSessionTtlSec;
  }

  sign(input: Pick<AdminSessionPayload, 'sub' | 'role'>): { token: string; expiresAt: Date } {
    const expiresInSec = this.ttlSec;
    const token = jwt.sign({ sub: input.sub, role: input.role }, this.secret, {
      algorithm: 'HS256',
      expiresIn: expiresInSec,
    });
    return { token, expiresAt: new Date(Date.now() + expiresInSec * 1000) };
  }

  verify(token: string): AdminSessionPayload | null {
    try {
      const payload = jwt.verify(token, this.secret, { algorithms: ['HS256'] }) as
        | AdminSessionPayload
        | undefined;
      if (!payload || typeof payload !== 'object') return null;
      return payload;
    } catch {
      return null;
    }
  }
}
