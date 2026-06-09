import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { PasswordService } from '../auth/password.service.js';
import type { StaffRole } from './staff.dto.js';

@Injectable()
export class StaffService {
  constructor(@Inject(PasswordService) private readonly passwords: PasswordService) {}

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
    const username = await this.nextUsername(tenantId);
    const tempPassword = String(randomInt(1000, 10000));
    const passwordHash = await this.passwords.hash(tempPassword);
    const user = await controlDb.user.create({
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
    return { user, tempPassword };
  }

  /** New 4-digit password + re-arm the forced first-login change. Returned once. */
  async resetPassword(tenantId: string, userId: string) {
    await this.requireManaged(tenantId, userId);
    const tempPassword = String(randomInt(1000, 10000));
    const passwordHash = await this.passwords.hash(tempPassword);
    await controlDb.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangeCredentials: true, failedLogins: 0, lockedUntil: null },
    });
    return { tempPassword };
  }

  async setRole(tenantId: string, userId: string, role: StaffRole) {
    await this.requireManaged(tenantId, userId);
    await controlDb.user.update({ where: { id: userId }, data: { role } });
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
      // archivedAt hides them from the staff list.
      data: { status: 'disabled', archivedAt: new Date() },
    });
  }

  // --- internals -----------------------------------------------------------

  /** Next free `staff_N` for the tenant (max existing suffix + 1). */
  private async nextUsername(tenantId: string): Promise<string> {
    const rows = await controlDb.user.findMany({
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
