import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { controlDb, Prisma } from '@libriant/db-control';
import { PasswordService } from './password.service.js';
import { JwtSessionService } from './jwt-session.service.js';
import { TenantProvisioningService } from '../provisioning/tenant-provisioning.service.js';

export type SignupInput = {
  libraryName: string;
  slug: string;
  fullName: string;
  email: string;
  password: string;
  /** Optional override for the library's default locale. */
  defaultLocale?: string;
};

export type SignupResult = {
  token: string;
  expiresAt: Date;
  tenant: { id: string; slug: string; name: string; defaultLocale: string };
  user: { id: string; email: string; fullName: string; role: 'owner' };
};

/**
 * Atomically (as best we can across two DBs) create a brand-new library:
 *   1. Reserve the slug — fail fast if taken.
 *   2. Allocate a control-plane Tenant id.
 *   3. Provision the tenant's physical DB + storage path (the only step
 *      that touches resources outside the control DB).
 *   4. INSERT the Tenant + User rows in a single control-plane transaction.
 *   5. Issue a session for the freshly-created owner.
 *
 * If step 4 fails AFTER step 3 succeeded, we tear down the provisioned DB
 * so we don't leak orphan resources.
 */
@Injectable()
export class SignupService {
  private readonly logger = new Logger(SignupService.name);

  constructor(
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(JwtSessionService) private readonly jwt: JwtSessionService,
    @Inject(TenantProvisioningService) private readonly provisioner: TenantProvisioningService,
  ) {}

  async signup(input: SignupInput): Promise<SignupResult> {
    // 1. Slug uniqueness check (fast pre-flight; DB constraint is the
    //    ultimate enforcer, but a clean message is nicer than a 500).
    const slugTaken = await controlDb.tenant.findUnique({
      where: { slug: input.slug },
      select: { id: true },
    });
    if (slugTaken) {
      throw new ConflictException(
        `The URL "${input.slug}" is already used by another library. Please pick another.`,
      );
    }

    // 2. Need a cell to place the tenant on. Day 1 always `cell-eu-1`.
    //    A future TenantPlacementService will pick "least loaded" once we
    //    have multiple cells; for now any accepting cell works.
    const cell = await controlDb.cell.findFirst({
      where: { acceptsNew: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!cell) {
      throw new InternalServerErrorException(
        'No cell available to host a new library. Please contact Libriant support.',
      );
    }

    // Pre-generate the tenant id so the provisioner can use it for the
    // physical DB name.
    const tenantId = this.newCuid();

    let placement;
    try {
      placement = await this.provisioner.provision({ tenantId, cellId: cell.id });
    } catch (err) {
      this.logger.error(
        `Provisioning failed for slug=${input.slug}: ${err instanceof Error ? err.message : err}`,
      );
      // Best-effort cleanup — the DB might be partially created.
      await this.provisioner.teardown(tenantId).catch(() => undefined);
      throw new InternalServerErrorException(
        "Sorry — we couldn't set up your library just now. Please try again in a minute.",
      );
    }

    // 4. Insert Tenant + first User in a single TX. On failure we tear
    //    down the provisioned DB.
    const passwordHash = await this.passwords.hash(input.password);
    try {
      const created = await controlDb.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            id: tenantId,
            slug: input.slug,
            name: input.libraryName,
            defaultLocale: input.defaultLocale ?? 'el',
            cellId: cell.id,
            dbUrl: placement.dbUrl,
            storageUrl: placement.storageUrl,
            primaryEmail: input.email,
            status: 'active',
          },
        });
        const user = await tx.user.create({
          data: {
            tenantId: tenant.id,
            email: input.email,
            fullName: input.fullName,
            role: 'owner',
            status: 'active',
            passwordHash,
          },
        });
        return { tenant, user };
      });

      const { token, expiresAt } = this.jwt.sign({
        sub: created.user.id,
        tid: created.tenant.id,
        role: 'owner',
      });
      return {
        token,
        expiresAt,
        tenant: {
          id: created.tenant.id,
          slug: created.tenant.slug,
          name: created.tenant.name,
          defaultLocale: created.tenant.defaultLocale,
        },
        user: {
          id: created.user.id,
          email: created.user.email,
          fullName: created.user.fullName,
          role: 'owner',
        },
      };
    } catch (err) {
      // Roll back the physical DB so we don't leak state.
      await this.provisioner.teardown(tenantId).catch(() => undefined);
      // Unique-violation can race past our pre-flight; report it cleanly.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A library with that URL or email is already registered.');
      }
      throw err;
    }
  }

  /**
   * Use the same generation strategy as the DB defaults so id strings
   * stay consistent across pre-allocated and Prisma-generated rows.
   * We re-implement cuid here because Prisma's cuid generator only fires
   * when the field is left empty in a create() call.
   */
  private newCuid(): string {
    // Lightweight cuid-shape generator: 'c' + Date.now in base36 + 8 random.
    const time = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
    return `c${time}${rnd}`;
  }
}
