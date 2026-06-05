/**
 * Row mapper: turn one raw source row + a column mapping into a typed,
 * partially-validated record ready for the import engine — plus a precise
 * list of per-field issues. This is where transforms run and where the first
 * line of validation (types, required built-ins, enum membership) happens.
 *
 * Three output buckets:
 *   - `values`        — the entity's own typed fields (title, dueAt, …)
 *   - `customFields`  — values destined for tenant-defined custom fields
 *                       (kept as raw strings; re-validated against the live
 *                       field definitions by the engine via dynamic-validator)
 *   - `refs`          — foreign natural keys (bookIsbn13, copyBarcode, …) the
 *                       engine resolves to real ids at commit time
 */
import type { ImportEntityKind } from '@libriant/db-control';
import type { ColumnMapping } from './auto-map.js';
import {
  getEntitySpec,
  mappableFields,
  type ImportFieldDef,
  type ImportFieldKind,
} from './entity-fields.js';
import {
  normalizeIsbn10,
  normalizeIsbn13,
  splitMulti,
  toBool,
  toDateIso,
  toDateTimeIso,
  toInt,
  toMoneyCents,
  toText,
  toYear,
  flipName,
  type TransformResult,
} from './transforms.js';

export type RowIssue = {
  field: string | null;
  code: string;
  message: string;
  severity: 'error' | 'warning';
};

export type MappedRow = {
  rowNumber: number;
  values: Record<string, unknown>;
  customFields: Record<string, unknown>;
  refs: Record<string, string>;
  issues: RowIssue[];
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Common status synonyms across legacy systems → our enum values. */
const ENUM_SYNONYMS: Record<string, string> = {
  checkedout: 'on_loan',
  checked_out: 'on_loan',
  out: 'on_loan',
  onloan: 'on_loan',
  issued: 'on_loan',
  in: 'available',
  onshelf: 'available',
  available: 'available',
  returned: 'returned',
  active: 'active',
  current: 'active',
  suspended: 'suspended',
  blocked: 'suspended',
  inactive: 'suspended',
  archived: 'archived',
  deleted: 'archived',
  lost: 'lost',
  missing: 'lost',
  damaged: 'damaged',
  withdrawn: 'withdrawn',
  weeded: 'withdrawn',
  paid: 'paid',
  waived: 'waived',
  forgiven: 'waived',
  outstanding: 'outstanding',
  unpaid: 'outstanding',
  queued: 'queued',
  pending: 'queued',
  waiting: 'queued',
  ready: 'ready',
  fulfilled: 'fulfilled',
  expired: 'expired',
  canceled: 'canceled',
  cancelled: 'canceled',
};

function coerceEnum(raw: string, allowed: readonly string[]): TransformResult<string> {
  const norm = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (allowed.includes(norm)) return { ok: true, value: norm };
  const compact = norm.replace(/_/g, '');
  const syn = ENUM_SYNONYMS[norm] ?? ENUM_SYNONYMS[compact];
  if (syn && allowed.includes(syn)) return { ok: true, value: syn };
  return { ok: false, reason: `must be one of: ${allowed.join(', ')}` };
}

function applyTransform(
  def: ImportFieldDef,
  raw: string,
  tweaks: { dayFirst?: boolean; flipName?: boolean; multiSeparators?: string } = {},
): TransformResult<unknown> {
  const kind: ImportFieldKind = def.kind;
  switch (kind) {
    case 'text':
    case 'longtext':
      return { ok: true, value: toText(raw) };
    case 'int':
      return toInt(raw);
    case 'year':
      return toYear(raw);
    case 'money':
      return toMoneyCents(raw);
    case 'bool':
      return toBool(raw);
    case 'date':
      return toDateIso(raw, { dayFirst: tweaks.dayFirst });
    case 'datetime':
      return toDateTimeIso(raw);
    case 'isbn13':
      return normalizeIsbn13(raw);
    case 'isbn10':
      return normalizeIsbn10(raw);
    case 'email': {
      const v = raw.trim().toLowerCase();
      return EMAIL_RE.test(v) ? { ok: true, value: v } : { ok: false, reason: 'not a valid email' };
    }
    case 'multi': {
      let parts = splitMulti(raw, tweaks.multiSeparators);
      if (tweaks.flipName) parts = parts.map(flipName);
      return { ok: true, value: parts };
    }
    case 'enum':
      return coerceEnum(raw, def.enumValues ?? []);
  }
}

export function mapRow(
  kind: ImportEntityKind,
  mapping: ColumnMapping,
  row: { rowNumber: number; cells: Record<string, string> },
): MappedRow {
  const spec = getEntitySpec(kind);
  const defByKey = new Map(mappableFields(kind).map((f) => [f.key, f]));
  const refKeys = new Set<string>();
  for (const ref of spec.references ?? []) for (const f of ref.byFields) refKeys.add(f);

  const out: MappedRow = {
    rowNumber: row.rowNumber,
    values: {},
    customFields: {},
    refs: {},
    issues: [],
  };

  for (const [col, target] of Object.entries(mapping)) {
    if (!target || target.field === null) continue;
    const raw = (row.cells[col] ?? '').trim();

    // Custom field: keep the raw value; the engine validates it against the
    // tenant's live field definitions (dynamic-validator).
    if (target.field.startsWith('custom:')) {
      if (raw.length) out.customFields[target.field.slice('custom:'.length)] = raw;
      continue;
    }

    const def = defByKey.get(target.field);
    if (!def) {
      out.issues.push({
        field: target.field,
        code: 'unknown_target',
        message: `Unknown target field "${target.field}".`,
        severity: 'warning',
      });
      continue;
    }
    if (!raw.length) continue; // empty cell → leave the field unset

    const result = applyTransform(def, raw, target.options);
    if (!result.ok) {
      out.issues.push({
        field: def.key,
        code: 'invalid_value',
        message: `${def.label}: ${result.reason}.`,
        severity: 'error',
      });
      continue;
    }
    if (refKeys.has(def.key)) {
      out.refs[def.key] = String(result.value);
    } else {
      out.values[def.key] = result.value;
    }
  }

  // Required built-in fields must be present.
  for (const def of spec.fields) {
    if (!def.required) continue;
    const v = out.values[def.key];
    const missing = v === undefined || v === null || (typeof v === 'string' && v.length === 0);
    if (missing) {
      out.issues.push({
        field: def.key,
        code: 'required',
        message: `${def.label} is required but was empty.`,
        severity: 'error',
      });
    }
  }

  // Required references: at least one of the candidate key fields must resolve.
  for (const ref of spec.references ?? []) {
    if (!ref.required) continue;
    const hasAny = ref.byFields.some((f) => (out.refs[f] ?? '').length > 0);
    if (!hasAny) {
      out.issues.push({
        field: ref.byFields[0] ?? ref.name,
        code: 'reference_missing',
        message: `A ${ref.name} reference is required (one of: ${ref.byFields.join(', ')}).`,
        severity: 'error',
      });
    }
  }

  return out;
}

export function hasBlockingIssue(row: MappedRow): boolean {
  return row.issues.some((i) => i.severity === 'error');
}
