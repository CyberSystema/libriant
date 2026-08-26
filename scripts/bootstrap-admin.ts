/**
 * Bootstrap (or update) a Libriant admin user — and, when the authenticator is
 * gone, get its owner back into the control plane.
 *
 *   ENV (create / update — the deploy path, unchanged):
 *     CONTROL_DATABASE_URL  (required)
 *     ADMIN_BOOTSTRAP_EMAIL (required, e.g. owner@libriant.com)
 *     ADMIN_BOOTSTRAP_PASSWORD (required, plaintext — hashed by bcrypt before insert)
 *     ADMIN_BOOTSTRAP_NAME  (optional, defaults to "Libriant Owner")
 *     ADMIN_BOOTSTRAP_ROLE  (optional, "owner" | "support"; defaults to "owner")
 *
 *   ENV (recovery — one-shot, launch-readiness-13; see below):
 *     ADMIN_BOOTSTRAP_RESET_MFA=<that admin's own email>
 *     ADMIN_BOOTSTRAP_ISSUE_RECOVERY_CODES=<that admin's own email>
 *
 *   USAGE:  pnpm admin:bootstrap
 *
 * Idempotent: if the email already exists we update the password + role +
 * unlock the account. The second factor is NEVER touched by the create/update
 * path — a routine deploy must not silently disarm MFA.
 *
 * ## The lockout this script now has an answer for (launch-readiness-13)
 *
 * `ADMIN_MFA_REQUIRED` defaults to `!isDev`, so in production `AdminAuthGuard`
 * pushes the bootstrapped admin into TOTP enrollment before anything else and
 * `admin-auth.controller.ts` refuses a correct password without a code. There
 * is one admin, `/admin/mfa/*` all require a live admin session, and the seed
 * is encrypted under `MFA_MASTER_KEY`, which lives in one password manager and
 * by design in no backup. One lost or wiped phone therefore locked the sole
 * operator out of admin.libriant.com — where edit-requests are approved, plans
 * are set, billing is flipped and support access is granted.
 *
 * Recovery codes exist now and `POST /admin/auth/login` accepts one in place of
 * the TOTP. They are issued at enrollment and re-issuable at
 * `POST /admin/mfa/recovery-codes` — but BOTH of those require a working second
 * factor, so neither is reachable by the person this is about: someone whose
 * phone is ALREADY gone. `EMAIL_DRIVER` is `console`, so it cannot be an
 * emailed code either. That leaves the operator on the box, which is here.
 *
 * Two modes, both refusing unless their value is the admin's own email address
 * (a value nobody sets by reflex), and both deliberately leaving the password
 * alone so recovering a second factor never becomes a surprise credential
 * rotation:
 *
 *   ADMIN_BOOTSTRAP_RESET_MFA — un-enroll. Clears `mfaEnabled`, overwrites the
 *     stored ciphertext with fresh random bytes, drops the recovery codes and
 *     bumps `sessionsValidAfter`. The admin then signs in with the password
 *     alone and the guard walks them straight back into enrollment.
 *     **This decrypts nothing, so it works with MFA_MASTER_KEY lost or
 *     rotated** — which matters, because that key is the one secret §4.4 of the
 *     runbook classifies as never rotatable and holds in exactly one place.
 *
 *   ADMIN_BOOTSTRAP_ISSUE_RECOVERY_CODES — mint ten single-use codes and print
 *     them. For the admin who still HAS their authenticator but was enrolled
 *     before recovery codes existed (or through a UI that did not show them),
 *     so the next lost phone needs no SSH at all. Run it BEFORE you need it.
 *
 * Neither belongs in `.env.prod`: `prod-bootstrap.sh` runs this script on every
 * deploy, so a variable left in that file re-fires forever. Pass them with
 * `docker compose run -e`; docs/RUNBOOK.md §4.5a has the exact command.
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { controlDb } from '@libriant/db-control';

// eslint-disable-next-line no-console
const say = console.log;
// eslint-disable-next-line no-console
const warn = console.error;

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim().length) {
    warn(`Missing required env var ${name}.`);
    process.exit(1);
  }
  return v;
}

/**
 * Read a recovery-mode switch. It must carry the admin's own email as its
 * value — not `1`, not `true`. Nobody types an address by accident, and a
 * mismatched one is the shape of a copy-pasted command aimed at the wrong
 * account, which for `RESET_MFA` would disarm the wrong admin's second factor.
 */
function recoveryMode(name: string, email: string): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) return false;
  if (raw.toLowerCase() !== email) {
    warn(
      `${name} is set to "${raw}", but it must be the admin's own email address ` +
        `("${email}") to confirm which account you mean. Refusing.`,
    );
    process.exit(1);
  }
  return true;
}

/** One control-plane audit row. Best-effort: never fail the operation over it. */
async function audit(adminId: string, action: string, after: Record<string, unknown>) {
  await controlDb.auditEvent
    .create({
      data: {
        actorType: 'admin',
        actorId: adminId,
        action,
        targetType: 'admin_user',
        targetId: adminId,
        afterJson: after,
        userAgent: 'scripts/bootstrap-admin.ts',
      },
    })
    .catch((err: unknown) => warn(`(audit row not written: ${(err as Error).message})`));
}

/**
 * The finding is three things, and "no second admin" is one of them: the
 * server handbook already tells you to keep two SSH keys authorized, and the
 * same reasoning was never applied to the surface you use to respond to an
 * incident. Nothing here can create the second admin for you, but nothing was
 * telling you that you only had one either.
 */
async function reportRoster() {
  const admins = await controlDb.adminUser.findMany({
    where: { status: 'active', disabledAt: null },
    select: { email: true, role: true, mfaEnabled: true },
    orderBy: { email: 'asc' },
  });
  say(`\nActive admins (${admins.length}):`);
  for (const a of admins) {
    say(`  ${a.email}  role=${a.role}  mfa=${a.mfaEnabled ? 'enrolled' : 'NOT enrolled'}`);
  }
  const owners = admins.filter((a) => a.role === 'owner');
  if (owners.length < 2) {
    warn(
      `\n  WARNING: ${owners.length} active owner admin(s). One lost device, one forgotten\n` +
        '  password or one disabled account is then a total loss of the control plane.\n' +
        '  Create a second owner on a SEPARATE device and enrol its authenticator:\n' +
        '    ADMIN_BOOTSTRAP_EMAIL=<second@…> ADMIN_BOOTSTRAP_PASSWORD=<…> \\\n' +
        '      ADMIN_BOOTSTRAP_ROLE=owner pnpm admin:bootstrap\n' +
        '  Store both TOTP seeds and both recovery-code sets next to MFA_MASTER_KEY.\n' +
        '  docs/RUNBOOK.md §4.5a.',
    );
  }
}

/** Un-enroll the second factor. Decrypts nothing — see the file docblock. */
async function resetMfa(admin: { id: string; email: string; mfaEnabled: boolean }) {
  if (!admin.mfaEnabled) {
    say(`${admin.email} has no authenticator enrolled — nothing to reset.`);
    say('Sign in with the password; the guard will ask you to enrol.');
    return;
  }
  await controlDb.adminUser.update({
    where: { id: admin.id },
    data: {
      mfaEnabled: false,
      // Overwritten rather than nulled: these columns are NOT NULL on
      // AdminUser (see the create branch below, which stuffs the same shape).
      // Random bytes are also the right value semantically — the old
      // ciphertext must not linger where a later bug could re-enable it.
      mfaSecretCipher: randomBytes(32),
      mfaNonce: randomBytes(12),
      mfaKeyId: 'reset',
      // Every admin cookie for this account was minted while a second factor
      // was in force. AdminAuthGuard reads this column on every request, so
      // this is what stops a session that predates the reset — including one
      // live on the handset we are recovering from.
      //
      // Rounded UP to the next whole second, not `new Date()`. A JWT `iat` has
      // one-second resolution and the guard compares
      // `iat < floor(sessionsValidAfter / 1000)`, so a bare `new Date()` leaves
      // every cookie minted during the SAME second alive — measured, as a test
      // that expected 401 and got 200. Rounding up makes the kill total for
      // everything issued up to this instant. The cost is that a sign-in
      // completing inside that same second is refused once and works on retry,
      // which for a procedure a human runs from a shell is not a cost at all.
      sessionsValidAfter: new Date((Math.floor(Date.now() / 1000) + 1) * 1000),
      // Unlock too: an admin who has been guessing at a code they no longer
      // have may well have tripped ADM-5 on the way here, and a reset that
      // leaves them locked out for another 15 minutes helps nobody.
      failedAttempts: 0,
      lockedUntil: null,
    },
  });
  // Codes printed against the factor we just removed must not survive it —
  // otherwise a set on an old printout stays a live bypass past the reset.
  // Re-enrolling issues a new ten.
  await controlDb.platformSetting
    .delete({ where: { key: `admin.mfa.recovery:${admin.id}` } })
    .catch(() => undefined);
  await audit(admin.id, 'admin.mfa.reset_by_operator', { mfaEnabled: false, via: 'bootstrap' });

  say(`Reset the second factor for ${admin.email}. The password is UNCHANGED.`);
  say('');
  say('Next, from a browser on admin.<your apex>:');
  say('  1. sign in with the email + password (no code will be asked for);');
  say('  2. the console will refuse everything until you enrol — do that now;');
  say('  3. store the new TOTP seed AND the recovery codes in the password manager.');
  say('');
  say('Every other admin session for this account has been signed out.');
}

/**
 * Mint recovery codes for an admin who still has a working authenticator.
 *
 * Dynamically imported so that this module — which `prod-bootstrap.sh` runs on
 * EVERY deploy — cannot fail to load because of anything under apps/api. The
 * API image carries its own source and node_modules and mounts scripts/ next to
 * them, so the import resolves there; if it ever does not, only this opt-in
 * branch breaks, and it breaks with a message instead of a red deploy.
 */
async function issueRecoveryCodes(admin: { id: string; email: string; mfaEnabled: boolean }) {
  if (!admin.mfaEnabled) {
    warn(
      `${admin.email} has no authenticator enrolled, so a recovery code would never be ` +
        'accepted at sign-in (the login only consults them when MFA is on). Enrol first.',
    );
    process.exit(1);
  }
  const { MfaRecoveryService } = await import('../apps/api/src/support/mfa-recovery.service.js');
  // No constructor arguments: usable outside Nest's container, which is the
  // whole reason the codes can be minted from a shell on the box. Reusing the
  // service rather than re-implementing the format is deliberate — a private
  // copy of the digest scheme here would drift and the codes would stop
  // verifying, silently, at exactly the wrong moment.
  const codes = await new MfaRecoveryService().issue(admin.id);
  await audit(admin.id, 'admin.mfa.recovery_codes_reissued', {
    recoveryCodesIssued: codes.length,
    via: 'bootstrap',
  });

  say(`\nRecovery codes for ${admin.email} — shown ONCE, nothing can recover them after:\n`);
  for (const c of codes) say(`    ${c}`);
  say('');
  say('Each is single-use. At the admin sign-in, send one as `recoveryCode` instead');
  say('of the 6-digit `totp`. Any set issued earlier has just been invalidated.');
  say('Put them in the password manager next to MFA_MASTER_KEY, then clear this');
  say('terminal — they are as good as the second factor until used.');
}

async function main() {
  const email = required('ADMIN_BOOTSTRAP_EMAIL').toLowerCase().trim();

  // ---- recovery modes (launch-readiness-13) -------------------------------
  const wantsReset = recoveryMode('ADMIN_BOOTSTRAP_RESET_MFA', email);
  const wantsCodes = recoveryMode('ADMIN_BOOTSTRAP_ISSUE_RECOVERY_CODES', email);
  if (wantsReset || wantsCodes) {
    if (wantsReset && wantsCodes) {
      warn(
        'ADMIN_BOOTSTRAP_RESET_MFA and ADMIN_BOOTSTRAP_ISSUE_RECOVERY_CODES together do not ' +
          'mean anything: a reset removes the second factor the codes would bypass. Pick one.',
      );
      process.exit(1);
    }
    const admin = await controlDb.adminUser.findUnique({
      where: { email },
      select: { id: true, email: true, mfaEnabled: true, status: true, disabledAt: true },
    });
    if (!admin) {
      warn(`No admin with email ${email}. Nothing to recover.`);
      process.exit(1);
    }
    if (admin.disabledAt || admin.status !== 'active') {
      warn(
        `Admin ${email} is not active (status=${admin.status}). Recovering the second factor ` +
          'would not let them in; re-enable the account first.',
      );
      process.exit(1);
    }
    if (wantsReset) await resetMfa(admin);
    else await issueRecoveryCodes(admin);

    await reportRoster();
    warn(
      '\n  Remove the recovery variable from wherever you set it. prod-bootstrap.sh runs\n' +
        '  this script on EVERY deploy, so one left in .env.prod re-fires forever.',
    );
    await controlDb.$disconnect();
    return;
  }

  // ---- create / update (unchanged) ----------------------------------------
  const password = required('ADMIN_BOOTSTRAP_PASSWORD');
  const fullName = process.env.ADMIN_BOOTSTRAP_NAME?.trim() || 'Libriant Owner';
  const role = (process.env.ADMIN_BOOTSTRAP_ROLE?.trim() || 'owner') as 'owner' | 'support';
  if (role !== 'owner' && role !== 'support') {
    warn(`ADMIN_BOOTSTRAP_ROLE must be "owner" or "support". Got "${role}".`);
    process.exit(1);
  }
  if (password.length < 12) {
    warn('ADMIN_BOOTSTRAP_PASSWORD must be at least 12 characters.');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  // MFA secret storage is encrypted in real life; for bootstrap we stash
  // random bytes so the not-null columns are satisfied. Real MFA setup
  // happens at POST /admin/mfa/setup + /verify.
  const dummyCipher = randomBytes(32);
  const dummyNonce = randomBytes(12);

  const existing = await controlDb.adminUser.findUnique({ where: { email } });
  if (existing) {
    await controlDb.adminUser.update({
      where: { id: existing.id },
      data: {
        fullName,
        role,
        passwordHash,
        failedAttempts: 0,
        lockedUntil: null,
        status: 'active',
        disabledAt: null,
        // NOT `mfaEnabled` and NOT the secret: this runs on every deploy, and
        // disarming the second factor as a side effect of a routine deploy
        // would be a far worse defect than the lockout it would be relieving.
        // Un-enrolling is ADMIN_BOOTSTRAP_RESET_MFA, deliberately and once.
      },
    });
    say(`Updated admin ${email} (role=${role}).`);
  } else {
    await controlDb.adminUser.create({
      data: {
        email,
        fullName,
        role,
        passwordHash,
        mfaSecretCipher: dummyCipher,
        mfaNonce: dummyNonce,
        mfaKeyId: 'bootstrap',
        mfaEnabled: false,
      },
    });
    say(`Created admin ${email} (role=${role}).`);
  }

  await reportRoster();
  await controlDb.$disconnect();
}

main().catch(async (err) => {
  warn('Bootstrap failed:', err);
  await controlDb.$disconnect();
  process.exit(1);
});
