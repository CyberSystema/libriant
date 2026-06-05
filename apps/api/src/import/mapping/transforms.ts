/**
 * Value transforms — turn a raw source cell (always a string out of the
 * parsers) into the typed value an entity field expects, tolerating the messy
 * shapes legacy ILS exports produce: European AND US date orders, money with
 * either decimal separator and a currency symbol, ISBNs with hyphens/qualifiers
 * (and 10-digit ISBNs where a 13 is wanted), multi-valued cells, and so on.
 *
 * Every transform returns a discriminated result so the row mapper can attach
 * a precise per-field issue instead of silently coercing garbage.
 */

export type TransformOk<T> = { ok: true; value: T };
export type TransformErr = { ok: false; reason: string };
export type TransformResult<T> = TransformOk<T> | TransformErr;

const ok = <T>(value: T): TransformOk<T> => ({ ok: true, value });
const fail = (reason: string): TransformErr => ({ ok: false, reason });

export function toText(raw: string): string {
  return raw.trim();
}

/** Strip thousands separators / stray characters and parse a whole number. */
export function toInt(raw: string): TransformResult<number> {
  const cleaned = raw.trim().replace(/[^0-9-]/g, '');
  if (!cleaned || cleaned === '-') return fail('not a whole number');
  const n = Number.parseInt(cleaned, 10);
  if (!Number.isFinite(n)) return fail('not a whole number');
  return ok(n);
}

/** Extract a 4-digit year from noisy strings like `c2020.` / `[2020]` / `2020-`. */
export function toYear(raw: string): TransformResult<number> {
  const m = raw.match(/(\d{4})/);
  if (!m) return fail('no 4-digit year found');
  const year = Number.parseInt(m[1]!, 10);
  if (year < 1 || year > 2999) return fail(`year ${year} out of range`);
  return ok(year);
}

const TRUE_WORDS = new Set(['true', 't', 'yes', 'y', '1', 'x', 'ναι', 'oui', 'si', 'on']);
const FALSE_WORDS = new Set(['false', 'f', 'no', 'n', '0', '', 'όχι', 'οχι', 'non', 'off']);

export function toBool(raw: string): TransformResult<boolean> {
  const s = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(s)) return ok(true);
  if (FALSE_WORDS.has(s)) return ok(false);
  return fail(`not a yes/no value: "${raw}"`);
}

/**
 * Parse a monetary amount to integer minor units (cents). Handles `€1.50`,
 * `1,50 €`, `1.234,56`, `1,234.56`, and bare `150`. Decimal-separator
 * inference: when both `.` and `,` appear, the rightmost is the decimal; when
 * only one appears and it's followed by exactly two digits at the very end,
 * it's treated as the decimal, otherwise as a thousands separator.
 */
export function toMoneyCents(raw: string): TransformResult<number> {
  let s = raw.trim();
  const negative = /^-|^\(.*\)$/.test(s);
  s = s.replace(/[^0-9.,]/g, '');
  if (!s) return fail('not an amount');

  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  let decimalSep: '.' | ',' | null = null;
  if (hasDot && hasComma) {
    decimalSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
  } else if (hasDot || hasComma) {
    const sep = hasDot ? '.' : ',';
    const parts = s.split(sep);
    // Single separator with exactly two trailing digits → decimal point.
    if (parts.length === 2 && parts[1]!.length === 2) decimalSep = sep;
  }

  let normalized: string;
  if (decimalSep) {
    const other = decimalSep === '.' ? ',' : '.';
    normalized = s.split(other).join('').replace(decimalSep, '.');
  } else {
    normalized = s.replace(/[.,]/g, '');
  }
  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) return fail('not an amount');
  const cents = Math.round(value * 100);
  return ok(negative ? -cents : cents);
}

/** Split a 1-3 part numeric date into a validated `YYYY-MM-DD`. */
function buildDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null; // rolled over → invalid (e.g. 31 Feb)
  }
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Parse a date to canonical `YYYY-MM-DD`. Accepts ISO, `YYYY/MM/DD`,
 * `DD/MM/YYYY`, `DD.MM.YYYY`, `DD-MM-YYYY`. Day/month order defaults to
 * day-first (European/Greek), but a component > 12 disambiguates.
 */
export function toDateIso(raw: string, opts: { dayFirst?: boolean } = {}): TransformResult<string> {
  const s = raw.trim();
  if (!s) return fail('empty date');
  const dayFirst = opts.dayFirst ?? true;

  // ISO date or datetime → take the date part if it's a real date.
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (isoMatch) {
    const built = buildDate(+isoMatch[1]!, +isoMatch[2]!, +isoMatch[3]!);
    return built ? ok(built) : fail(`not a real date: "${raw}"`);
  }

  const parts = s.split(/[-/.]/).map((p) => p.trim());
  if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
    const nums = parts.map((p) => Number.parseInt(p, 10)) as [number, number, number];
    let y: number, m: number, d: number;
    if (parts[0]!.length === 4) {
      [y, m, d] = nums; // YYYY M D
    } else if (parts[2]!.length === 4) {
      const [a, b, yr] = nums;
      y = yr;
      if (a > 12 && b <= 12) {
        d = a;
        m = b;
      } else if (b > 12 && a <= 12) {
        m = a;
        d = b;
      } else {
        d = dayFirst ? a : b;
        m = dayFirst ? b : a;
      }
    } else {
      return fail(`ambiguous date: "${raw}"`);
    }
    const built = buildDate(y, m, d);
    return built ? ok(built) : fail(`not a real date: "${raw}"`);
  }

  // Last resort: let the engine try (handles "Jan 5, 2020" etc.).
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return ok(parsed.toISOString().slice(0, 10));
  }
  return fail(`unrecognized date: "${raw}"`);
}

/** Parse to a full ISO datetime. Falls back to midnight UTC for date-only input. */
export function toDateTimeIso(raw: string): TransformResult<string> {
  const s = raw.trim();
  if (!s) return fail('empty date/time');
  const direct = new Date(s);
  if (!Number.isNaN(direct.getTime()) && /[T:]/.test(s)) {
    return ok(direct.toISOString());
  }
  const asDate = toDateIso(s);
  if (asDate.ok) return ok(new Date(`${asDate.value}T00:00:00.000Z`).toISOString());
  return fail(`unrecognized date/time: "${raw}"`);
}

/** ISBN-10 → ISBN-13 (978 prefix, recomputed check digit). */
export function isbn10to13(isbn10: string): string {
  const core = `978${isbn10.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(core[i]);
  const check = (10 - (sum % 10)) % 10;
  return `${core}${check}`;
}

/** Normalize to a 13-digit ISBN. Accepts a 10-digit ISBN and upgrades it. */
export function normalizeIsbn13(raw: string): TransformResult<string> {
  const cleaned = raw.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (!cleaned) return fail('empty ISBN');
  if (cleaned.length === 13 && /^\d{13}$/.test(cleaned)) return ok(cleaned);
  if (cleaned.length === 10 && /^\d{9}[\dX]$/.test(cleaned)) return ok(isbn10to13(cleaned));
  return fail(`not a valid ISBN-13: "${raw}"`);
}

/** Normalize to a 10-char ISBN-10 (digits, optional trailing X). */
export function normalizeIsbn10(raw: string): TransformResult<string> {
  const cleaned = raw.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (cleaned.length === 10 && /^\d{9}[\dX]$/.test(cleaned)) return ok(cleaned);
  return fail(`not a valid ISBN-10: "${raw}"`);
}

/** Split a multi-valued cell. Defaults to `;` / `|` so "Last, First" survives. */
export function splitMulti(raw: string, separators = ';|'): string[] {
  const re = new RegExp(`[${separators.replace(/[.*+?^${}()[\]\\]/g, '\\$&')}]`);
  return raw
    .split(re)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Flip `Last, First` → `First Last` (only when there's exactly one comma). */
export function flipName(raw: string): string {
  const parts = raw.split(',');
  if (parts.length !== 2) return raw.trim();
  return `${parts[1]!.trim()} ${parts[0]!.trim()}`.trim();
}
