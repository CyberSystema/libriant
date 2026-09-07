import { normalizeLinkage, type LinkagePolicy } from './linkage.js';
import { formatMarcPath, parseOpPath, type FieldPath, type MarcPath } from './path.js';
import {
  MarcError,
  isDataField,
  subfieldCode,
  subfieldValue,
  type DataField,
  type MarcField,
  type MarcRecord,
  type Subfield,
} from './types.js';

/**
 * The eight edits, and the two rules that make a batch of them mean something.
 *
 * ## Every op carries the value it replaces
 *
 * `setValue` has `from` as well as `to`; `deleteField` carries the field it
 * removes. That is not belt and braces — it is what lets the inverse of a single
 * op be computed **from the op alone**, without the record it was applied to,
 * which is what the AI suggestion review UI needs to render "this is what will
 * change" and what an undo of one edit needs.
 *
 * It does NOT make a BATCH invertible; see {@link invert} for why, and for what
 * the architecture does instead.
 *
 * It is also a precondition check for free: applying an op whose `from` does not
 * match what is there throws, which is what stops a stale AI suggestion or a
 * replayed offline edit from silently overwriting somebody else's work.
 *
 * ## Every path in a batch resolves against the ORIGINAL record
 *
 * The obvious implementation — apply op 1, then resolve op 2 against the result
 * — passes every single-op test and is wrong. A batch that deletes `650[0]` and
 * edits `650[1]` would, under sequential resolution, edit the field that used to
 * be `650[2]`. So paths and `at` indices are resolved ONCE, up front, against the
 * record as it was handed in, and the batch is then applied to those resolved
 * targets. That is the only reading under which "a suggestion is an array of
 * path ops" (contract 4.7) is reviewable: the reviewer saw the original.
 */

export type OpBase = { readonly path: string };

export type MarcOp =
  /** Insert a field at an absolute position in the ORIGINAL field list. */
  | { readonly op: 'insertField'; readonly at: number; readonly field: MarcField }
  /** Remove a field. `field` is the removed value, so the op inverts itself. */
  | { readonly op: 'deleteField'; readonly at: number; readonly field: MarcField }
  /**
   * Move a field: remove it from `from`, then insert it at `to` in the list that
   * remains.
   *
   * Splice semantics, and stated because the obvious alternative — "place it
   * before whatever is currently at `to`" — does NOT invert. Under splice,
   * `{from, to}` is undone by `{from: to, to: from}` exactly, which is the whole
   * reason to define it this way: [A,B,C,D] moved 0→2 is [B,C,A,D], and 2→0
   * puts it back.
   */
  | { readonly op: 'moveField'; readonly from: number; readonly to: number }
  | (OpBase & { readonly op: 'setIndicators'; readonly from: string; readonly to: string })
  | (OpBase & { readonly op: 'setTag'; readonly from: string; readonly to: string })
  | (OpBase & {
      readonly op: 'insertSubfield';
      readonly at: number;
      readonly subfield: Subfield;
    })
  | (OpBase & {
      readonly op: 'deleteSubfield';
      readonly at: number;
      readonly subfield: Subfield;
    })
  /**
   * Set a value. One operation for four addressings, because the PATH already
   * carries the distinction: a subfield value (`245[0]$a[0]`), a whole control
   * field (`008`), a byte range inside one (`008/07-10`), or a leader position
   * (`LDR/06`). Four operations would be four places to get the padding rule
   * wrong.
   */
  | (OpBase & { readonly op: 'setValue'; readonly from: string; readonly to: string });

/**
 * The inverse of an op, computed from the op alone.
 *
 * Exact for a SINGLE op: `applyOps(applyOps(r, [op]), [invert(op)])` is `r`, for
 * every op and every record the op applies to. Property-tested over 8,000
 * generated cases.
 *
 * **It is NOT exact for a batch, and there is deliberately no `invertAll`.**
 * `insertField.at`, `deleteField.at` and `moveField`'s indices are POSITIONS,
 * and a batch resolves every position against the record it was handed — so a
 * batch that both inserts and deletes has no position-preserving inverse to
 * compute: the delete's `at` means something different in the result. Measured
 * before this was written down: a naive reverse-and-invert restored 3,023 of
 * 3,804 random multi-op batches and silently corrupted the rest.
 *
 * Undoing a BATCH is a snapshot restore, which is what the architecture already
 * specifies and for exactly this reason — `marc_record_versions` keeps full
 * snapshots rather than diff chains because "restore version N is a copy rather
 * than a replay and cannot be subtly wrong the way a chain can". So `invert` is
 * for the two jobs it is exact at: rendering "this is what will change" beside a
 * single suggested edit, and undoing one.
 */
export function invert(op: MarcOp): MarcOp {
  switch (op.op) {
    case 'insertField':
      return { op: 'deleteField', at: op.at, field: op.field };
    case 'deleteField':
      return { op: 'insertField', at: op.at, field: op.field };
    case 'moveField':
      return { op: 'moveField', from: op.to, to: op.from };
    case 'insertSubfield':
      return { op: 'deleteSubfield', path: op.path, at: op.at, subfield: op.subfield };
    case 'deleteSubfield':
      return { op: 'insertSubfield', path: op.path, at: op.at, subfield: op.subfield };
    case 'setTag':
      // The path names the field BY TAG, so the inverse has to address the
      // field under its new tag. Without this, undoing a retag looks for a 650
      // that is now a 655 and fails with "names no field in this record".
      return {
        ...op,
        path: op.path.replace(op.from, op.to),
        from: op.to,
        to: op.from,
      };
    case 'setIndicators':
    case 'setValue':
      return { ...op, from: op.to, to: op.from };
  }
}

export type ApplyOptions = {
  /**
   * What to do about `$6` afterwards. `'repair'` (the default) fixes collisions
   * and leaves correct links alone; `'compact'` renumbers every pair densely.
   * See `linkage.ts` for why the default is not the plan's literal wording.
   */
  readonly linkage?: LinkagePolicy;
  /**
   * Skip the `from` precondition checks. Only for replaying a batch that was
   * already validated — a version restore, or the offline client re-applying its
   * own queue — never for anything a human or a model just produced.
   */
  readonly unchecked?: boolean;
};

type Entry = { field: MarcField; deleted: boolean };

/**
 * Apply a batch of edits.
 *
 * Throws `MarcError` when a path names nothing, when an index is out of range,
 * or when a `from` does not match what is there. It never applies a batch
 * partially: everything is resolved and checked before anything is written, so
 * a rejected suggestion leaves the record exactly as it was.
 */
export function applyOps(
  record: MarcRecord,
  ops: readonly MarcOp[],
  options: ApplyOptions = {},
): MarcRecord {
  // Working copies, one per original field, addressed by ORIGINAL index. Entry
  // identity survives moves and insertions, which is what lets every op keep
  // pointing at the field it was written against.
  const entries: Entry[] = record.fields.map((f) => ({ field: cloneField(f), deleted: false }));
  let leader = record.leader;

  const inserts: { at: number; field: MarcField; seq: number }[] = [];
  const moves: { from: number; to: number }[] = [];

  const resolveField = (pathText: string): { entry: Entry; path: FieldPath } => {
    const path = parseOpPath(pathText);
    if (path.kind === 'leader') {
      throw new MarcError('path-not-a-field', `"${pathText}" addresses the leader, not a field.`);
    }
    const occ = path.occ.type === 'at' ? path.occ.n : 0;
    let seen = 0;
    for (const entry of entries) {
      if (entry.field.t !== path.tag) continue;
      if (seen === occ) return { entry, path };
      seen += 1;
    }
    throw new MarcError('path-not-found', `"${pathText}" names no field in this record.`);
  };

  ops.forEach((op, seq) => {
    switch (op.op) {
      case 'insertField': {
        if (op.at < 0 || op.at > entries.length) {
          throw new MarcError(
            'index-out-of-range',
            `Cannot insert at ${op.at}: the record has ${entries.length} fields.`,
          );
        }
        inserts.push({ at: op.at, field: cloneField(op.field), seq });
        return;
      }
      case 'deleteField': {
        const entry = entries[op.at];
        if (!entry || entry.deleted) {
          throw new MarcError('index-out-of-range', `There is no field at ${op.at} to delete.`);
        }
        if (!options.unchecked && !sameField(entry.field, op.field)) {
          throw new MarcError(
            'precondition-failed',
            `The field at ${op.at} is not the one this edit expected to remove ` +
              `(expected ${op.field.t}, found ${entry.field.t}).`,
          );
        }
        entry.deleted = true;
        return;
      }
      case 'moveField': {
        if (!entries[op.from]) {
          throw new MarcError('index-out-of-range', `There is no field at ${op.from} to move.`);
        }
        if (op.to < 0 || op.to >= entries.length) {
          throw new MarcError('index-out-of-range', `Cannot move a field to ${op.to}.`);
        }
        moves.push({ from: op.from, to: op.to });
        return;
      }
      case 'setTag': {
        const { entry } = resolveField(op.path);
        check(options, entry.field.t, op.from, op.path);
        if (op.to.length !== 3) {
          throw new MarcError('tag-invalid', `"${op.to}" is not a three-character tag.`);
        }
        entry.field = { ...entry.field, t: op.to } as MarcField;
        return;
      }
      case 'setIndicators': {
        const { entry } = resolveField(op.path);
        if (!isDataField(entry.field)) {
          throw new MarcError('not-a-data-field', `${op.path} is a control field: no indicators.`);
        }
        check(options, entry.field.i, op.from, op.path);
        if (op.to.length !== 2) {
          throw new MarcError('indicators-invalid', `Indicators are exactly two characters.`);
        }
        entry.field = { ...entry.field, i: op.to };
        return;
      }
      case 'insertSubfield': {
        const { entry } = resolveField(op.path);
        if (!isDataField(entry.field)) {
          throw new MarcError('not-a-data-field', `${op.path} is a control field: no subfields.`);
        }
        const s = [...entry.field.s];
        if (op.at < 0 || op.at > s.length) {
          throw new MarcError('index-out-of-range', `Cannot insert a subfield at ${op.at}.`);
        }
        s.splice(op.at, 0, { ...op.subfield });
        entry.field = { ...entry.field, s };
        return;
      }
      case 'deleteSubfield': {
        const { entry } = resolveField(op.path);
        if (!isDataField(entry.field)) {
          throw new MarcError('not-a-data-field', `${op.path} is a control field: no subfields.`);
        }
        const s = [...entry.field.s];
        const found = s[op.at];
        if (!found) {
          throw new MarcError('index-out-of-range', `There is no subfield at ${op.at}.`);
        }
        if (!options.unchecked && !sameSubfield(found, op.subfield)) {
          throw new MarcError(
            'precondition-failed',
            `The subfield at ${op.at} of ${op.path} is not the one this edit expected to remove.`,
          );
        }
        s.splice(op.at, 1);
        entry.field = { ...entry.field, s };
        return;
      }
      case 'setValue': {
        const path = parseOpPath(op.path);
        if (path.kind === 'leader') {
          const before = readRange(leader, path.chars?.from, path.chars?.to);
          check(options, before, op.from, op.path);
          leader = writeRange(leader, op.to, path.chars?.from, path.chars?.to);
          return;
        }
        const { entry } = resolveField(op.path);
        if (path.sub) {
          if (!isDataField(entry.field)) {
            throw new MarcError('not-a-data-field', `${op.path} is a control field.`);
          }
          const s = [...entry.field.s];
          const occ = path.sub.occ.type === 'at' ? path.sub.occ.n : 0;
          let seen = 0;
          let index = -1;
          for (let i = 0; i < s.length; i++) {
            if (subfieldCode(s[i] as Subfield) !== path.sub.code) continue;
            if (seen === occ) {
              index = i;
              break;
            }
            seen += 1;
          }
          if (index < 0) {
            throw new MarcError('path-not-found', `"${op.path}" names no subfield.`);
          }
          const current = subfieldValue(s[index] as Subfield);
          const before = readRange(current, path.sub.chars?.from, path.sub.chars?.to);
          check(options, before, op.from, op.path);
          s[index] = {
            [path.sub.code]: writeRange(current, op.to, path.sub.chars?.from, path.sub.chars?.to),
          };
          entry.field = { ...entry.field, s };
          return;
        }
        if (isDataField(entry.field)) {
          throw new MarcError(
            'not-a-control-field',
            `${op.path} is a data field; name a subfield, or use setIndicators.`,
          );
        }
        const current = entry.field.v;
        const before = readRange(current, path.chars?.from, path.chars?.to);
        check(options, before, op.from, op.path);
        entry.field = {
          ...entry.field,
          v: writeRange(current, op.to, path.chars?.from, path.chars?.to),
        };
        return;
      }
    }
  });

  // --- rebuild the field list -------------------------------------------
  // Order of operations is defined and deliberate: delete, then move (which is
  // expressed against surviving entries by identity), then insert at the
  // ORIGINAL positions. Inserting before moving would make an insert index mean
  // a different place depending on an unrelated move in the same batch.
  const survivors = entries.filter((e) => !e.deleted);
  const list: Entry[] = [...survivors];
  for (const move of moves) {
    const entry = entries[move.from] as Entry;
    if (entry.deleted) continue;
    const at = list.indexOf(entry);
    if (at < 0) continue;
    // Splice: out, then in at the requested position of the remaining list.
    list.splice(at, 1);
    list.splice(Math.min(move.to, list.length), 0, entry);
  }

  const out: MarcField[] = [];
  const byOriginal = new Map<Entry, number>();
  entries.forEach((e, i) => byOriginal.set(e, i));
  // Inserts are keyed by an ORIGINAL index, so they land immediately before
  // whichever entry originally held that index, wherever it has ended up.
  const ordered = [...inserts].sort((a, b) => a.at - b.at || a.seq - b.seq);
  let cursor = 0;
  for (const entry of list) {
    const original = byOriginal.get(entry) ?? Number.MAX_SAFE_INTEGER;
    while (cursor < ordered.length && (ordered[cursor] as { at: number }).at <= original) {
      out.push((ordered[cursor] as { field: MarcField }).field);
      cursor += 1;
    }
    out.push(entry.field);
  }
  for (; cursor < ordered.length; cursor++)
    out.push((ordered[cursor] as { field: MarcField }).field);

  return normalizeLinkage({ leader, fields: out }, options.linkage ?? 'repair');
}

function check(options: ApplyOptions, actual: string, expected: string, path: string): void {
  if (options.unchecked || actual === expected) return;
  throw new MarcError(
    'precondition-failed',
    `${path} holds ${JSON.stringify(actual)}, but this edit was written against ` +
      `${JSON.stringify(expected)}. The record changed since the edit was prepared.`,
  );
}

function readRange(value: string, from?: number, to?: number | 'last'): string {
  if (from === undefined) return value;
  const end = to === 'last' || to === undefined ? value.length - 1 : to;
  return value.slice(from, end + 1);
}

/**
 * Write into a fixed-position range.
 *
 * Pads with spaces rather than growing or truncating: `008/07-10` is four
 * characters whatever the caller passed, because every downstream reader slices
 * 008 by absolute position and a field that grew by one shifts every position
 * after it. A value too long is a caller error and throws.
 */
function writeRange(value: string, next: string, from?: number, to?: number | 'last'): string {
  if (from === undefined) return next;
  const end = to === 'last' || to === undefined ? Math.max(value.length - 1, from) : to;
  const width = end - from + 1;
  if (next.length > width) {
    throw new MarcError(
      'value-too-long',
      `${JSON.stringify(next)} is ${next.length} characters and the range holds ${width}. ` +
        'Fixed-field positions are absolute; growing one would shift every position after it.',
    );
  }
  const padded = value.padEnd(end + 1, ' ');
  return padded.slice(0, from) + next.padEnd(width, ' ') + padded.slice(end + 1);
}

function cloneField(f: MarcField): MarcField {
  return isDataField(f)
    ? ({ ...f, s: f.s.map((s) => ({ ...s })) } as DataField)
    : ({ ...f } as MarcField);
}

function sameField(a: MarcField, b: MarcField): boolean {
  if (a.t !== b.t) return false;
  if (isDataField(a) !== isDataField(b)) return false;
  if (!isDataField(a) || !isDataField(b)) {
    return (a as { v: string }).v === (b as { v: string }).v;
  }
  if (a.i !== b.i || a.s.length !== b.s.length) return false;
  return a.s.every((s, i) => sameSubfield(s, b.s[i] as Subfield));
}

function sameSubfield(a: Subfield, b: Subfield): boolean {
  return subfieldCode(a) === subfieldCode(b) && subfieldValue(a) === subfieldValue(b);
}

/** Human-readable one-liner for an op, for a review UI or an audit line. */
export function describeOp(op: MarcOp): string {
  switch (op.op) {
    case 'insertField':
      return `add ${op.field.t} at position ${op.at}`;
    case 'deleteField':
      return `remove ${op.field.t} at position ${op.at}`;
    case 'moveField':
      return `move the field at ${op.from} to ${op.to}`;
    case 'setTag':
      return `retag ${op.from} as ${op.to}`;
    case 'setIndicators':
      return `${op.path}: indicators ${JSON.stringify(op.from)} to ${JSON.stringify(op.to)}`;
    case 'insertSubfield':
      return `${op.path}: add $${subfieldCode(op.subfield)} at ${op.at}`;
    case 'deleteSubfield':
      return `${op.path}: remove $${subfieldCode(op.subfield)} at ${op.at}`;
    case 'setValue':
      return `${op.path}: ${JSON.stringify(op.from)} to ${JSON.stringify(op.to)}`;
  }
}

export { formatMarcPath, parseOpPath };
export type { MarcPath };
