import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { loadEnv } from '../config/env.js';

/**
 * What's inside a signed-download token. Compact field names keep the URL
 * short. The token IS the authorization — anyone holding it can fetch
 * the file until `exp`. Treat it like a short-lived bearer.
 */
export type SignedDownloadPayload = {
  /** Tenant id this ref belongs to — the verify endpoint cross-checks
   *  it against the resolved tenant so a token can't be replayed across
   *  tenants. */
  tid: string;
  /** Storage ref (e.g. `covers/abc123.jpg`). */
  ref: string;
  /** Optional Content-Disposition filename suggestion. */
  fn?: string;
  iat: number;
  exp: number;
};

@Injectable()
export class SignedUrlService {
  private readonly secret: string;
  private readonly defaultTtlSec: number;

  constructor() {
    const env = loadEnv();
    this.secret = env.storageSigningSecret;
    this.defaultTtlSec = env.storageSignedTtlSec;
  }

  /**
   * Generate a download token. Returns `{ token, expiresAt }`. The URL
   * the UI exposes is `/_files/signed?token=<token>` (mounted by the
   * StorageDemoController for now).
   */
  sign(input: { tenantId: string; ref: string; filename?: string; ttlSec?: number }): {
    token: string;
    expiresAt: Date;
  } {
    const ttl = input.ttlSec ?? this.defaultTtlSec;
    const token = jwt.sign(
      { tid: input.tenantId, ref: input.ref, fn: input.filename },
      this.secret,
      { algorithm: 'HS256', expiresIn: ttl },
    );
    return { token, expiresAt: new Date(Date.now() + ttl * 1000) };
  }

  /**
   * Verify a download token. Returns the payload on success, null on any
   * failure. Caller must STILL check that the request's resolved tenant
   * matches `payload.tid` — defence against a leaked token being used
   * against a different tenant via a forged Host header.
   */
  verify(token: string): SignedDownloadPayload | null {
    try {
      const decoded = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
      if (typeof decoded !== 'object' || decoded === null) return null;
      const o = decoded as Record<string, unknown>;
      if (
        typeof o.tid !== 'string' ||
        typeof o.ref !== 'string' ||
        typeof o.iat !== 'number' ||
        typeof o.exp !== 'number'
      ) {
        return null;
      }
      return o as unknown as SignedDownloadPayload;
    } catch {
      return null;
    }
  }
}
