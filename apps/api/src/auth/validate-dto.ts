import { BadRequestException } from '@nestjs/common';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validate } from 'class-validator';

/**
 * Validate a raw request body against a DTO class WITHOUT relying on
 * `design:paramtypes` decorator metadata.
 *
 * NestJS's built-in @Body(SignupDto) flow needs that metadata, which
 * `tsx` (esbuild-based transpiler we use for dev) doesn't emit. Calling
 * this helper from controllers keeps validation working consistently
 * across dev and prod regardless of whether the transpiler emits
 * decorator metadata.
 *
 * Throws BadRequestException with class-validator's flattened messages on
 * the first validation failure.
 */
export async function validateDto<T extends object>(
  cls: ClassConstructor<T>,
  raw: unknown,
): Promise<T> {
  if (raw === null || typeof raw !== 'object') {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  const instance = plainToInstance(cls, raw, { enableImplicitConversion: false });
  const errors = await validate(instance as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    validationError: { target: false, value: false },
  });
  if (errors.length) {
    // Flatten into a single human-readable list. Take the first constraint
    // message per field — the rest are usually echoes.
    const messages: string[] = [];
    for (const err of errors) {
      if (err.constraints) {
        const first = Object.values(err.constraints)[0];
        if (first) messages.push(first);
      }
    }
    throw new BadRequestException(messages.length ? messages : 'Invalid input.');
  }
  return instance;
}
