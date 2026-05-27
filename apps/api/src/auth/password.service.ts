import { Injectable } from '@nestjs/common';
// bcryptjs is CJS; default import works under Node ESM with esModuleInterop.
import bcrypt from 'bcryptjs';
import { loadEnv } from '../config/env.js';

/**
 * Password hashing + verification. Uses bcrypt with a tuneable cost.
 *
 * For login flows, we also expose a `dummyVerify()` so that the time taken
 * to reject an unknown email is indistinguishable from the time taken to
 * reject a wrong password — closing a classic timing oracle.
 */
@Injectable()
export class PasswordService {
  private readonly cost: number;
  /** Pre-computed hash of a random string, used as the dummy target. */
  private readonly dummyHash: string;

  constructor() {
    this.cost = loadEnv().bcryptCost;
    // Synchronously hash a constant during boot. The string never matches
    // any real password (it's longer than the bcrypt 72-byte limit).
    this.dummyHash = bcrypt.hashSync('libriant-no-such-user-dummy-' + 'x'.repeat(72), this.cost);
  }

  async hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.cost);
  }

  async verify(plain: string, hashed: string): Promise<boolean> {
    return bcrypt.compare(plain, hashed);
  }

  /**
   * Run a bcrypt compare against a precomputed dummy hash. Use this when
   * the user lookup fails so that the response time matches a real check.
   * Always returns false.
   */
  async dummyVerify(plain: string): Promise<false> {
    await bcrypt.compare(plain, this.dummyHash);
    return false;
  }
}
