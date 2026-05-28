import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { loadEnv } from '../config/env.js';

/**
 * Cookie helper for the admin session. Mirrors `CookieService` for the
 * tenant flow but uses the `__Host-libriant_admin` cookie name + the
 * shorter admin TTL. SameSite=Strict (vs Lax for tenant) because admin
 * pages are never expected to be linked from a tenant origin.
 */
@Injectable()
export class AdminCookieService {
  readonly name: string;
  private readonly secure: boolean;

  constructor() {
    const env = loadEnv();
    this.name = env.adminCookieName;
    this.secure = env.sessionCookieSecure;
  }

  setSession(res: Response, token: string, expiresAt: Date): void {
    res.cookie(this.name, token, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'strict',
      path: '/',
      expires: expiresAt,
    });
  }

  clearSession(res: Response): void {
    res.clearCookie(this.name, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'strict',
      path: '/',
    });
  }
}
