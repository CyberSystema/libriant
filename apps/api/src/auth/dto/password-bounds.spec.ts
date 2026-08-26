import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { validateDto } from '../validate-dto.js';
import { CompleteSetupDto, LoginDto } from './login.dto.js';
import { PasswordResetCompleteDto } from './password-reset.dto.js';
import { MAX_PASSWORD_BYTES } from './password-bounds.js';

/**
 * input-and-files-11. Three paths SET a password — signup, reset, and the
 * forced first-login change — and all three now stop where bcrypt stops.
 * `SignupDto` is covered end-to-end over HTTP in
 * test/integration/auth-password-bounds.spec.ts; this file covers the other two
 * and the byte/character distinction that a `@MaxLength` cannot express.
 */
async function messagesFrom(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '';
  } catch (err) {
    const body = (err as BadRequestException).getResponse() as { message?: unknown };
    return JSON.stringify(body.message);
  }
}

describe('the password ceiling is bcrypt’s, not a guess', () => {
  it('is the number of bytes bcrypt actually reads', async () => {
    // Not an assertion about a constant we chose — an assertion about the
    // library we ship. Everything past MAX_PASSWORD_BYTES is discarded, so a
    // hash of a longer string verifies against the truncation.
    const hash = await bcrypt.hash('x'.repeat(MAX_PASSWORD_BYTES + 8), 4);
    expect(await bcrypt.compare('x'.repeat(MAX_PASSWORD_BYTES), hash)).toBe(true);
    expect(await bcrypt.compare('x'.repeat(MAX_PASSWORD_BYTES - 1), hash)).toBe(false);
  });
});

describe('PasswordResetCompleteDto.newPassword', () => {
  it('accepts a password that fits', async () => {
    const dto = await validateDto(PasswordResetCompleteDto, {
      token: 't',
      newPassword: 'x'.repeat(MAX_PASSWORD_BYTES),
    });
    expect(dto.newPassword).toHaveLength(MAX_PASSWORD_BYTES);
  });

  it('refuses one byte more', async () => {
    const msg = await messagesFrom(
      validateDto(PasswordResetCompleteDto, {
        token: 't',
        newPassword: 'x'.repeat(MAX_PASSWORD_BYTES + 1),
      }),
    );
    expect(msg).toContain('at most 72 characters');
  });
});

describe('CompleteSetupDto.newPassword — the forced first-login change', () => {
  it('refuses a 300-character password instead of storing 72 bytes of it', async () => {
    const msg = await messagesFrom(validateDto(CompleteSetupDto, { newPassword: 'x'.repeat(300) }));
    expect(msg).toContain('at most 72 characters');
  });

  it('still enforces the 12-character floor', async () => {
    const msg = await messagesFrom(validateDto(CompleteSetupDto, { newPassword: 'short' }));
    expect(msg).toContain('at least 12 characters');
  });
});

describe('the bound is in UTF-8 bytes, which is what Greek makes different', () => {
  // 40 Greek letters: 40 characters, 80 bytes. `@MaxLength(72)` — the obvious
  // fix — would accept this and let bcrypt keep the first 36 letters.
  const greek = 'κωδικόςπρόσβασηςβιβλιοθήκηςκαλαμάταςαβγδ';

  it('refuses 40 Greek letters', async () => {
    expect(greek).toHaveLength(40);
    expect(Buffer.byteLength(greek, 'utf8')).toBe(80);
    const msg = await messagesFrom(
      validateDto(PasswordResetCompleteDto, { token: 't', newPassword: greek }),
    );
    expect(msg).toContain('at most 72 characters');
  });

  it('accepts 30 Greek letters, which fit', async () => {
    const shorter = greek.slice(0, 30);
    expect(Buffer.byteLength(shorter, 'utf8')).toBeLessThanOrEqual(MAX_PASSWORD_BYTES);
    await expect(
      validateDto(PasswordResetCompleteDto, { token: 't', newPassword: shorter }),
    ).resolves.toBeInstanceOf(PasswordResetCompleteDto);
  });
});

describe('LoginDto.password stays looser on purpose', () => {
  it('accepts a password longer than the set paths allow', async () => {
    // Someone whose password predates the ceiling must still be able to type it
    // in full. Tightening this to 72 is the lockout the finding described.
    const dto = await validateDto(LoginDto, {
      slug: 'acme',
      identifier: 'owner@acme.test',
      password: 'x'.repeat(150),
    });
    expect(dto.password).toHaveLength(150);
  });
});
