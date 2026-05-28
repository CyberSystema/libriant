import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { loadEnv } from '../config/env.js';

@Injectable()
export class ImpersonationCookieService {
  readonly name: string;
  private readonly secure: boolean;

  constructor() {
    const env = loadEnv();
    this.name = env.impersonationCookieName;
    this.secure = env.sessionCookieSecure;
  }

  set(res: Response, token: string, expiresAt: Date): void {
    res.cookie(this.name, token, {
      httpOnly: true,
      secure: this.secure,
      // `Strict` keeps the impersonation cookie from being sent by any
      // cross-site request (third-party links into the tenant URL would
      // otherwise carry it). The admin always starts the flow from
      // /admin/support/redeem so Strict is fine.
      sameSite: 'strict',
      path: '/',
      expires: expiresAt,
    });
  }

  clear(res: Response): void {
    res.clearCookie(this.name, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'strict',
      path: '/',
    });
  }
}
