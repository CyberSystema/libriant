import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EXPIRED_SECRET_TEXT,
  parseSecretPayload,
  sealBodySecrets,
  sealedRef,
  unsealBody,
} from './outbox-secrets.js';

/**
 * privacy-legal-06 regression suite.
 *
 * The defect these exist to catch: a password-reset / e-mail-verification link
 * was written into `email_outbox.bodyMarkdown` with its raw token in it, and
 * that column is dumped into every nightly backup and shipped by an ordinary
 * admin control export. The first test below is the one that would have failed
 * on the original code — it takes the ACTUAL body PasswordResetService composes
 * and asserts the token is not in what we persist.
 */

/** Token shape the auth services mint: `randomBytes(32).toString('base64url')`. */
function freshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Byte-for-byte the body shape of apps/api/src/auth/password-reset.service.ts. */
function passwordResetBody(token: string): string {
  return [
    `Hi Maria Papadopoulou,`,
    ``,
    `Someone (hopefully you) asked to reset your password for Δημοτική Βιβλιοθήκη.`,
    `Open this link to set a new one — it expires in 60 minutes:`,
    ``,
    `  https://app.libriant.com/el/login/reset?token=${token}&slug=demo-library`,
    ``,
    `If this wasn't you, ignore this email. Nothing changes until the link`,
    `is opened and a new password is set.`,
    ``,
    `— Libriant`,
  ].join('\n');
}

/** Body shape of apps/api/src/auth/email-verification.service.ts. */
function verifyBody(token: string): string {
  return [
    `Hi,`,
    ``,
    `Welcome to Δημοτική Βιβλιοθήκη! Confirm your email address to finish setting up.`,
    `Open this link to verify — it expires in 24 hours:`,
    ``,
    `  https://app.libriant.com/el/verify-email?token=${token}`,
    ``,
    `— Libriant`,
  ].join('\n');
}

describe('sealBodySecrets', () => {
  it('keeps a password-reset token out of the body we persist', () => {
    const token = freshToken();
    const sealed = sealBodySecrets(passwordResetBody(token));

    expect(sealed.storedBody).not.toContain(token);
    expect(sealed.ref).toBeTruthy();
    expect(Object.values(sealed.secrets)).toEqual([token]);
    // Everything that is NOT the credential still has to be there — the stored
    // body is what the operator reads in the admin outbox viewer.
    expect(sealed.storedBody).toContain('https://app.libriant.com/el/login/reset?token=');
    expect(sealed.storedBody).toContain('&slug=demo-library');
    expect(sealed.storedBody).toContain('Δημοτική Βιβλιοθήκη');
  });

  it('keeps an e-mail-verification token out of the body we persist', () => {
    const token = freshToken();
    const sealed = sealBodySecrets(verifyBody(token));
    expect(sealed.storedBody).not.toContain(token);
    expect(Object.values(sealed.secrets)).toEqual([token]);
  });

  it('leaves a body that carries no credential completely untouched', () => {
    const body = [
      `Your hold is ready at Δημοτική Βιβλιοθήκη.`,
      `Pick it up: https://app.libriant.com/el/t/demo-library/holds`,
    ].join('\n');
    const sealed = sealBodySecrets(body);
    expect(sealed.storedBody).toBe(body);
    expect(sealed.ref).toBeNull();
    expect(sealed.secrets).toEqual({});
    expect(sealedRef(sealed.storedBody)).toBeNull();
  });

  it('seals every credential-shaped parameter, not just `token`', () => {
    const sealed = sealBodySecrets(
      'a https://x/y?code=AAA b https://x/z?invite=BBB&slug=keep c https://x/w?SIGNATURE=CCC',
    );
    expect(sealed.storedBody).not.toContain('AAA');
    expect(sealed.storedBody).not.toContain('BBB');
    expect(sealed.storedBody).not.toContain('CCC');
    expect(sealed.storedBody).toContain('&slug=keep');
    expect(Object.values(sealed.secrets).sort()).toEqual(['AAA', 'BBB', 'CCC']);
  });

  it('gives the same value one slot so re-hydration cannot diverge', () => {
    const token = freshToken();
    const sealed = sealBodySecrets(
      `first ?token=${token} then again ?token=${token} in the footer`,
    );
    expect(Object.keys(sealed.secrets)).toHaveLength(1);
    expect(unsealBody(sealed.storedBody, sealed.secrets).body).toBe(
      `first ?token=${token} then again ?token=${token} in the footer`,
    );
  });

  it('does not smuggle a token past the seal by hiding it behind a comma or bracket', () => {
    const token = freshToken();
    const sealed = sealBodySecrets(`Open (https://x/y?token=${token}), then sign in.`);
    expect(sealed.storedBody).not.toContain(token);
    expect(sealed.storedBody).toContain('), then sign in.');
  });
});

describe('unsealBody', () => {
  it('restores the body byte-for-byte, so what we send is unchanged', () => {
    const token = freshToken();
    const original = passwordResetBody(token);
    const sealed = sealBodySecrets(original);
    const { body, missing } = unsealBody(sealed.storedBody, sealed.secrets);
    expect(body).toBe(original);
    expect(missing).toBe(0);
  });

  it('reports the loss and shows plain words when the sealed value has expired', () => {
    const sealed = sealBodySecrets(passwordResetBody(freshToken()));
    const { body, missing } = unsealBody(sealed.storedBody, null);
    expect(missing).toBe(1);
    expect(body).toContain(EXPIRED_SECRET_TEXT);
    // Never show the operator (or, worse, a recipient) internal placeholder syntax.
    expect(body).not.toContain('{{lbr-secret');
  });

  it('treats a partially-populated payload as expired for the missing slots only', () => {
    const sealed = sealBodySecrets('?token=AAA and ?code=BBB');
    const { body, missing } = unsealBody(sealed.storedBody, { '1': 'AAA' });
    expect(missing).toBe(1);
    expect(body).toContain('?token=AAA');
    expect(body).toContain(`?code=${EXPIRED_SECRET_TEXT}`);
  });
});

describe('parseSecretPayload', () => {
  it('round-trips what we write to Redis', () => {
    const sealed = sealBodySecrets(passwordResetBody(freshToken()));
    expect(parseSecretPayload(JSON.stringify(sealed.secrets))).toEqual(sealed.secrets);
  });

  it('degrades to null on junk instead of throwing inside the send path', () => {
    expect(parseSecretPayload(null)).toBeNull();
    expect(parseSecretPayload('not json')).toBeNull();
    expect(parseSecretPayload('[1,2,3]')).toBeNull();
    expect(parseSecretPayload('"a string"')).toBeNull();
  });
});
