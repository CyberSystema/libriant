import { BadRequestException } from '@nestjs/common';
import { type FieldDef, type FieldError, validateField } from './field-types.js';

export type ValidationOutcome =
  | { ok: true; cleaned: Record<string, unknown> }
  | { ok: false; errors: FieldError[] };

export type ValidatorOptions = {
  /** How to react when the payload includes a key that isn't defined. */
  unknownFields?: 'reject' | 'strip';
  /**
   * Skip required-field checks. Useful for PATCH endpoints — clients send
   * partial updates and we shouldn't fail because they didn't repeat
   * already-set required values.
   */
  partial?: boolean;
};

/**
 * Apply a set of field definitions to a record. Used in two places:
 *   - `customFields` on built-in entities (book, member, …)
 *   - `data` on `collection_records`
 *
 * The same code paths handle both. The caller supplies the relevant
 * definitions and the raw user payload; we return a `cleaned` object
 * that's safe to persist into JSONB (or a structured error response).
 *
 * Strict by default: unknown fields are rejected so the user gets a clear
 * "you spelled this wrong / this field was archived" message rather than
 * silently dropping data.
 */
export function validateRecord(
  defs: FieldDef[],
  raw: unknown,
  opts: ValidatorOptions = {},
): ValidationOutcome {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [{ field: '(body)', message: 'Expected a JSON object.' }] };
  }
  const data = raw as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  const errors: FieldError[] = [];

  // Validate every defined field.
  const known = new Set<string>();
  for (const def of defs) {
    known.add(def.fieldKey);
    // For PATCH (partial), skip when the user didn't supply this field.
    const provided = Object.prototype.hasOwnProperty.call(data, def.fieldKey);
    if (opts.partial && !provided) continue;
    const r = validateField(
      // PATCH semantics: a partial update over a required field is still
      // OK if the client provides a value; we only relax the "you must
      // include this" requirement.
      opts.partial ? { ...def, required: false } : def,
      data[def.fieldKey],
    );
    if (r.ok) {
      // null cleaned values are kept for partial updates so the persisted
      // JSONB can clear a value explicitly.
      cleaned[def.fieldKey] = r.cleaned;
    } else {
      errors.push(r.error);
    }
  }

  // Handle unknown keys.
  if ((opts.unknownFields ?? 'reject') === 'reject') {
    for (const key of Object.keys(data)) {
      if (!known.has(key)) {
        errors.push({
          field: key,
          message: "This field is not part of the library's data model.",
        });
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, cleaned };
}

/**
 * Sugar that throws a 400 BadRequestException directly instead of forcing
 * the caller to branch on `result.ok`. Most controllers want the throw.
 */
export function validateRecordOrThrow(
  defs: FieldDef[],
  raw: unknown,
  opts: ValidatorOptions = {},
): Record<string, unknown> {
  const r = validateRecord(defs, raw, opts);
  if (!r.ok) {
    throw new BadRequestException({
      statusCode: 400,
      message: 'Some fields are invalid.',
      errors: r.errors,
    });
  }
  return r.cleaned;
}
