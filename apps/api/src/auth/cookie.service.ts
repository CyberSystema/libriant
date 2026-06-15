import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { loadEnv } from '../config/env.js';

/**
 * Wraps cookie write/clear with the right name + flags. The cookie name
 * adapts to whether we're serving over HTTPS — `__Host-` prefix in prod,
 * plain name in dev. Always HttpOnly + SameSite=Lax + Path=/.
 */
@Injectable()
export class CookieService {
  readonly name: string;
  private readonly secure: boolean;

  constructor() {
    const env = loadEnv();
    this.name = env.sessionCookieName;
    this.secure = env.sessionCookieSecure;
  }

  /**
   * Set the session cookie. When `persistent` (a "remember me" login) the cookie
   * carries an absolute `expires` so it survives a browser restart; otherwise
   * it's a session cookie (no `expires`) that the browser drops on close — the
   * right default for shared / circulation-desk machines. The JWT's own `exp`
   * is the real lifetime cap either way.
   */
  setSession(res: Response, token: string, expiresAt: Date, persistent = true): void {
    res.cookie(this.name, token, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: '/',
      ...(persistent ? { expires: expiresAt } : {}),
    });
  }

  /** Wipe the session cookie. */
  clearSession(res: Response): void {
    res.clearCookie(this.name, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: '/',
    });
  }
}
