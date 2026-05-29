import type { FieldType } from '@libriant/db-tenant';

/**
 * Field-type validation primitives.
 *
 * One library can define an unbounded set of custom fields on its built-in
 * entities (book/member/loan/…) and on its custom collections (DVDs, Events).
 * Each field declares a `FieldType` and, optionally, type-specific options
 * (allowed values for selects, min/max for numbers, pattern for text, …).
 *
 * Everything in here is pure: no DB access, no I/O. The caller assembles
 * field definitions from the DB and feeds them in.
 */

export const FIELD_TYPES: readonly FieldType[] = [
  'short_text',
  'long_text',
  'number',
  'boolean',
  'date',
  'datetime',
  'select_one',
  'select_many',
  'url',
  'email',
];

/** Default ceiling on string length, by type. */
const DEFAULT_MAX_LENGTH: Partial<Record<FieldType, number>> = {
  short_text: 255,
  long_text: 10_000,
};

/**
 * Shape of `optionsJson` on a select_one / select_many field.
 * `labelJson` is the same i18n bag used elsewhere.
 */
export type SelectOption = {
  value: string;
  /** `{ en: "...", el: "..." }`. Only used by the UI; not validated. */
  label?: Record<string, string>;
};

export type FieldOptions = {
  options?: SelectOption[];
};

export type FieldValidation = {
  /** Numbers. */
  min?: number;
  max?: number;
  /** Text. */
  minLength?: number;
  maxLength?: number;
  /** Text (POSIX regex string). */
  pattern?: string;
};

/**
 * Just what the validator needs from a FieldDefinition or CollectionField
 * row. Lets us reuse the same code for both layers.
 */
export type FieldDef = {
  fieldKey: string;
  type: FieldType;
  required: boolean;
  optionsJson: FieldOptions | null;
  validationJson: FieldValidation | null;
};

export type FieldError = { field: string; message: string };

export type FieldCheck = { ok: true; cleaned: unknown } | { ok: false; error: FieldError };

/**
 * Validate ONE field value against ONE definition. Returns a typed result
 * that includes a `cleaned` value when valid — the caller writes the
 * cleaned value into the entity's `customFields` JSONB.
 *
 * Type changes are deliberately NOT permitted at the DB layer — a missing
 * `data[def.fieldKey]` (null/undefined/empty string) on a required field
 * fails fast; on an optional field it's stored as null.
 */
export function validateField(def: FieldDef, raw: unknown): FieldCheck {
  // Empty cases first.
  const isEmpty =
    raw === undefined ||
    raw === null ||
    (typeof raw === 'string' && raw.length === 0) ||
    (Array.isArray(raw) && raw.length === 0);
  if (isEmpty) {
    if (def.required) {
      return err(def.fieldKey, 'This field is required.');
    }
    return { ok: true, cleaned: null };
  }

  switch (def.type) {
    case 'short_text':
    case 'long_text': {
      if (typeof raw !== 'string') return err(def.fieldKey, 'Must be text.');
      const max = def.validationJson?.maxLength ?? DEFAULT_MAX_LENGTH[def.type] ?? 1000;
      const min = def.validationJson?.minLength ?? 0;
      if (raw.length < min) return err(def.fieldKey, `Must be at least ${min} characters.`);
      if (raw.length > max) return err(def.fieldKey, `Must be at most ${max} characters.`);
      if (def.validationJson?.pattern) {
        try {
          const re = new RegExp(def.validationJson.pattern);
          if (!re.test(raw)) return err(def.fieldKey, `Doesn't match the expected pattern.`);
        } catch {
          return err(
            def.fieldKey,
            `Field's validation pattern is invalid; ask an admin to fix it.`,
          );
        }
      }
      return { ok: true, cleaned: raw };
    }

    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return err(def.fieldKey, 'Must be a number.');
      }
      if (def.validationJson?.min !== undefined && raw < def.validationJson.min) {
        return err(def.fieldKey, `Must be at least ${def.validationJson.min}.`);
      }
      if (def.validationJson?.max !== undefined && raw > def.validationJson.max) {
        return err(def.fieldKey, `Must be at most ${def.validationJson.max}.`);
      }
      return { ok: true, cleaned: raw };
    }

    case 'boolean': {
      if (typeof raw !== 'boolean') return err(def.fieldKey, 'Must be true or false.');
      return { ok: true, cleaned: raw };
    }

    case 'date': {
      // Strict ISO `YYYY-MM-DD`. We store the canonical string; consumers
      // can parse with `new Date(value + 'T00:00:00Z')` if they need a Date.
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return err(def.fieldKey, 'Use a date in YYYY-MM-DD format.');
      }
      const d = new Date(`${raw}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) return err(def.fieldKey, 'Not a real date.');
      // Round-trip protection: the parsed back string must equal input.
      if (d.toISOString().slice(0, 10) !== raw) return err(def.fieldKey, 'Not a real date.');
      return { ok: true, cleaned: raw };
    }

    case 'datetime': {
      if (typeof raw !== 'string') return err(def.fieldKey, 'Use an ISO datetime.');
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return err(def.fieldKey, 'Not a real date/time.');
      // Normalize to canonical ISO.
      return { ok: true, cleaned: d.toISOString() };
    }

    case 'select_one': {
      if (typeof raw !== 'string') return err(def.fieldKey, 'Pick one option.');
      const options = def.optionsJson?.options ?? [];
      if (!options.some((o) => o.value === raw)) {
        return err(def.fieldKey, `Pick one of: ${options.map((o) => o.value).join(', ')}.`);
      }
      return { ok: true, cleaned: raw };
    }

    case 'select_many': {
      if (!Array.isArray(raw)) return err(def.fieldKey, 'Pick one or more options.');
      const options = def.optionsJson?.options ?? [];
      const valid = new Set(options.map((o) => o.value));
      const bad: string[] = [];
      const cleaned: string[] = [];
      for (const v of raw) {
        if (typeof v !== 'string' || !valid.has(v)) bad.push(String(v));
        else if (!cleaned.includes(v)) cleaned.push(v); // dedupe
      }
      if (bad.length) {
        return err(def.fieldKey, `Unknown options: ${bad.join(', ')}.`);
      }
      return { ok: true, cleaned };
    }

    case 'url': {
      if (typeof raw !== 'string') return err(def.fieldKey, 'Must be a link.');
      try {
        new URL(raw);
      } catch {
        return err(def.fieldKey, "This link doesn't look right.");
      }
      return { ok: true, cleaned: raw };
    }

    case 'email': {
      // Plain pattern, matches what the auth DTOs use.
      if (typeof raw !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) {
        return err(def.fieldKey, "This email doesn't look right.");
      }
      return { ok: true, cleaned: raw.trim() };
    }
  }
}

function err(field: string, message: string): FieldCheck {
  return { ok: false, error: { field, message } };
}

/**
 * Pre-flight check for the OPTIONS payload of a select_one / select_many
 * field. The schema editor calls this before persisting changes to a
 * field definition — catches duplicate or empty option values early.
 */
export function validateOptions(opts: FieldOptions | null | undefined): string[] {
  if (!opts) return [];
  if (!opts.options || !Array.isArray(opts.options)) return ['Options must be a list.'];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const o of opts.options) {
    if (typeof o.value !== 'string' || o.value.length === 0) {
      errors.push('Each option needs a value.');
      continue;
    }
    if (seen.has(o.value)) errors.push(`Duplicate option value: ${o.value}.`);
    seen.add(o.value);
  }
  return errors;
}
