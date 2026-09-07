import {
  isDataField,
  subfieldCode,
  subfieldValue,
  type DataField,
  type MarcField,
  type MarcRecord,
  type Subfield,
} from './types.js';

/**
 * `$6` — the linkage between a field and its alternate-graphic 880.
 *
 * A bilingual record holds the Greek title in `880` and the romanized title in
 * `245`, and `$6` is what says they are the same title. Its content is
 * `<linking tag>-<occurrence number>[/<script>[/<orientation>]]`, it is always
 * the field's first subfield, and the occurrence number is two digits,
 * zero-padded.
 *
 * ## The number does NOT mean an order, and this changes the phase
 *
 * The Library of Congress is explicit that the occurrence number exists "to
 * permit the matching of the associated fields (not to sequence the fields
 * within the record)", and that "an occurrence number is assigned at random for
 * each set of associated fields". The only real constraints are that it is
 * unique per pair within the record, that it is between 01 and 99, and that
 * `00` is reserved — an `880` carrying `$6245-00` is deliberately NOT linked to
 * anything, which is how agencies keep a script separate on purpose.
 *
 * The 2.0 plan's phase-7 line asks that inserting a paired field "renumbers
 * every `$6` on both sides". That is legal and it is also gratuitous, and on
 * real data it is harmful: an imported ABEKT or Aleph record arrives with sparse
 * numbers (01, 07, 42), so a compacting pass rewrites `$6` on the very first
 * save — producing a version nobody asked for, flooding the diff, and breaking
 * byte-exact re-export on exactly the bilingual Greek records this product
 * exists to import.
 *
 * So there are two policies and the caller chooses:
 *
 *   - **`repair`** (the default) — allocate the lowest free number to a new
 *     pair, break collisions, and never touch a link that is already correct.
 *   - **`compact`** — renumber every pair densely in field order. This is what
 *     the plan's line describes, and it is what a deliberate "tidy the linkage"
 *     action in the editor should call.
 *
 * Both maintain the invariant that actually matters, which is what the phase's
 * criterion should have said: after any batch, every `$6` pairs bijectively, no
 * occurrence number is used by two pairs, no link dangles that did not already
 * dangle, and `00` is never allocated or overwritten.
 */

export const LINKED_FIELD_TAG = '880';
export const LINKAGE_SUBFIELD = '6';
/** Reserved: "this field is deliberately not linked". Never allocated. */
export const UNLINKED_OCCURRENCE = '00';

export type Linkage = {
  /** The tag of the OTHER member of the pair. `880` on the regular side. */
  readonly tag: string;
  /** Two digits as written, `'00'` through `'99'`. A string, because `01` is not `1`. */
  readonly occurrence: string;
  /** MARC-8 designator (`(S`, `(B`, `$1`) or an ISO 15924 code (`Grek`). */
  readonly script?: string;
  /** `'r'` on a right-to-left field. */
  readonly orientation?: string;
};

const LINKAGE_RE = /^([0-9A-Za-z]{3})-(\d{2})(?:\/([^/]*))?(?:\/(.*))?$/;

export function parseLinkage(value: string): Linkage | null {
  const m = LINKAGE_RE.exec(value);
  if (!m) return null;
  return {
    tag: m[1] as string,
    occurrence: m[2] as string,
    ...(m[3] ? { script: m[3] } : {}),
    ...(m[4] ? { orientation: m[4] } : {}),
  };
}

export function formatLinkage(link: Linkage): string {
  let out = `${link.tag}-${link.occurrence}`;
  if (link.script) out += `/${link.script}`;
  if (link.orientation) out += `/${link.orientation}`;
  return out;
}

/** The `$6` of a field, parsed, or null when it has none. */
export function linkageOf(field: MarcField): Linkage | null {
  if (!isDataField(field)) return null;
  const first = field.s[0];
  if (!first || subfieldCode(first) !== LINKAGE_SUBFIELD) return null;
  return parseLinkage(subfieldValue(first));
}

/** Whether a link participates in a pair at all (`00` deliberately does not). */
export function isLinked(link: Linkage | null): link is Linkage {
  return link !== null && link.occurrence !== UNLINKED_OCCURRENCE;
}

export type LinkageReport = {
  /** Occurrence number to the field indices that claim it. */
  readonly byOccurrence: ReadonlyMap<string, readonly number[]>;
  /** Field indices whose `$6` names a partner that is not in the record. */
  readonly dangling: readonly number[];
  /** Occurrence numbers claimed by more than one PAIR. */
  readonly collisions: readonly string[];
  /** Occurrence numbers in use, so a caller can allocate around them. */
  readonly used: ReadonlySet<string>;
};

/** Describe a record's linkage without changing it. */
export function inspectLinkage(record: MarcRecord): LinkageReport {
  const byOccurrence = new Map<string, number[]>();
  const used = new Set<string>();
  const dangling: number[] = [];

  record.fields.forEach((f, index) => {
    const link = linkageOf(f);
    if (!isLinked(link)) return;
    used.add(link.occurrence);
    const list = byOccurrence.get(link.occurrence) ?? [];
    list.push(index);
    byOccurrence.set(link.occurrence, list);
  });

  for (const indices of byOccurrence.values()) {
    // A well-formed set is exactly two fields pointing at each other's tags.
    if (indices.length === 1) dangling.push(indices[0] as number);
  }

  const collisions: string[] = [];
  for (const [occurrence, indices] of byOccurrence) {
    if (indices.length > 2) collisions.push(occurrence);
  }

  return { byOccurrence, dangling, collisions, used };
}

/**
 * The lowest occurrence number no pair is using.
 *
 * "Lowest free" rather than "one more than the highest" so that a record edited
 * for years does not walk off the end of two digits. Throws past 99: a record
 * with 99 linked pairs is not a record this code should quietly corrupt.
 */
export function allocateOccurrence(used: ReadonlySet<string>): string {
  for (let n = 1; n <= 99; n++) {
    const candidate = String(n).padStart(2, '0');
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('All 99 $6 occurrence numbers are in use in this record.');
}

export type LinkagePolicy = 'repair' | 'compact';

function withLinkage(field: DataField, link: Linkage): DataField {
  const rest = field.s.slice(1);
  const next: Subfield = { [LINKAGE_SUBFIELD]: formatLinkage(link) };
  return { ...field, s: [next, ...rest] };
}

/**
 * Bring a record's `$6` linkage back to the invariant, under one of the two
 * policies. Returns the same object when nothing needed changing, so a caller
 * can use identity to decide whether to write a version.
 */
export function normalizeLinkage(record: MarcRecord, policy: LinkagePolicy = 'repair'): MarcRecord {
  const report = inspectLinkage(record);
  if (policy === 'repair' && !report.collisions.length) return record;

  const fields = [...record.fields];
  let changed = false;

  if (policy === 'compact') {
    // Dense renumbering in field order. Each PAIR gets the next number; the
    // partner found later reuses it, so both sides stay together.
    const assigned = new Map<string, string>();
    let next = 1;
    fields.forEach((f, index) => {
      const link = linkageOf(f);
      if (!isLinked(link)) return;
      let occurrence = assigned.get(link.occurrence);
      if (!occurrence) {
        occurrence = String(next++).padStart(2, '0');
        if (next > 100) throw new Error('More than 99 linked pairs in one record.');
        assigned.set(link.occurrence, occurrence);
      }
      if (occurrence !== link.occurrence) {
        fields[index] = withLinkage(f as DataField, { ...link, occurrence });
        changed = true;
      }
    });
    return changed ? { ...record, fields } : record;
  }

  // `repair`: leave every correct link alone and break only the collisions —
  // three or more fields sharing one number, which no longer identifies a pair.
  // The FIRST two keep the number (they are almost always the real pair, being
  // the ones written together); the rest are reallocated.
  const used = new Set(report.used);
  for (const occurrence of report.collisions) {
    const indices = report.byOccurrence.get(occurrence) ?? [];
    for (const index of indices.slice(2)) {
      const f = fields[index] as MarcField;
      const link = linkageOf(f);
      if (!isLinked(link)) continue;
      const fresh = allocateOccurrence(used);
      used.add(fresh);
      fields[index] = withLinkage(f as DataField, { ...link, occurrence: fresh });
      changed = true;
    }
  }
  return changed ? { ...record, fields } : record;
}
