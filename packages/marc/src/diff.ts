import { LINKAGE_SUBFIELD } from './linkage.js';
import {
  LEADER,
  isDataField,
  subfieldCode,
  subfieldValue,
  type LeaderPosition,
  type MarcField,
  type MarcRecord,
  type Subfield,
} from './types.js';

/**
 * What changed between two versions of a record.
 *
 * ## Why not a text diff
 *
 * The version history is one of the four things M2 claims a library can do —
 * "see every version of every record with a field-level diff and restore any of
 * them" — and it is the one where being nearly right is worthless. A diff that
 * reports four false changes every time a subject heading is deleted teaches
 * cataloguers to stop reading it, and then the audit trail exists and does
 * nothing.
 *
 * ## The one decision that makes it right
 *
 * **Repeated fields are aligned by CONTENT, not by index.** A record with five
 * 650s, minus the second, is one removal. Index alignment reports it as four
 * changes and a removal, because 650[1] "became" the old 650[2] and so on down.
 * The same rule applies one level down to repeated subfields.
 *
 * ## The verdict
 *
 * `sameContent` (canonical.ts) answers "did anything change" faster. This
 * answers the harder question the write path needs: whether what changed is
 * worth a version. A `normalization-only` change (NFC applied, nothing else) or
 * a `linkage-only` change (`$6` occurrence numbers repaired) is a change nobody
 * asked for, and a version history full of them is a version history nobody
 * reads.
 */

export type LeaderChange = {
  /** The position by NAME. `'encodingLevel'`, never `'17'`. */
  readonly position: LeaderPosition;
  readonly from: string;
  readonly to: string;
};

export type SubfieldChange = {
  readonly kind: 'added' | 'removed' | 'changed' | 'moved';
  readonly code: string;
  /** 1-based occurrence of this code within the field. */
  readonly occurrence: number;
  readonly from?: string;
  readonly to?: string;
};

export type FieldChange = {
  readonly kind: 'added' | 'removed' | 'changed' | 'moved';
  readonly tag: string;
  /** 1-based occurrence of the tag within the record. */
  readonly occurrence: number;
  readonly fromIndex?: number;
  readonly toIndex?: number;
  /** Reported separately from subfields: an indicator change is not a text edit. */
  readonly indicators?: { readonly from: string; readonly to: string };
  readonly subfields?: readonly SubfieldChange[];
  readonly value?: { readonly from: string; readonly to: string };
  /** What KIND of change this is, so a UI can hide the uninteresting ones. */
  readonly class: 'content' | 'normalization' | 'linkage';
};

export type MarcDiff = {
  readonly leader: readonly LeaderChange[];
  readonly fields: readonly FieldChange[];
  readonly verdict: 'identical' | 'normalization-only' | 'linkage-only' | 'changed';
  /** `marc_record_versions.changed_tags`, derived here so it cannot disagree. */
  readonly changedTags: readonly string[];
};

/** Positions a writer recomputes; a change in them is not an edit. */
const IGNORED_LEADER_POSITIONS: ReadonlySet<LeaderPosition> = new Set([
  'recordLength',
  'baseAddress',
]);

export function diff(before: MarcRecord, after: MarcRecord): MarcDiff {
  const leader: LeaderChange[] = [];
  for (const name of Object.keys(LEADER) as LeaderPosition[]) {
    if (IGNORED_LEADER_POSITIONS.has(name)) continue;
    const [from, to] = LEADER[name];
    const a = before.leader.slice(from, to);
    const b = after.leader.slice(from, to);
    if (a !== b) leader.push({ position: name, from: a, to: b });
  }

  const tags = new Set([...before.fields.map((f) => f.t), ...after.fields.map((f) => f.t)]);
  const aligned: Aligned[] = [];
  const unmatched: FieldChange[] = [];
  for (const tag of [...tags].sort()) {
    align(tag, indexed(before.fields, tag), indexed(after.fields, tag), aligned, unmatched);
  }

  // A field only MOVED if its position relative to the other surviving fields
  // changed. Deleting the second of five 650s shifts the last three by one; an
  // absolute-index comparison calls that three moves and a removal, which is
  // the noise that makes a version history unreadable. The fields that really
  // moved are those outside the longest run whose relative order is preserved.
  aligned.sort((a, b) => a.l.index - b.l.index);
  const stayed = longestIncreasingSubsequence(aligned.map((p) => p.r.index));
  const fields: FieldChange[] = [];
  aligned.forEach((pair, i) => {
    const change = diffField(pair.tag, pair.occurrence, pair.l, pair.r, !stayed.has(i));
    if (change) fields.push(change);
  });
  fields.push(...unmatched);
  fields.sort((a, b) => (a.toIndex ?? a.fromIndex ?? 0) - (b.toIndex ?? b.fromIndex ?? 0));

  const changedTags = [...new Set(fields.map((f) => f.tag))].sort();
  const verdict =
    !leader.length && !fields.length
      ? 'identical'
      : fields.every((f) => f.class === 'normalization') && !leader.length
        ? 'normalization-only'
        : fields.every((f) => f.class === 'linkage') && !leader.length
          ? 'linkage-only'
          : 'changed';

  return { leader, fields, verdict, changedTags };
}

type Positioned = { field: MarcField; index: number };
type Aligned = { tag: string; occurrence: number; l: Positioned; r: Positioned };

/**
 * Indices of the longest subsequence of `values` that is already increasing.
 *
 * Everything outside it is what actually moved. O(n log n), and n here is the
 * number of fields in one record.
 */
function longestIncreasingSubsequence(values: readonly number[]): Set<number> {
  const tails: number[] = [];
  const tailIndex: number[] = [];
  const previous: number[] = new Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((tails[mid] as number) < v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = v;
    tailIndex[lo] = i;
    previous[i] = lo > 0 ? (tailIndex[lo - 1] as number) : -1;
  }
  const keep = new Set<number>();
  let at = tails.length ? (tailIndex[tails.length - 1] as number) : -1;
  while (at >= 0) {
    keep.add(at);
    at = previous[at] as number;
  }
  return keep;
}

function indexed(fields: readonly MarcField[], tag: string): Positioned[] {
  const out: Positioned[] = [];
  fields.forEach((field, index) => {
    if (field.t === tag) out.push({ field, index });
  });
  return out;
}

/**
 * Align two lists of same-tag fields by best content match, then diff each pair.
 *
 * Greedy over a similarity score rather than a minimum-cost assignment: with the
 * counts a real record has (five 650s is a lot) the two agree, and greedy is
 * something a reader can follow. An identical field always scores 1 and is
 * therefore matched first, which is the case that matters — it is what keeps a
 * deletion from cascading.
 */
function align(
  tag: string,
  left: Positioned[],
  right: Positioned[],
  aligned: Aligned[],
  unmatched: FieldChange[],
): void {
  const pairs: { l: Positioned; r: Positioned; score: number }[] = [];
  for (const l of left) {
    for (const r of right) pairs.push({ l, r, score: similarity(l.field, r.field) });
  }
  pairs.sort((a, b) => b.score - a.score || a.l.index - b.l.index || a.r.index - b.r.index);

  const usedLeft = new Set<Positioned>();
  const usedRight = new Set<Positioned>();
  const matched: { l: Positioned; r: Positioned }[] = [];
  for (const p of pairs) {
    if (p.score <= 0) break;
    if (usedLeft.has(p.l) || usedRight.has(p.r)) continue;
    usedLeft.add(p.l);
    usedRight.add(p.r);
    matched.push({ l: p.l, r: p.r });
  }

  matched.sort((a, b) => a.r.index - b.r.index);
  matched.forEach(({ l, r }, occurrence) => {
    aligned.push({ tag, occurrence: occurrence + 1, l, r });
  });

  left.forEach((l, i) => {
    if (usedLeft.has(l)) return;
    unmatched.push({
      kind: 'removed',
      tag,
      occurrence: i + 1,
      fromIndex: l.index,
      class: 'content',
      ...describe(l.field),
    });
  });
  right.forEach((r, i) => {
    if (usedRight.has(r)) return;
    unmatched.push({
      kind: 'added',
      tag,
      occurrence: i + 1,
      toIndex: r.index,
      class: 'content',
      ...describe(r.field),
    });
  });
}

function describe(field: MarcField): Partial<FieldChange> {
  if (!isDataField(field)) return { value: { from: field.v, to: field.v } };
  return {
    indicators: { from: field.i, to: field.i },
    subfields: field.s.map((s, i) => ({
      kind: 'added' as const,
      code: subfieldCode(s),
      occurrence: i + 1,
      to: subfieldValue(s),
    })),
  };
}

function diffField(
  tag: string,
  occurrence: number,
  l: Positioned,
  r: Positioned,
  moved: boolean,
): FieldChange | null {
  const a = l.field;
  const b = r.field;

  if (!isDataField(a) || !isDataField(b)) {
    const av = isDataField(a) ? '' : a.v;
    const bv = isDataField(b) ? '' : b.v;
    if (av === bv) {
      return moved
        ? { kind: 'moved', tag, occurrence, fromIndex: l.index, toIndex: r.index, class: 'content' }
        : null;
    }
    return {
      kind: 'changed',
      tag,
      occurrence,
      fromIndex: l.index,
      toIndex: r.index,
      value: { from: av, to: bv },
      class: classOf(av, bv, false),
    };
  }

  const indicators = a.i === b.i ? undefined : { from: a.i, to: b.i };
  const subfields = diffSubfields(a.s, b.s);
  if (!indicators && !subfields.length) {
    return moved
      ? { kind: 'moved', tag, occurrence, fromIndex: l.index, toIndex: r.index, class: 'content' }
      : null;
  }
  // Every subfield change is on `$6` and nothing else changed: this is the
  // linkage normalizer's work, not a cataloguer's.
  const linkageOnly =
    !indicators && subfields.length > 0 && subfields.every((s) => s.code === LINKAGE_SUBFIELD);
  const normalizationOnly =
    !indicators &&
    subfields.length > 0 &&
    subfields.every(
      (s) => s.kind === 'changed' && classOf(s.from ?? '', s.to ?? '', false) === 'normalization',
    );

  return {
    kind: 'changed',
    tag,
    occurrence,
    fromIndex: l.index,
    toIndex: r.index,
    ...(indicators ? { indicators } : {}),
    subfields,
    class: linkageOnly ? 'linkage' : normalizationOnly ? 'normalization' : 'content',
  };
}

function diffSubfields(a: readonly Subfield[], b: readonly Subfield[]): SubfieldChange[] {
  const out: SubfieldChange[] = [];
  const codes = new Set([...a.map(subfieldCode), ...b.map(subfieldCode)]);
  for (const code of [...codes].sort()) {
    const left = a.filter((s) => subfieldCode(s) === code).map(subfieldValue);
    const right = b.filter((s) => subfieldCode(s) === code).map(subfieldValue);
    const shared = Math.min(left.length, right.length);
    for (let i = 0; i < shared; i++) {
      const from = left[i] as string;
      const to = right[i] as string;
      if (from !== to) out.push({ kind: 'changed', code, occurrence: i + 1, from, to });
    }
    for (let i = shared; i < left.length; i++) {
      out.push({ kind: 'removed', code, occurrence: i + 1, from: left[i] as string });
    }
    for (let i = shared; i < right.length; i++) {
      out.push({ kind: 'added', code, occurrence: i + 1, to: right[i] as string });
    }
  }
  return out;
}

/** A change that disappears under NFC is a normalization, not an edit. */
function classOf(from: string, to: string, linkage: boolean): FieldChange['class'] {
  if (linkage) return 'linkage';
  if (from !== to && from.normalize('NFC') === to.normalize('NFC')) return 'normalization';
  return 'content';
}

/**
 * How alike two same-tag fields are, in [0, 1].
 *
 * Identical scores 1 exactly, which is what makes an unchanged field match its
 * own counterpart before anything else and stops a deletion from cascading down
 * the remaining occurrences.
 */
function similarity(a: MarcField, b: MarcField): number {
  if (isDataField(a) !== isDataField(b)) return 0;
  if (!isDataField(a) || !isDataField(b)) {
    const av = (a as { v: string }).v;
    const bv = (b as { v: string }).v;
    return av === bv ? 1 : av.length && bv.length && av.slice(0, 6) === bv.slice(0, 6) ? 0.5 : 0.1;
  }
  const left = a.s.map((s) => `${subfieldCode(s)} ${subfieldValue(s)}`);
  const right = b.s.map((s) => `${subfieldCode(s)} ${subfieldValue(s)}`);
  if (!left.length && !right.length) return a.i === b.i ? 1 : 0.5;
  const rest = [...right];
  let hits = 0;
  for (const item of left) {
    const at = rest.indexOf(item);
    if (at >= 0) {
      rest.splice(at, 1);
      hits += 1;
    }
  }
  const overlap = (2 * hits) / (left.length + right.length);
  return a.i === b.i ? overlap : overlap * 0.9;
}
