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
 * Hard cap on the input length a user-supplied regex is allowed to evaluate.
 * With `patternLooksCatastrophic` rejecting the exponential class, the residual
 * worst case is polynomial backtracking; this cap keeps even a quadratic blow-up
 * (≈cap²) in the low-millisecond range so a pattern can't stall the event loop.
 */
export const REGEX_INPUT_CAP = 2000;

/**
 * Static ReDoS screen for admin-authored validation patterns. JavaScript's
 * regex engine backtracks, so a quantifier applied to a sub-expression that is
 * itself "ambiguous" can blow up EXPONENTIALLY and freeze the single shared
 * event loop for every tenant. Pattern authorship is already restricted to
 * owner/admins (see the field-definition / collection-field role guards), so the
 * realistic threat is a careless or malicious admin — but one bad pattern still
 * has a platform-wide blast radius, so we refuse the dangerous shapes outright.
 *
 * A truly sound check needs an automaton analyzer (e.g. `recheck`) or a
 * non-backtracking engine (RE2) — both are dependency/Docker-build changes
 * tracked as follow-ups. This scanner is a precise, dependency-free
 * approximation: it walks the pattern with a paren stack (escape- and
 * char-class-aware, so it survives nesting that a single regex can't see) and
 * flags a REPEATED group whose body can match the same text two different ways:
 *   • nested unbounded quantifier  — `(a+)+`, `(.*)*`, `(a*)+`
 *   • overlapping alternation      — `(a|a)*`, `(a|ab)+`, `(a|a*)*`
 * Non-overlapping quantified alternation (`(foo|bar)+`, `(ab|cd)*`) and bounded
 * repetition (`([A-Z]{2})+`) stay ACCEPTED. Conservative on ambiguity: when in
 * doubt it rejects, never lets a known-dangerous pattern reach the match path.
 */
export function patternLooksCatastrophic(pattern: string): boolean {
  if (typeof pattern !== 'string') return true;
  if (pattern.length > 200) return true; // unreasonably long → reject
  // Stacked quantifiers applied directly to each other: `a+*`, `\w*+`, `[a-z]+*`.
  if (/[*+]\s*[*+]/.test(pattern)) return true;
  // Many overlapping unbounded quantifiers (`a*a*a*…`) → polynomial of high
  // degree. Real field patterns need very few; cap the total.
  if (countUnbounded(pattern) > 6) return true;
  // The dominant exponential class: a repeated group with an ambiguous body.
  return hasAmbiguousRepeatedGroup(pattern);
}

/** Count unescaped `*` / `+` quantifiers outside character classes. */
function countUnbounded(p: string): number {
  let n = 0;
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '*' || c === '+') n++;
  }
  return n;
}

/**
 * True if `p` contains a group `(...)` immediately followed by a repetition
 * quantifier (`*`, `+`, or `{…,}`) whose body is ambiguous (nested unbounded
 * quantifier, or overlapping alternation). Paren stack is escape- and
 * char-class-aware so nested groups are matched correctly.
 */
function hasAmbiguousRepeatedGroup(p: string): boolean {
  const stack: number[] = [];
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '(') {
      stack.push(i);
      continue;
    }
    if (c === ')') {
      const start = stack.pop();
      if (start === undefined) continue; // unbalanced — let RegExp() reject it
      const next = p[i + 1];
      const repeated = next === '*' || next === '+' || (next === '{' && isOpenEndedBrace(p, i + 1));
      if (repeated && bodyIsAmbiguous(p.slice(start + 1, i))) return true;
    }
  }
  return false;
}

/** `{n,}` / `{n,m}` (m possibly large) is repetition; `{n}` exact is not a blow-up driver. */
function isOpenEndedBrace(p: string, at: number): boolean {
  return /^\{\d*,\d*\}/.test(p.slice(at));
}

/**
 * A repeated group's body is "ambiguous" (can match the same text 2+ ways) if it
 * contains a nested unbounded quantifier, or an alternation whose branches can
 * overlap. `body` is the text between the group's own parens.
 */
function bodyIsAmbiguous(body: string): boolean {
  const branches = splitTopLevelAlternation(body);
  if (branches.length > 1 && branchesOverlap(branches)) return true;
  // Nested unbounded quantifier anywhere in the body (single-branch case):
  // `(a+)+`, `(\w*)+`, `(.*)*`.
  return branches.some((b) => countUnbounded(b) > 0 || /\{\d*,\}/.test(stripClasses(b)));
}

/** Split on `|` at the body's top level (ignoring nested groups/classes/escapes). */
function splitTopLevelAlternation(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inClass = false;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      cur += c + (body[i + 1] ?? '');
      i++;
      continue;
    }
    if (inClass) {
      cur += c;
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      cur += c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === '|' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Heuristic overlap test for the branches of a repeated alternation. Exponential
 * blow-up needs two branches that can match overlapping text. We flag when any
 * branch is empty, contains its own quantifier, or shares a first "token" with
 * another branch (`(a|a)`, `(a|ab)`). Distinct first tokens (`(foo|bar)`) are
 * treated as non-overlapping and ACCEPTED.
 */
function branchesOverlap(branches: string[]): boolean {
  const firsts = new Set<string>();
  for (const b of branches) {
    if (b.length === 0) return true; // empty branch → always-matchable → ambiguous
    if (countUnbounded(b) > 0) return true; // quantifier inside an alternation branch
    const tok = firstToken(b);
    if (firsts.has(tok)) return true; // two branches start the same way → overlap
    firsts.add(tok);
  }
  return false;
}

/** The first matchable token of a branch: an escape pair, a char class, or one char. */
function firstToken(b: string): string {
  let i = 0;
  while (i < b.length && b[i] === '^') i++; // skip leading start-anchors (zero-width)
  if (b[i] === '\\') return b.slice(i, i + 2);
  if (b[i] === '[') {
    const end = b.indexOf(']', i + 1);
    return b.slice(i, end === -1 ? b.length : end + 1);
  }
  return b[i] ?? '';
}

/** Remove `[...]` class contents so a literal `,` inside a class can't look like `{n,}`. */
function stripClasses(b: string): string {
  return b.replace(/\\.|\[[^\]]*\]/g, '');
}

/**
 * Validate a field's regex `pattern` at SAVE time. Returns a human-readable
 * error string if the pattern looks catastrophic (ReDoS) or doesn't compile,
 * else null. Pure — no throwing, no I/O; the caller maps a non-null result to a
 * 400. MUST be called on every create AND update of a field definition or a
 * collection field, since the pattern then runs on the shared event loop for
 * every record write (see `patternLooksCatastrophic`).
 */
export function patternSaveError(validationJson?: FieldValidation | null): string | null {
  const pattern = validationJson?.pattern;
  if (typeof pattern !== 'string' || pattern.length === 0) return null;
  if (patternLooksCatastrophic(pattern)) {
    return 'That validation pattern is too complex / risky (possible catastrophic backtracking). Simplify it.';
  }
  try {
    new RegExp(pattern);
  } catch {
    return 'That validation pattern is not a valid regular expression.';
  }
  return null;
}

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
        // ReDoS guard: an admin-authored pattern runs on the shared event loop
        // for EVERY record write, so a catastrophic-backtracking pattern would
        // freeze the API for all tenants. Refuse to execute a dangerous-looking
        // pattern (and bound the input length the engine sees) rather than risk
        // the freeze; the admin must fix the pattern (also rejected at save).
        if (patternLooksCatastrophic(def.validationJson.pattern)) {
          return err(
            def.fieldKey,
            `Field's validation pattern is invalid; ask an admin to fix it.`,
          );
        }
        if (raw.length > REGEX_INPUT_CAP) {
          return err(def.fieldKey, `Value is too long to validate against the field's pattern.`);
        }
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
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return err(def.fieldKey, "This link doesn't look right.");
      }
      // Only allow web/mail schemes (CAT-006). `new URL` happily parses
      // `javascript:`, `data:`, `file:`, `vbscript:` etc., which become a
      // stored-XSS vector the moment a stored URL is rendered into an href.
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
        return err(def.fieldKey, 'Only http(s) and mailto links are allowed.');
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
