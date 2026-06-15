import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { controlDb, Prisma } from '@libriant/db-control';
import { AuthGuard } from '../auth/auth.guard.js';
import { PasswordService } from '../auth/password.service.js';
import { EffectivePlanService } from '../plans/effective-plan.service.js';
import { RedisService } from '../platform/redis.service.js';
import type { StaffRole } from './staff.dto.js';

/**
 * Unambiguous temp-password alphabet (no 0/O/1/I/L) — high entropy but still
 * readable/typable when an admin hands the code to a new staff member.
 */
const TEMP_PW_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** ~12 chars from a 31-symbol alphabet ≈ 59 bits — not a brute-forceable PIN. */
function generateTempPassword(len = 12): string {
  let out = '';
  for (let i = 0; i < len; i++) out += TEMP_PW_ALPHABET[randomInt(TEMP_PW_ALPHABET.length)];
  return out;
}

@Injectable()
export class StaffService {
  constructor(
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(EffectivePlanService) private readonly effective: EffectivePlanService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  /** Non-archived users of a library, owner first. */
  async list(tenantId: string) {
    const rows = await controlDb.user.findMany({
      where: { tenantId, archivedAt: null },
      orderBy: [{ createdAt: 'asc' }],
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        role: true,
        status: true,
        mustChangeCredentials: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
    return rows;
  }

  /**
   * Create a staff account: auto username `staff_N`, a random 4-digit password
   * (returned ONCE so the admin can hand it over), and a forced first-login
   * credential change. No email on file — they sign in with the username.
   */
  async create(tenantId: string, input: { role: StaffRole; fullName?: string }) {
    const tempPassword = generateTempPassword();
    const passwordHash = await this.passwords.hash(tempPassword);

    // Race-safe staff_seats enforcement. Staff users live on the control DB,
    // so we serialize concurrent creates with a control-plane transaction-
    // scoped advisory lock keyed on (tenant, staff_seats), count active seats,
    // and only then insert. The QuotaInterceptor is a fast pre-check; this is
    // the authority that closes the count-then-insert TOCTOU window.
    const lockKey = `quota:${tenantId}:staff_seats`;
    const user = await controlDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const [limit, used] = await Promise.all([
        this.effective.getInt(tenantId, 'staff_seats'),
        tx.user.count({ where: { tenantId, status: 'active' } }),
      ]);
      if (used >= limit) {
        const plan = await this.effective.getEffectivePlan(tenantId);
        throw new HttpException(
          {
            statusCode: HttpStatus.PAYMENT_REQUIRED,
            error: 'Payment Required',
            message: "You've reached your library's staff-seat limit for this plan.",
            feature: 'staff_seats',
            limit,
            used,
            currentPlan: plan.plan?.slug ?? null,
          },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
      const username = await this.nextUsername(tenantId, tx);
      return tx.user.create({
        data: {
          tenantId,
          username,
          email: null,
          fullName: input.fullName?.trim() || username,
          role: input.role,
          status: 'active',
          passwordHash,
          mustChangeCredentials: true,
        },
        select: { id: true, username: true, fullName: true, role: true, status: true },
      });
    });
    return { user, tempPassword };
  }

  /** New high-entropy temp password + re-arm the forced first-login change. Returned once. */
  async resetPassword(tenantId: string, userId: string) {
    await this.requireManaged(tenantId, userId);
    const tempPassword = generateTempPassword();
    const passwordHash = await this.passwords.hash(tempPassword);
    await controlDb.user.update({
      where: { id: userId },
      // Bump sessionsValidAfter so an admin-forced reset ends the user's
      // existing sessions immediately (AUTH-01), then bust the positive cache.
      data: {
        passwordHash,
        mustChangeCredentials: true,
        failedLogins: 0,
        lockedUntil: null,
        sessionsValidAfter: new Date(),
      },
    });
    await AuthGuard.invalidateAuthCache(this.redis, userId);
    return { tempPassword };
  }

  async setRole(tenantId: string, userId: string, role: StaffRole) {
    await this.requireManaged(tenantId, userId);
    await controlDb.user.update({ where: { id: userId }, data: { role } });
    // The 60s positive auth cache would otherwise serve the stale role; bust it
    // so a downgrade (e.g. admin→volunteer) takes effect on the next request.
    await AuthGuard.invalidateAuthCache(this.redis, userId);
  }

  /** Archive a staff account. The acting admin can't deactivate themselves. */
  async deactivate(tenantId: string, userId: string, actingUserId: string) {
    await this.requireManaged(tenantId, userId);
    if (userId === actingUserId) {
      throw new BadRequestException('You can’t deactivate your own account.');
    }
    await controlDb.user.update({
      where: { id: userId },
      // disabled → can't log in (login requires status === 'active');
      // archivedAt hides them from the staff list. Bump the session epoch so
      // existing cookies die now, and bust the 60s positive auth cache so the
      // deactivation is enforced on the next request rather than up to a minute
      // later (tenancy-new).
      data: { status: 'disabled', archivedAt: new Date(), sessionsValidAfter: new Date() },
    });
    await AuthGuard.invalidateAuthCache(this.redis, userId);
  }

  // --- internals -----------------------------------------------------------

  /** Next free `staff_N` for the tenant (max existing suffix + 1). */
  private async nextUsername(
    tenantId: string,
    db: Prisma.TransactionClient | typeof controlDb = controlDb,
  ): Promise<string> {
    const rows = await db.user.findMany({
      where: { tenantId, username: { startsWith: 'staff_' } },
      select: { username: true },
    });
    let max = 0;
    for (const r of rows) {
      const m = r.username?.match(/^staff_(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `staff_${max + 1}`;
  }

  /** Load a managed user — must be in this tenant, not archived, not the owner. */
  private async requireManaged(tenantId: string, userId: string) {
    const user = await controlDb.user.findUnique({
      where: { id: userId },
      select: { id: true, tenantId: true, role: true, archivedAt: true },
    });
    if (!user || user.tenantId !== tenantId || user.archivedAt) {
      throw new NotFoundException('Staff member not found.');
    }
    if (user.role === 'owner') {
      throw new ForbiddenException('The library owner can’t be modified here.');
    }
    return user;
  }
}
