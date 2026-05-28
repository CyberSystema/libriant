/**
 * Bootstrap (or update) a Libriant admin user.
 *
 *   ENV:
 *     CONTROL_DATABASE_URL  (required)
 *     ADMIN_BOOTSTRAP_EMAIL (required, e.g. owner@libriant.app)
 *     ADMIN_BOOTSTRAP_PASSWORD (required, plaintext — hashed by bcrypt before insert)
 *     ADMIN_BOOTSTRAP_NAME  (optional, defaults to "Libriant Owner")
 *     ADMIN_BOOTSTRAP_ROLE  (optional, "owner" | "support"; defaults to "owner")
 *
 *   USAGE:  pnpm admin:bootstrap
 *
 * Idempotent: if the email already exists we update the password + role +
 * unlock the account. MFA secrets are NOT touched here — the account is
 * usable for sign-in but cannot redeem support keys until MFA is enabled
 * through a future enrollment flow.
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { controlDb } from '@libriant/db-control';

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim().length) {
    // eslint-disable-next-line no-console
    console.error(`Missing required env var ${name}.`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const email = required('ADMIN_BOOTSTRAP_EMAIL').toLowerCase().trim();
  const password = required('ADMIN_BOOTSTRAP_PASSWORD');
  const fullName = process.env.ADMIN_BOOTSTRAP_NAME?.trim() || 'Libriant Owner';
  const role = (process.env.ADMIN_BOOTSTRAP_ROLE?.trim() || 'owner') as 'owner' | 'support';
  if (role !== 'owner' && role !== 'support') {
    // eslint-disable-next-line no-console
    console.error(`ADMIN_BOOTSTRAP_ROLE must be "owner" or "support". Got "${role}".`);
    process.exit(1);
  }
  if (password.length < 12) {
    // eslint-disable-next-line no-console
    console.error('ADMIN_BOOTSTRAP_PASSWORD must be at least 12 characters.');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  // MFA secret storage is encrypted in real life; for bootstrap we stash
  // random bytes so the not-null columns are satisfied. Real MFA setup
  // happens through a separate enrollment endpoint (out of MVP scope —
  // covered when the support-session flow lands in Step 18a).
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
      },
    });
    // eslint-disable-next-line no-console
    console.log(`Updated admin ${email} (role=${role}).`);
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
    // eslint-disable-next-line no-console
    console.log(`Created admin ${email} (role=${role}).`);
  }

  await controlDb.$disconnect();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed:', err);
  await controlDb.$disconnect();
  process.exit(1);
});
