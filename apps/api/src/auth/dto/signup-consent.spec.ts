import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { validateDto } from '../validate-dto.js';
import { SignupDto } from './signup.dto.js';

/**
 * Legal-consent gate on signup: the owner MUST affirmatively accept the Terms +
 * Privacy Policy (`acceptLegal === true`). Anything else is rejected, so consent
 * is mandatory and recordable (see SignupService + LEGAL_VERSION).
 */
const base = {
  libraryName: 'Test Library',
  slug: 'test-library',
  fullName: 'Ada Lovelace',
  email: 'owner@test.example',
  password: 'a-very-long-password',
  // Library profile (required at signup).
  libraryType: 'public',
  addressStreet: '1 Library St',
  addressCity: 'Athens',
  addressPostalCode: '10000',
  addressCountry: 'GR',
};

describe('SignupDto — legal consent (acceptLegal)', () => {
  it('accepts when acceptLegal is true', async () => {
    const dto = await validateDto(SignupDto, { ...base, acceptLegal: true });
    expect(dto.acceptLegal).toBe(true);
  });

  it('rejects when acceptLegal is missing', async () => {
    await expect(validateDto(SignupDto, base)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when acceptLegal is false', async () => {
    await expect(validateDto(SignupDto, { ...base, acceptLegal: false })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
