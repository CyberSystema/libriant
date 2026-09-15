/**
 * The simple form's half of the dual-mode editor, for the fields that map to
 * ONE MARC path each (2.0 phase 20j).
 *
 * ## Why this exists before phases 28-29
 *
 * 1.0's book form PATCHes scalar fields — title, publisher, year — at a route
 * the cutover deletes. 2.0's write path is `applyOps` over MARC paths, which is
 * a different model, and the dual-mode editor that owns it is phases 28-29 in
 * M5. Between the cutover and M5 a cataloguer would otherwise be unable to fix a
 * typo in a title: the catalogue could be created and deleted but not
 * corrected.
 *
 * So this is the subset of §6 phase 29 that the cutover cannot do without —
 * "the simple form emitting path ops ONLY for widgets the user changed" — and
 * nothing more. Phase 29 replaces it with the definition-driven version and
 * gains the mandatory *Advanced content* panel; this has neither.
 *
 * ## What is deliberately NOT here
 *
 * A widget whose value lives at a fixed-field POSITION. The language of a
 * record is `008/35-37`, three bytes inside a forty-character control field
 * whose meaning is positional and whose other bytes must survive being written
 * around. Editing it needs the positional editor phase 29 designs, and a form
 * that silently wrote three bytes into the middle of an 008 would be the one
 * way to corrupt a record that no test here would catch. The screen shows it
 * read-only and says why.
 *
 * Contributors are absent for the same class of reason and a different one: a
 * 100 or 700 is a repeatable field with its own indicators and subfields, and
 * there is no authority store until phase 45.
 *
 * ## The ops this builds
 *
 * `setValue` carries `from` as a PRECONDITION — `applyOps` refuses the batch if
 * what is there is not what the form read — so a second cataloguer's save
 * cannot be silently overwritten even within the window the content hash
 * covers. Where the subfield does not exist yet, the op is `insertSubfield`
 * instead, because `setValue` on a path that resolves to nothing is an error
 * rather than a create.
 */

/**
 * Just enough of a MARC record to find a subfield in it.
 *
 * DECLARED HERE rather than imported from `@libriant/marc`. The web app does not
 * depend on that package, and adding the dependency for one type would also mean
 * adding it to the web Dockerfile's COPY list — a workspace dep missing from one
 * builds a green image that cannot boot, which `check:docker-workspace-closure`
 * exists because of. This is the structural shape `packages/marc` writes and
 * `applyOps` reads; the ops built from it are validated by the server against
 * the real type either way.
 */
export type MarcRecord = { leader: string; fields: unknown[] };

/** One editable widget, and the single subfield it stands for. */
export type SimpleField = {
  readonly key: 'title' | 'publisher' | 'publicationYear' | 'isbn' | 'edition';
  /** The MARC tag the value lives in. */
  readonly tag: string;
  /** The subfield code within it. */
  readonly code: string;
  /**
   * Where the field is inserted when the record has none, relative to the other
   * fields. MARC keeps its fields in tag order and `applyOps` does not sort, so
   * a 264 inserted before the 245 would produce a record that serialises out of
   * order — legal, and wrong to anybody reading the bytes.
   */
  readonly indicatorsWhenCreating: string;
};

/**
 * The five, in the order the form shows them.
 *
 * 264 rather than 260 for publication: RDA replaced 260 with 264, and a record
 * this product creates through `marcFromBook` already carries 264. A record
 * IMPORTED from an older system may carry 260 instead — {@link readField}
 * falls back to it, so the form displays what is there, and
 * {@link opsForChanges} writes back to whichever tag it read from rather than
 * silently migrating the record to 264 behind the cataloguer.
 */
export const SIMPLE_FIELDS: readonly SimpleField[] = [
  { key: 'title', tag: '245', code: 'a', indicatorsWhenCreating: '10' },
  { key: 'edition', tag: '250', code: 'a', indicatorsWhenCreating: '  ' },
  { key: 'publisher', tag: '264', code: 'b', indicatorsWhenCreating: ' 1' },
  { key: 'publicationYear', tag: '264', code: 'c', indicatorsWhenCreating: ' 1' },
  { key: 'isbn', tag: '020', code: 'a', indicatorsWhenCreating: '  ' },
];

/** The legacy tag a value may be found under instead. */
const LEGACY_TAG: Record<string, string> = { '264': '260' };

type DataField = { t: string; i?: string; s: Array<Record<string, string>> };

function isDataField(f: unknown): f is DataField {
  return typeof f === 'object' && f !== null && Array.isArray((f as DataField).s);
}

/**
 * What the record currently says for one widget, and where it said it.
 *
 * Returns the RESOLVED tag and the two indices the op path needs, because a
 * path names "every repeatable level indexed" — `245[0]$a[0]` — and the form
 * must address the occurrence it read rather than the first one that happens to
 * match at save time.
 */
export function readField(
  record: MarcRecord,
  field: SimpleField,
): {
  value: string;
  tag: string;
  fieldIndex: number;
  /** The occurrence of THIS CODE, which is what the op path indexes: `$a[0]`. */
  subfieldIndex: number;
  /**
   * The position in the field's whole subfield array, which is what `at`
   * indexes on an insert or a delete.
   *
   * TWO DIFFERENT NUMBERS, and conflating them is a 409 rather than a wrong
   * edit — measured: `applyOps` reads `at` against `entry.field.s` and refuses
   * when the subfield there is not the one the op expected to remove. For
   * `245` holding `[$a, $c]`, `$c` is `subfieldIndex` 0 and `absoluteIndex` 1.
   */
  absoluteIndex: number;
  /** How many subfields the field has, so an insert can append rather than lead. */
  fieldLength: number;
} | null {
  const fields = record.fields as unknown as unknown[];
  for (const tag of [field.tag, LEGACY_TAG[field.tag]].filter(
    (t): t is string => t !== undefined,
  )) {
    let occurrence = -1;
    for (const raw of fields) {
      if (!isDataField(raw) || raw.t !== tag) continue;
      occurrence += 1;
      let subIndex = -1;
      for (const [absolute, sub] of raw.s.entries()) {
        const code = Object.keys(sub)[0];
        if (code === undefined) continue;
        if (code !== field.code) continue;
        subIndex += 1;
        return {
          value: sub[code] ?? '',
          tag,
          fieldIndex: occurrence,
          subfieldIndex: subIndex,
          absoluteIndex: absolute,
          fieldLength: raw.s.length,
        };
      }
    }
  }
  return null;
}

/** Every widget's current value, for seeding the form. */
export function readSimpleFields(record: MarcRecord): Record<SimpleField['key'], string> {
  const out = {} as Record<SimpleField['key'], string>;
  for (const f of SIMPLE_FIELDS) out[f.key] = readField(record, f)?.value ?? '';
  return out;
}

/** An op in the shape `PATCH /catalog/bib/:id` accepts. */
export type SimpleOp =
  | { op: 'setValue'; path: string; from: string; to: string }
  | { op: 'insertSubfield'; path: string; at: number; subfield: Record<string, string> }
  | { op: 'deleteSubfield'; path: string; at: number; subfield: Record<string, string> };

/**
 * The ops for what actually changed, and nothing else.
 *
 * ONLY THE WIDGETS THE CATALOGUER TOUCHED. A form that sent every field on
 * every save would make each edit a whole-record diff, which is precisely what
 * the PATCH-not-PUT decision on the controller exists to prevent: the op list
 * carries WHICH subfield was touched, and a full send throws that away.
 *
 * Returns `[]` when nothing changed, and the caller must not send an empty
 * batch — a version with no ops is a version that says nothing happened.
 */
export function opsForChanges(
  record: MarcRecord,
  before: Record<SimpleField['key'], string>,
  after: Record<SimpleField['key'], string>,
): SimpleOp[] {
  const ops: SimpleOp[] = [];
  for (const field of SIMPLE_FIELDS) {
    const next = (after[field.key] ?? '').trim();
    const prev = (before[field.key] ?? '').trim();
    if (next === prev) continue;

    const found = readField(record, field);
    if (found === null) {
      if (next === '') continue;
      // NO FIELD TO SET INTO. `setValue` resolves a path and fails when it
      // names nothing, so a first value is an insert — and the caller is told
      // it cannot be expressed when the FIELD itself is missing too, because
      // creating a 264 from a form is a cataloguing decision (which indicators?
      // which of the three RDA functions?) rather than a text edit.
      // APPENDED, not led. `at` is a position in the field's subfield array and
      // MARC subfield order is meaningful — a `$b` inserted before the `$a` it
      // qualifies is a title statement that reads backwards. The end is the one
      // position that is right without knowing the field's own ordering rules,
      // which is phase 29's business.
      const host = hostField(record, field);
      if (host === null) continue;
      ops.push({
        op: 'insertSubfield',
        path: `${host.tag}[${host.index}]`,
        at: host.length,
        subfield: { [field.code]: next },
      });
      continue;
    }
    const path = `${found.tag}[${found.fieldIndex}]$${field.code}[${found.subfieldIndex}]`;
    if (next === '') {
      ops.push({
        op: 'deleteSubfield',
        path,
        at: found.absoluteIndex,
        subfield: { [field.code]: found.value },
      });
      continue;
    }
    ops.push({ op: 'setValue', path, from: found.value, to: next });
  }
  return ops;
}

/** The field a new subfield would go into, when the record has one. */
function hostField(
  record: MarcRecord,
  field: SimpleField,
): { tag: string; index: number; length: number } | null {
  const fields = record.fields as unknown as unknown[];
  for (const tag of [field.tag, LEGACY_TAG[field.tag]].filter(
    (t): t is string => t !== undefined,
  )) {
    let occurrence = -1;
    for (const raw of fields) {
      if (!isDataField(raw) || raw.t !== tag) continue;
      occurrence += 1;
      return { tag, index: occurrence, length: raw.s.length };
    }
  }
  return null;
}

/**
 * Whether a widget can be offered at all for THIS record.
 *
 * A value the form can read it can edit; a value it cannot find needs a field
 * that does not exist, and creating one is a cataloguing decision rather than a
 * text edit. The screen disables the input and says so, which is more honest
 * than accepting a keystroke it cannot save.
 */
export function canEdit(record: MarcRecord, field: SimpleField): boolean {
  if (readField(record, field) !== null) return true;
  const fields = record.fields as unknown as unknown[];
  return fields.some((f) => isDataField(f) && (f.t === field.tag || f.t === LEGACY_TAG[field.tag]));
}

/**
 * The title to show at the top of a record, and the contributors under it.
 *
 * MIRRORS `projectBib` (`packages/marc/src/bib-projection.ts`) rather than
 * calling it, for the reason {@link MarcRecord} gives: the web app does not
 * depend on `@libriant/marc` and adding it for two string helpers would also
 * mean adding it to the web Dockerfile's COPY list.
 *
 * The rule being mirrored is exactly two lines of that file and is worth
 * stating: a MARC record has no `subtitle` field, it has a TITLE STATEMENT, so
 * `245 $a` and `$b` are joined; and the trailing ISBD punctuation that leads
 * into the next subfield (`/`, `:`, `;`, `,`, `=`) is dropped, because "Η ΠΟΛΙΣ
 * ΕΑΛΩ /" is correct on a catalogue card and wrong as a page heading.
 *
 * If the two ever disagree the catalogue LIST (which reads the projection) and
 * this screen would show the same record under two titles — so the unit test
 * beside this file pins the punctuation rule.
 *
 * {@link UNTITLED_TITLE} is the same sentinel and is deliberately NOT
 * translated: the list renders the projector's stored `[Untitled]`, and a
 * localised heading here would mean the same record appearing under two names
 * on two screens for exactly the records that are hardest to identify.
 */
export const UNTITLED_TITLE = '[Untitled]';

export function readDisplayTitle(record: MarcRecord): string {
  const f = (record.fields as unknown[]).find((x) => isDataField(x) && x.t === '245');
  if (!isDataField(f)) return '';
  const parts: string[] = [];
  for (const sub of f.s) {
    const code = Object.keys(sub)[0];
    if (code === 'a' || code === 'b') parts.push(sub[code] ?? '');
  }
  return tidyIsbd(parts.filter(Boolean).join(' '));
}

/** The 1XX/7XX name headings, in record order, for display only. */
export function readContributors(record: MarcRecord): string[] {
  const out: string[] = [];
  for (const raw of record.fields as unknown[]) {
    if (!isDataField(raw)) continue;
    if (!['100', '110', '111', '700', '710', '711'].includes(raw.t)) continue;
    // $a is the name; $d the dates, $c a title of nobility, $e the relator.
    // Joined as the record has them, because a heading read back in a
    // different order is a different heading — and there is no authority store
    // to resolve it against until phase 45.
    const parts: string[] = [];
    for (const sub of raw.s) {
      const code = Object.keys(sub)[0];
      if (code !== undefined && ['a', 'b', 'c', 'd', 'q'].includes(code))
        parts.push(sub[code] ?? '');
    }
    const name = tidyIsbd(parts.filter(Boolean).join(' '));
    if (name) out.push(name);
  }
  return out;
}

/** Collapse whitespace and drop the ISBD punctuation that leads into a subfield. */
function tidyIsbd(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*[/:;,=]$/, '')
    .trim();
}
