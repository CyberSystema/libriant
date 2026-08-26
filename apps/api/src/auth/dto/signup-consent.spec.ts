import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { validateDto } from '../validate-dto.js';
import { SignupDto } from './signup.dto.js';

/**
 * Legal-consent gate on signup: the owner MUST affirmatively accept the Terms +
 * Privacy Policy (`acceptLegal === true`), and MUST say which language of them
 * was displayed. Anything else is rejected, so consent is mandatory and — the
 * part privacy-legal-09 was reopened over — attributable to a specific text.
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
  defaultLocale: 'el',
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

  /**
   * privacy-legal-09, second half of the refutation. `defaultLocale` was
   * optional and the acceptance record derived its locale from a helper that
   * fell back to 'el'. A signup that omitted it therefore produced a record
   * saying the owner had accepted the GREEK documents — which, for anyone who
   * had actually been shown the English ones, is a false evidentiary record
   * that nothing would ever flag. It is now required and closed to two values.
   */
  it('still accepts a signup that omits the locale, and does not silently claim one', async () => {
    // Kept permissive on purpose (see the DTO comment): nineteen integration
    // suites create libraries without it. What changed is downstream — the
    // acceptance record marks `localeAsserted: false` instead of asserting the
    // Greek documents were the ones read. Proven end-to-end in
    // test/integration/consent-evidence.spec.ts.
    const { defaultLocale: _omitted, ...withoutLocale } = base;
    const dto = await validateDto(SignupDto, { ...withoutLocale, acceptLegal: true });
    expect(dto.defaultLocale).toBeUndefined();
  });

  it('rejects a locale the legal corpus is not published in', async () => {
    // This is the DTO half of the refutation. `@IsString() @Length(2, 10)` let
    // 'fr' through, and the acceptance helper then turned it into 'el' — a
    // record asserting the owner had read the Greek Terms. Even if a third UI
    // language shipped, consent cannot be recorded in it until its Terms are
    // translated and frozen.
    await expect(
      validateDto(SignupDto, { ...base, defaultLocale: 'fr', acceptLegal: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps both published locales usable', async () => {
    for (const locale of ['el', 'en'] as const) {
      const dto = await validateDto(SignupDto, {
        ...base,
        defaultLocale: locale,
        acceptLegal: true,
      });
      expect(dto.defaultLocale).toBe(locale);
    }
  });
});
