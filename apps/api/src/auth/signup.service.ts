import { randomBytes } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { controlDb, Prisma } from '@libriant/db-control';
import { LEGAL_VERSION, type LibraryType } from '@libriant/shared';
import { legalAcceptanceAuditData } from './legal-acceptance.js';
import { ensureLegalArchive } from './consent.service.js';
import type { LegalLocale } from './consent-locales.js';
import { PasswordService } from './password.service.js';
import { JwtSessionService } from './jwt-session.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { TenantProvisioningService } from '../provisioning/tenant-provisioning.service.js';

export type SignupInput = {
  libraryName: string;
  slug: string;
  fullName: string;
  email: string;
  password: string;
  /**
   * The locale the signup form was rendered in — i.e. WHICH LANGUAGE of the
   * Terms + Privacy Policy the owner actually read. Narrowed to the published
   * legal locales by the DTO. When absent, the acceptance record says so
   * (`localeAsserted: false`) rather than inventing one.
   */
  defaultLocale?: LegalLocale;
  /** Source IP, recorded with the legal-consent acceptance (GDPR accountability). */
  ip?: string;
  // Library profile collected at signup (location + type required; rest optional).
  libraryType: LibraryType;
  addressStreet: string;
  addressCity: string;
  addressPostalCode: string;
  addressRegion?: string;
  addressCountry: string;
  publicPhone?: string;
  publicEmail?: string;
  website?: string;
  description?: string;
  foundedYear?: number;
};

export type SignupResult = {
  token: string;
  expiresAt: Date;
  /** New owners get a persistent ("remember me") session out of the gate. */
  remember: boolean;
  tenant: { id: string; slug: string; name: string; defaultLocale: string };
  user: { id: string; email: string | null; fullName: string; role: 'owner' };
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
    @Inject(EmailVerificationService) private readonly emailVerification: EmailVerificationService,
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

    // 4. Insert Tenant + first User + Subscription in a single TX. On
    //    failure we tear down the provisioned DB. Every fresh tenant is
    //    auto-subscribed to the Starter plan so EffectivePlanService has
    //    something concrete to resolve against from minute one. Real
    //    billing (upgrades, Stripe webhooks) lands in Step 16.
    const starterPlan = await controlDb.plan.findUnique({
      where: { slug: 'starter' },
      select: { id: true, billingMode: true },
    });
    if (!starterPlan) {
      await this.provisioner.teardown(tenantId).catch(() => undefined);
      throw new InternalServerErrorException(
        'No "starter" plan configured. Run the control-plane seed first.',
      );
    }
    // privacy-legal-09: put the EXACT TEXT of this version into
    // `legal_document_versions` BEFORE anything is stamped with the version.
    // The audit row below records digests; digests prove a document has not
    // changed but cannot produce it, and the markdown they point at lives in a
    // git tree that a running deployment does not have. Ordering matters: if
    // the archive cannot be written, the correct outcome is a failed signup,
    // not a library carrying a version stamp whose text nobody can ever show
    // it. Cached per version per process, so this is one query after the first
    // signup.
    await ensureLegalArchive();
    const passwordHash = await this.passwords.hash(input.password);
    // Record the legal acceptance (the DTO already enforced acceptLegal === true)
    // with the version the owner saw, on both the tenant + the owner user.
    const acceptedAt = new Date();
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
            legalAcceptedVersion: LEGAL_VERSION,
            legalAcceptedAt: acceptedAt,
            // Library profile (collected at signup).
            libraryType: input.libraryType,
            addressStreet: input.addressStreet,
            addressCity: input.addressCity,
            addressPostalCode: input.addressPostalCode,
            addressRegion: input.addressRegion ?? null,
            addressCountry: input.addressCountry,
            publicPhone: input.publicPhone ?? null,
            publicEmail: input.publicEmail ?? null,
            website: input.website ?? null,
            description: input.description ?? null,
            foundedYear: input.foundedYear ?? null,
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
            legalAcceptedVersion: LEGAL_VERSION,
            legalAcceptedAt: acceptedAt,
            legalAcceptedIp: input.ip ?? null,
          },
        });
        // privacy-legal-09: the three columns above say WHEN and under which
        // version stamp, and nothing at all about WHICH TEXT. This row does:
        // the locale, the person, and a SHA-256 per document against the frozen
        // copy under docs/legal/accepted/<version>/. It is written INSIDE this
        // transaction on purpose — a library must not be able to exist without
        // the evidence of what it agreed to, so the tenant row and the
        // acceptance record land together or neither does.
        await tx.auditEvent.create({
          data: legalAcceptanceAuditData({
            tenantId: tenant.id,
            actor: {
              userId: user.id,
              fullName: user.fullName,
              email: input.email,
              ip: input.ip,
            },
            acceptedAt,
            // Never inferred silently: when the caller did not say, the record
            // carries `localeAsserted: false` and stops short of claiming which
            // translation was on screen.
            presentedLocale: input.defaultLocale ?? 'el',
            localeAsserted: input.defaultLocale != null,
          }),
        });
        await tx.subscription.create({
          data: {
            tenantId: tenant.id,
            planId: starterPlan.id,
            billingMode: starterPlan.billingMode,
            status: 'active',
            // Starter is free — no Stripe period, no paid_until.
            // planSelectedAt stays NULL: the library hasn't *chosen* a plan,
            // it's just the placeholder. While subscriptions are disabled this
            // is invisible (everything's free); the moment the owner enables
            // subscriptions, a NULL here routes the library to the chooser.
            planSelectedAt: null,
          },
        });
        // Bootstrap an empty billing account so the billing flow has a row
        // to update later. The Stripe customer id is created lazily on the
        // first checkout/portal request — no point opening a Stripe handle
        // for a tenant who never upgrades past Starter.
        await tx.billingAccount.create({
          data: {
            tenantId: tenant.id,
            billingEmail: input.email,
            billingName: input.libraryName,
          },
        });
        return { tenant, user };
      });

      // Soft gate: the owner is signed in immediately, but we send a
      // verification email so they can confirm their address (the
      // EmailVerifiedGuard blocks sensitive actions until they do). Best-effort
      // — a Redis/mail hiccup must never fail the signup itself; they can
      // resend from the in-app banner.
      await this.emailVerification
        .send({
          userId: created.user.id,
          tenantId: created.tenant.id,
          email: input.email,
          slug: created.tenant.slug,
          locale: created.tenant.defaultLocale,
          libraryName: created.tenant.name,
          mode: 'signup',
        })
        .catch((err: unknown) =>
          this.logger.warn(
            `verification email enqueue failed for new owner ${created.user.id}: ${err instanceof Error ? err.message : err}`,
          ),
        );

      const { token, expiresAt, remember } = this.jwt.sign({
        sub: created.user.id,
        tid: created.tenant.id,
        role: 'owner',
        remember: true,
      });
      return {
        token,
        expiresAt,
        remember,
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
    // Lightweight cuid-shape id: 'c' + Date.now in base36 + a crypto-random
    // suffix. We use `crypto` (not Math.random) because this id becomes a
    // physical Postgres database name, so unguessability + collision-
    // resistance actually matter. Hex stays within `dbNameFor()`'s safe
    // identifier charset.
    const time = Date.now().toString(36);
    const rnd = randomBytes(9).toString('hex');
    return `c${time}${rnd}`;
  }
}
