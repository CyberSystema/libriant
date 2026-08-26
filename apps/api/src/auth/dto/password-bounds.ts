import { registerDecorator, type ValidationOptions } from 'class-validator';

/**
 * The ceiling on a password THIS PLATFORM CAN ACTUALLY KEEP, in UTF-8 bytes.
 *
 * Derived, not chosen: `PasswordService` hashes with bcryptjs, and bcrypt
 * ingests one 72-byte block and silently discards the rest. Measured against
 * the version we ship — `bcrypt.hash('a'.repeat(80))` verifies against
 * `'a'.repeat(72)` and against `'a'.repeat(73)`, because everything past byte
 * 72 was never part of the secret. A limit above this would only be pretending.
 *
 * BYTES, not characters, and that is the whole reason this is a custom
 * validator rather than `@MaxLength(72)`: class-validator counts UTF-16 code
 * units, and Greek is two bytes per letter in UTF-8. A 60-letter Greek
 * passphrase is 120 bytes — accepted by a 72-CHARACTER rule, then truncated by
 * bcrypt at letter 36, on a product sold to Greek public libraries.
 *
 * input-and-files-11: signup and password-reset had a floor and no ceiling at
 * all, while `LoginDto` bounded the same field at 200 characters. A librarian
 * who pasted a 300-character generated password at signup got a working
 * account and was then refused at login by the DTO — locked out of the library
 * they had just created, with no way back except guessing that only the first
 * 72 bytes had ever mattered.
 *
 * The LOGIN bound stays looser on purpose; see the comment on `LoginDto`.
 */
export const MAX_PASSWORD_BYTES = 72;

/** Bound a password-setting field at {@link MAX_PASSWORD_BYTES} UTF-8 bytes. */
export function MaxPasswordBytes(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'maxPasswordBytes',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message:
          'That password is too long. Please use at most 72 characters — Greek letters count as two.',
        ...options,
      },
      validator: {
        // Not a string is `@IsString`'s error to report, not this one's.
        validate: (value: unknown) =>
          typeof value !== 'string' || Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES,
      },
    });
  };
}
