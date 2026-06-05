/**
 * Auto-mapping: given an entity kind and the source columns a file actually
 * has, propose a `source column → target field` mapping by matching column
 * headers (case-, accent- and punctuation-insensitively) against each field's
 * alias set. Greedy 1:1 assignment, best match first; anything unmatched is
 * left for the librarian to map (or ignore) in the wizard.
 */
import type { ImportEntityKind } from '@libriant/db-control';
import { mappableFields } from './entity-fields.js';

export type TransformTweaks = {
  /** Date parsing: day-first (European) vs month-first. */
  dayFirst?: boolean;
  /** Multi/name fields: flip `Last, First` → `First Last`. */
  flipName?: boolean;
  /** Multi fields: characters to split on (default `;|`). */
  multiSeparators?: string;
};

export type MappingTarget = {
  /**
   * Target field key, `custom:<fieldKey>` for a tenant custom field, or null
   * to ignore the column.
   */
  field: string | null;
  options?: TransformTweaks;
};

export type ColumnMapping = Record<string, MappingTarget>;

/** Lowercase, strip diacritics + punctuation/space; keep Greek + Latin letters. */
export function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

type Candidate = { column: string; field: string; score: number };

export function autoMap(
  kind: ImportEntityKind,
  columns: ReadonlyArray<{ name: string }>,
): ColumnMapping {
  const fields = mappableFields(kind);

  // field key → set of normalized alias strings (aliases + key + label).
  const aliasIndex = fields.map((f) => {
    const set = new Set<string>();
    for (const a of f.aliases) set.add(normalizeHeader(a));
    set.add(normalizeHeader(f.key));
    set.add(normalizeHeader(f.label));
    return { key: f.key, aliases: set };
  });

  const candidates: Candidate[] = [];
  for (const col of columns) {
    const norm = normalizeHeader(col.name);
    if (!norm) continue;
    for (const f of aliasIndex) {
      if (f.aliases.has(norm)) {
        // Prefer the most specific (longest) matching alias for tie-breaking.
        let best = 0;
        for (const a of f.aliases) if (a === norm) best = Math.max(best, a.length);
        candidates.push({ column: col.name, field: f.key, score: best });
      }
    }
  }

  // Greedy assignment: highest score first; one field per column, one column
  // per field. A column already carrying a strong match wins its field.
  candidates.sort((a, b) => b.score - a.score);
  const usedColumns = new Set<string>();
  const usedFields = new Set<string>();
  const mapping: ColumnMapping = {};
  for (const c of candidates) {
    if (usedColumns.has(c.column) || usedFields.has(c.field)) continue;
    usedColumns.add(c.column);
    usedFields.add(c.field);
    mapping[c.column] = { field: c.field };
  }
  // Remaining columns default to "ignore" so the UI shows every column.
  for (const col of columns) {
    if (!(col.name in mapping)) mapping[col.name] = { field: null };
  }
  return mapping;
}
