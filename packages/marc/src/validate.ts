import {
  allowedCodes,
  normalizeCode,
  parsePositionKey,
  type AvramField,
  type AvramSchema,
} from './avram.js';
import {
  RULE,
  blocks,
  subtractIssues,
  type IssueDelta,
  type IssueSeverity,
  type ValidationIssue,
} from './issues.js';
import {
  isDataField,
  subfieldCode,
  subfieldValue,
  type DataField,
  type MarcField,
  type MarcRecord,
} from './types.js';

/**
 * The validator: a MARC record measured against an Avram definition.
 *
 * Every rule here is driven by the definition. There is deliberately no
 * `if (tag === '245')` anywhere in this file — a cataloguing rule that lives in
 * code is a rule only an engineer can change, and the point of choosing Avram
 * was that a library can correct its own validator.
 *
 * ## It is open-world, and that is the difference between a validator libraries
 * use and one they switch off
 *
 * A tag, subfield code or indicator the definition does not mention produces no
 * issue at all. MARC 21 reserves the whole 9XX block and every X9X subfield for
 * local use, and using them is ordinary practice, not an error. A closed-world
 * validator flags a library's own local fields on every save, which is how
 * cataloguers learn that the validator is the enemy.
 *
 * It also makes the shipped definition's partiality safe: an undescribed field
 * is unconstrained rather than wrong, so a definition that covers less produces
 * fewer checks rather than false ones.
 *
 * ## Two kinds of rule, and only one of them can block a save
 *
 * **Structural** rules come from the FORMAT: an indicator is two characters, a
 * fixed field is its declared length, a control field has no subfields. They
 * cannot be wrong because somebody mistyped a row, so they are always errors.
 *
 * **Table-driven** rules come from the definition's own data: which fields
 * repeat, which indicator values are legal, which subfields exist, what is
 * obsolete. Their severity is capped by `coverage.confidence` — a definition
 * transcribed from memory raises WARNINGS for all of them.
 *
 * That cap is the whole answer to a validator's characteristic failure. A codec
 * that is wrong corrupts data; a validator that is wrong makes a FALSE
 * ACCUSATION, and a librarian who cannot save a correct record because of one
 * switches validation off — after which it protects nothing. A transcribed rule
 * that turns out to be wrong therefore costs a spurious warning, never a
 * refused save.
 *
 * A few rules are softer still and are warnings whatever the confidence: an
 * obsolete field (a record catalogued in 1998 under AACR2 is history, not a
 * mistake, and importing it is the point), and a subfield the definition does
 * not list on a field it does, which is at least as likely to be a gap in the
 * file as a fault in the record.
 *
 * ## The result says what it did NOT check
 *
 * "No issues" from a definition that describes eight tags is a lie of omission,
 * and it is the lie that would make this whole phase worse than nothing. So
 * {@link validate} returns the tags it had no rules for alongside the issues it
 * found, and a caller that shows a green tick without showing
 * {@link ValidationReport.uncheckedTags} is misreporting.
 */

export type ValidateOptions = {
  /**
   * Stop after this many issues. A record that has gone badly wrong can produce
   * thousands, and neither a cataloguer nor an import report is served by all of
   * them.
   */
  readonly limit?: number;
};

const DEFAULT_LIMIT = 500;

export type ValidationReport = {
  readonly issues: readonly ValidationIssue[];
  /**
   * Tags present in the record that the definition says nothing about.
   *
   * Not a fault — MARC reserves 9XX and X9X for local use and a partial
   * definition is deliberate — but the difference between "this record is
   * clean" and "these eleven fields were never examined" is the difference
   * between a report and a reassurance.
   */
  readonly uncheckedTags: readonly string[];
  /** Carried through so a caller can say what the issues are worth. */
  readonly confidence: 'generated' | 'transcribed';
  /** True when the issue limit was reached and issues were dropped. */
  readonly truncated: boolean;
};

/** Subfield codes never flagged as unlisted, whatever the definition says. */
const LOCAL_SUBFIELD_CODES = new Set(['9']);

/**
 * Validate a whole record.
 *
 * Never throws for a bad record — a record is data, and refusing to describe
 * what is wrong with it is the one thing a validator must not do. It throws only
 * when the DEFINITION is unusable, which is a deployment fault.
 */
export function validate(
  record: MarcRecord,
  schema: AvramSchema,
  options: ValidateOptions = {},
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const limit = options.limit ?? DEFAULT_LIMIT;
  let truncated = false;
  const add = (issue: ValidationIssue): void => {
    if (issues.length < limit) issues.push(issue);
    else truncated = true;
  };
  // A rule read out of the definition's tables may not exceed the confidence
  // declared for it — the weaker of the field's own and the schema's. See this
  // module's header, and `AvramField.confidence` for why a field has one.
  const severityFor = (def?: { confidence?: 'generated' | 'transcribed' }): IssueSeverity =>
    schema.coverage.confidence === 'generated' && def?.confidence !== 'transcribed'
      ? 'error'
      : 'warning';
  const table: IssueSeverity = severityFor();

  // --- the leader -------------------------------------------------------
  const leaderDef = schema.fields.LDR;
  if (leaderDef) checkFixed('LDR', record.leader, leaderDef, undefined, add, table);

  // --- counts, for the record-level rules --------------------------------
  const byTag = new Map<string, MarcField[]>();
  for (const field of record.fields) {
    const list = byTag.get(field.t) ?? [];
    list.push(field);
    byTag.set(field.t, list);
  }

  for (const [tag, fields] of byTag) {
    const def = schema.fields[tag];
    if (!def) continue; // open world
    if (def.repeatable === false && fields.length > 1) {
      add({
        rule: RULE.fieldNotRepeatable,
        severity: severityFor(def),
        message: `${tag} may appear only once in a record; this record has ${fields.length}.`,
        at: { tag },
      });
    }
  }

  for (const [tag, def] of Object.entries(schema.fields)) {
    if (tag === 'LDR') continue;
    if (def.required && !byTag.has(tag)) {
      add({
        rule: RULE.fieldMissing,
        severity: severityFor(def),
        message: `${tag}${def.label ? ` (${def.label})` : ''} is required and is not in this record.`,
        at: { tag },
      });
    }
  }

  for (const group of schema.groups ?? []) {
    const present = group.tags.filter((tag) => byTag.has(tag));
    if (present.length > 1) {
      add({
        rule: RULE.groupNotRepeatable,
        severity: table,
        // Named in tag order so the message is the same however the record is
        // ordered — it is part of nothing, but a stable message is kinder.
        message:
          `A record has at most one ${group.label}, and this one has ${present.length}: ` +
          `${[...present].sort().join(', ')}.`,
        at: { tag: present.sort()[0] as string },
      });
    }
  }

  // --- field by field ----------------------------------------------------
  const unchecked = new Set<string>();
  const seen = new Map<string, number>();
  for (const field of record.fields) {
    const occurrence = (seen.get(field.t) ?? 0) + 1;
    seen.set(field.t, occurrence);
    const def = schema.fields[field.t];
    if (!def) {
      unchecked.add(field.t); // open world, and said out loud
      continue;
    }

    if (def.deprecated) {
      add({
        rule: RULE.fieldObsolete,
        severity: 'warning',
        message:
          `${field.t}${def.label ? ` (${def.label})` : ''} is obsolete in this format` +
          `${def.replacedBy ? `; ${def.replacedBy} replaced it` : ''}.`,
        at: { tag: field.t, occurrence },
      });
    }

    const wantsFixed = Boolean(def.positions) || def.length !== undefined;
    if (wantsFixed && isDataField(field)) {
      add({
        rule: RULE.fieldKindMismatch,
        severity: 'error',
        message: `${field.t} is a fixed field, but this record holds it with indicators and subfields.`,
        at: { tag: field.t, occurrence },
      });
      continue;
    }
    if (!wantsFixed && def.subfields && !isDataField(field)) {
      add({
        rule: RULE.fieldKindMismatch,
        severity: 'error',
        message: `${field.t} takes subfields, but this record holds it as a control field.`,
        at: { tag: field.t, occurrence },
      });
      continue;
    }

    if (!isDataField(field)) {
      checkFixed(field.t, field.v, def, occurrence, add, severityFor(def));
      continue;
    }
    checkDataField(field, def, occurrence, add, severityFor(def));
  }

  return {
    issues,
    uncheckedTags: [...unchecked].sort(),
    confidence: schema.coverage.confidence,
    truncated,
  };
}

function checkFixed(
  tag: string,
  value: string,
  def: AvramField,
  occurrence: number | undefined,
  add: (issue: ValidationIssue) => void,
  table: IssueSeverity,
): void {
  if (def.length !== undefined && value.length !== def.length) {
    add({
      rule: RULE.fixedFieldLength,
      // `length` is read out of the definition like any other row, so it is
      // capped like any other row. "008 is 40 characters" is a format fact, but
      // the number in the file is still a number somebody typed.
      severity: table,
      message: `${tag} must be exactly ${def.length} characters; this one is ${value.length}.`,
      at: { tag, ...(occurrence ? { occurrence } : {}) },
      subject: String(value.length),
    });
    // Positions are read by absolute offset, so checking them against a
    // wrong-length value would produce a cascade of issues about one fault.
    return;
  }

  for (const [key, position] of Object.entries(def.positions ?? {})) {
    const { from, to } = parsePositionKey(key);
    if (to >= value.length) continue; // nothing there to check
    const codes = position.codes;
    if (!codes) continue;
    const held = value.slice(from, to + 1);
    const allowed = new Set(Object.keys(codes).map(normalizeCode));
    if (allowed.has(normalizeCode(held))) continue;
    add({
      rule: RULE.positionNotAllowed,
      // A position code list is table-driven, but it is never worth blocking a
      // save over: 008 is full of legitimate `|` fill characters and local
      // practice, and this is the rule most likely to be incompletely
      // transcribed.
      severity: 'warning',
      message:
        `${tag}/${key}${position.label ? ` (${position.label})` : ''} holds ` +
        `${JSON.stringify(held)}, which is not one of its defined values.`,
      at: { tag, ...(occurrence ? { occurrence } : {}), position: key },
      subject: held,
    });
  }
}

function checkDataField(
  field: DataField,
  def: AvramField,
  occurrence: number,
  add: (issue: ValidationIssue) => void,
  table: IssueSeverity,
): void {
  const at = { tag: field.t, occurrence };

  if (field.i.length !== 2) {
    // Phase 7's reader normalises indicators to two characters, so a record can
    // only arrive here this way from MARCXML, from MARC-in-JSON, or from an
    // editor — which is exactly why it is checked rather than assumed.
    add({
      rule: RULE.indicatorMalformed,
      severity: 'error',
      message: `${field.t} has ${field.i.length} indicator characters; MARC 21 fixes it at two.`,
      at,
      subject: String(field.i.length),
    });
  } else {
    for (const [n, indicator] of [
      [1, def.indicator1],
      [2, def.indicator2],
    ] as const) {
      const allowed = allowedCodes(indicator);
      if (!allowed) continue; // undefined indicator: open world
      const held = normalizeCode(field.i[n - 1] as string);
      if (allowed.has(held)) continue;
      add({
        rule: RULE.indicatorNotAllowed,
        severity: table,
        message:
          `${field.t} indicator ${n}${indicator?.label ? ` (${indicator.label})` : ''} holds ` +
          `${held === ' ' ? 'a blank' : JSON.stringify(held)}, which is not one of its ` +
          `defined values: ${describeCodes(allowed)}.`,
        at,
        // The indicator VALUE, not the field. A cataloguer fixing a typo in
        // `$a` must not be blocked by this pre-existing fault.
        subject: `${n}${held}`,
      });
    }
  }

  if (!field.s.length) {
    add({
      rule: RULE.dataFieldEmpty,
      severity: 'error',
      message: `${field.t} has indicators but no subfields.`,
      at,
    });
    return;
  }

  const counts = new Map<string, number>();
  for (const sf of field.s) {
    const code = subfieldCode(sf);
    const codeOccurrence = (counts.get(code) ?? 0) + 1;
    counts.set(code, codeOccurrence);
    const subDef = def.subfields?.[code];

    if (!subDef) {
      // Only meaningful when the definition describes this field's subfields at
      // all, and never for a local-use code.
      if (def.subfields && !LOCAL_SUBFIELD_CODES.has(code)) {
        add({
          rule: RULE.subfieldNotAllowed,
          severity: 'warning',
          message: `${field.t} $${code} is not one of the subfields defined for this field.`,
          at: { ...at, code, codeOccurrence },
          subject: code,
        });
      }
      continue;
    }

    if (subDef.deprecated) {
      add({
        rule: RULE.subfieldObsolete,
        severity: 'warning',
        message: `${field.t} $${code}${subDef.label ? ` (${subDef.label})` : ''} is obsolete.`,
        at: { ...at, code, codeOccurrence },
        subject: code,
      });
    }
    if (subDef.repeatable === false && codeOccurrence === 2) {
      add({
        rule: RULE.subfieldNotRepeatable,
        severity: table,
        message: `${field.t} $${code} may appear only once in a field.`,
        at: { ...at, code },
        subject: code,
      });
    }
    void subfieldValue(sf);
  }

  for (const [code, subDef] of Object.entries(def.subfields ?? {})) {
    if (!subDef.required || counts.has(code)) continue;
    add({
      rule: RULE.subfieldMissing,
      severity: table,
      message: `${field.t} requires $${code}${subDef.label ? ` (${subDef.label})` : ''}.`,
      at: { ...at, code },
      subject: code,
    });
  }
}

/** The allowed values, as a person reads them. */
function describeCodes(codes: ReadonlySet<string>): string {
  return [...codes]
    .sort()
    .map((c) => (c === ' ' ? 'blank' : JSON.stringify(c)))
    .join(', ');
}

// ---------------------------------------------------------------------------
// The asymmetric part
// ---------------------------------------------------------------------------

/**
 * What a write should DO about issues it introduced.
 *
 * Named here rather than in phase 10 so the write path inherits it instead of
 * inventing it, and because the modes are a property of validation rather than
 * of storage. `'block'` is the default and the only one a cataloguer's save
 * uses. The others exist for the paths that must not be refused:
 *
 *   - the phase-19/20 cutover, which copies a whole 1.0 catalogue forward and
 *     cannot stop on the first record that was already wrong;
 *   - phase 35's migration adapters, importing an ABEKT or Koha export whose
 *     faults are the reason it is being migrated;
 *   - phase 30's copy-cataloguing overlay and phase 37's batch undo, which
 *     restore a state that was previously stored and must be restorable.
 *
 * `'record'` writes the issues and flags the record for review rather than
 * refusing it, which is what `marc_records.needs_review` is for.
 */
export type ValidationMode = 'block' | 'warn' | 'record';

export type DeltaResult = IssueDelta & {
  /** Introduced ERRORS. Empty means the write may proceed. */
  readonly blocking: readonly ValidationIssue[];
  /** The full report on the new record, so a caller can show coverage too. */
  readonly after: ValidationReport;
};

/**
 * Validate an edit rather than a record.
 *
 * Returns what the edit introduced, what it resolved, and what it left alone —
 * and only the introduced errors may stop a save. Without that asymmetry a
 * legacy AACR2 record with one illegal indicator becomes permanently
 * uneditable: every save is refused for a fault nobody in the building created,
 * and the librarian's only remaining move is to switch validation off, at which
 * point it protects nothing.
 *
 * Synchronous and pure, because phase 10's write path calls it inside a database
 * transaction — between `applyOps` and the version write — and an await there
 * would hold a row lock across an I/O boundary for no reason.
 *
 * `before` may be null for a record being created: everything its first version
 * contains was introduced by whoever is creating it.
 */
export function validateDelta(
  before: MarcRecord | null,
  after: MarcRecord,
  schema: AvramSchema,
  options: ValidateOptions = {},
): DeltaResult {
  // The limit is applied to the RESULT, never to either side.
  //
  // Limiting each side first is the obvious implementation and it is wrong in
  // the one direction that matters: a `before` truncated at 500 issues drops
  // pre-existing faults from the subtraction, so they reappear as INTRODUCED and
  // block a save the edit had nothing to do with — on exactly the ruined record
  // where the amnesty matters most. Both sides are validated whole; the cap is
  // spent on what is reported.
  const unlimited = { limit: Number.MAX_SAFE_INTEGER };
  const beforeReport = before ? validate(before, schema, unlimited) : null;
  const afterReport = validate(after, schema, unlimited);
  const delta = subtractIssues(beforeReport?.issues ?? [], afterReport.issues);
  const limit = options.limit ?? DEFAULT_LIMIT;
  // Introduced first: those are the ones a caller acts on.
  const introduced = delta.introduced.slice(0, limit);
  return {
    introduced,
    resolved: delta.resolved.slice(0, limit),
    preexisting: delta.preexisting.slice(0, Math.max(limit - introduced.length, 0)),
    blocking: blocks(delta),
    after: { ...afterReport, issues: afterReport.issues.slice(0, limit) },
  };
}

export { RULE, blocks, describeIssue, issueKey, subtractIssues } from './issues.js';
export type { IssueDelta, IssueSeverity, RuleId, ValidationIssue } from './issues.js';
