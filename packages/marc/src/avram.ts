import { MarcError } from './types.js';

/**
 * An Avram-SHAPED format definition, and the layered loader over it.
 *
 * Avram (Jakob Voß / GBV, `format.gbv.de/schema/avram`) is a JSON language for
 * describing a MARC-family format: which fields exist, which repeat, which
 * indicator values are legal, what each fixed-field position means. The 2.0 plan
 * chose it for one reason: **validation is data, not code.** A cataloguing rule
 * that lives in a `switch` statement is a rule only an engineer can change, and
 * every ILS that did it that way has a validator its libraries cannot correct.
 *
 * ## This is a reconstruction, and it says so
 *
 * Neither the Avram specification nor its companion JSON Schema is in this
 * repository, and the session that wrote this had no way to obtain either. The
 * key names below — `fields`, `label`, `repeatable`, `indicator1`, `subfields`,
 * `positions`, `codes`, `deprecated` — are a reconstruction from memory of the
 * language, not a transcription of it. The SHAPE is right; individual spellings
 * may not be.
 *
 * That is survivable because nothing depends on the spelling being Avram's: this
 * is our own file format, read only by this loader. `scripts/gen-marc-schema.ts`
 * is where the two are reconciled the moment somebody vendors the real spec, and
 * `coverage.source` on every committed definition records which it is.
 *
 * ## Two things about the blank indicator
 *
 * MARC documentation writes a blank indicator as `#`, the bytes carry `0x20`,
 * and different Avram files in the wild spell it `" "`, `"#"` or `"_"`. Reading
 * only one spelling would silently reject every blank indicator in a file that
 * used another — a false positive on the single most common indicator value in
 * MARC. {@link normalizeCode} accepts all three and normalises to a space, which
 * is what the record actually holds.
 *
 * ## Open world, deliberately
 *
 * A tag, subfield code or indicator the definition does not mention produces NO
 * issue. That is not laxity, it is MARC 21: the 9XX block and every X9X subfield
 * are reserved for local use and are the normal way a library records what its
 * own system needs. A closed-world validator flags all of them, so the first
 * thing every library does is switch it off.
 *
 * It also makes a PARTIAL definition safe. This repository ships a definition
 * covering the fields it can state with confidence; everything else is simply
 * unconstrained, so an incomplete file produces fewer checks rather than wrong
 * ones. {@link DefinitionCoverage} makes that partiality explicit rather than
 * something a reader has to infer.
 */

/** One allowed value, in an indicator or at a fixed-field position. */
export type AvramCode = {
  readonly label?: string;
  readonly deprecated?: boolean;
};

export type AvramCodes = Readonly<Record<string, AvramCode>>;

export type AvramIndicator = {
  readonly label?: string;
  /** Omitted means "any value" — the field is undefined at that indicator. */
  readonly codes?: AvramCodes;
};

export type AvramSubfield = {
  readonly label?: string;
  readonly repeatable?: boolean;
  readonly required?: boolean;
  readonly deprecated?: boolean;
};

/** A character position or inclusive range inside a fixed field, e.g. `06`, `07-10`. */
export type AvramPosition = {
  readonly label?: string;
  readonly codes?: AvramCodes;
  readonly deprecated?: boolean;
};

export type AvramField = {
  readonly label?: string;
  /**
   * A cap on THIS field's table rules, independent of the schema's.
   *
   * A rule pack and a tenant override are layers with their own provenance: a
   * pack's rules were hand-authored here and must stay warnings even after the
   * BASE definition is regenerated and promoted to `generated`, or the day
   * somebody vendors an authority is the day three hand-written RDA rules start
   * refusing saves. The effective cap is the weaker of this and the schema's.
   */
  readonly confidence?: 'generated' | 'transcribed';
  readonly repeatable?: boolean;
  readonly required?: boolean;
  readonly deprecated?: boolean;
  /** What replaced an obsolete field, for the message. */
  readonly replacedBy?: string;
  readonly indicator1?: AvramIndicator;
  readonly indicator2?: AvramIndicator;
  readonly subfields?: Readonly<Record<string, AvramSubfield>>;
  /** Fixed fields only. Keys are positions or ranges. */
  readonly positions?: Readonly<Record<string, AvramPosition>>;
  /** Total length of a fixed field, when it has one. */
  readonly length?: number;
};

/**
 * A group of fields of which at most one may appear.
 *
 * Not an Avram concept, and it has to exist: MARC 21's rule is that a record has
 * at most ONE main entry, chosen from 100/110/111/130. Each of those four is
 * individually non-repeatable, and a record with a 100 AND a 110 breaks no
 * per-field rule while being unambiguously wrong.
 */
export type AvramGroup = {
  readonly label: string;
  readonly tags: readonly string[];
};

/**
 * How much of the format this file actually describes.
 *
 * Written down because the committed definitions are partial, and a partial
 * definition that does not say so is the dangerous kind: a reader assumes a
 * clean validation means a valid record. `check:marc-schema` asserts this block
 * matches the file's own contents, so it cannot drift into a boast.
 */
export type DefinitionCoverage = {
  /** Where the definition came from, or `hand-authored` when it was written here. */
  readonly source: string;
  /** What is NOT described, in a sentence a reader can act on. */
  readonly limits: string;
  /** Number of field definitions, asserted by the gate against the real count. */
  readonly fieldCount: number;
  /**
   * How much this file's TABLE-DRIVEN rules can be trusted, and therefore the
   * worst thing they may say.
   *
   * A validator's failure mode is a false accusation, and a false accusation is
   * what makes a librarian switch validation off. So a definition transcribed
   * from memory raises WARNINGS for everything it reads out of a table —
   * repeatability, indicator code lists, subfield lists, obsolescence — because
   * a wrong row must never block a save.
   *
   * `'generated'` is for a definition produced by `scripts/gen-marc-schema.ts`
   * from a vendored authority; its table rules are errors. Structural rules are
   * unaffected either way: "an indicator is two characters" comes from the
   * FORMAT, not from a row somebody typed, and is always an error.
   */
  readonly confidence: 'generated' | 'transcribed';
};

export type AvramSchema = {
  readonly title: string;
  readonly description?: string;
  readonly url?: string;
  /** e.g. `marc21/bibliographic`. Names the record kind a definition applies to. */
  readonly profile: string;
  /** The standard's own version, surfaced as `tenants.catalog_schema_version`. */
  readonly version?: string;
  readonly coverage: DefinitionCoverage;
  readonly fields: Readonly<Record<string, AvramField>>;
  readonly groups?: readonly AvramGroup[];
};

/**
 * The blank indicator, as MARC records actually carry it.
 *
 * `#` is how MARC documentation prints it, `_` is how several tools write it in
 * JSON, and `" "` is the byte. All three mean the same thing and a definition
 * may use any of them.
 */
export const BLANK = ' ';

export function normalizeCode(code: string): string {
  return code === '#' || code === '_' || code === '' ? BLANK : code;
}

/** Every code of an indicator, normalised. `null` when the indicator is unconstrained. */
export function allowedCodes(indicator?: AvramIndicator): Set<string> | null {
  if (!indicator?.codes) return null;
  return new Set(Object.keys(indicator.codes).map(normalizeCode));
}

/**
 * Parse a position key — `'06'` or `'07-10'` — into an inclusive range.
 *
 * Throws rather than guessing: a malformed key in a committed definition is a
 * file that has to be fixed, and silently skipping it would make the position
 * unchecked with nothing to say so.
 */
export function parsePositionKey(key: string): { from: number; to: number } {
  const m = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(key);
  if (!m) {
    throw new MarcError(
      'avram-position-invalid',
      `"${key}" is not a character position or range. Positions are written "06" or "07-10".`,
    );
  }
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (to < from) {
    throw new MarcError('avram-position-invalid', `Position range "${key}" ends before it starts.`);
  }
  return { from, to };
}

// ---------------------------------------------------------------------------
// The layered loader
// ---------------------------------------------------------------------------

/**
 * A tenant's changes to a shipped definition.
 *
 * A library that catalogues music adds `$n` to a field the shipped definition
 * does not list; a library with a local practice marks a field required. Both
 * are ordinary, and both must survive the next release of the shipped
 * definition — so an override is a PATCH, never a replacement.
 */
export type AvramOverride = {
  /** Merged field by field. A `null` value removes the shipped field's rule entirely. */
  readonly fields?: Readonly<Record<string, AvramField | null>>;
  readonly groups?: readonly AvramGroup[];
};

/**
 * Apply a tenant's override to a shipped definition.
 *
 * Field-level merge, not whole-file replacement, and the difference matters on
 * the day the shipped definition is updated: a library that had replaced the
 * file would keep an eight-year-old MARC 21 forever, and would find out when a
 * new subfield started reading as invalid. Merging means they keep exactly their
 * own decisions and inherit everything else.
 *
 * Within a field the merge is shallow per section — `subfields` and `positions`
 * merge key by key, so overriding one subfield does not delete the other forty.
 */
export function applyOverride(base: AvramSchema, override?: AvramOverride): AvramSchema {
  if (!override?.fields && !override?.groups) return base;
  const fields: Record<string, AvramField> = { ...base.fields };

  for (const [tag, patch] of Object.entries(override.fields ?? {})) {
    if (patch === null) {
      delete fields[tag];
      continue;
    }
    const shipped = fields[tag];
    if (!shipped) {
      fields[tag] = patch;
      continue;
    }
    fields[tag] = {
      ...shipped,
      ...patch,
      ...(shipped.subfields || patch.subfields
        ? { subfields: { ...shipped.subfields, ...patch.subfields } }
        : {}),
      ...(shipped.positions || patch.positions
        ? { positions: { ...shipped.positions, ...patch.positions } }
        : {}),
    };
  }

  return {
    ...base,
    fields,
    ...(override.groups ? { groups: override.groups } : {}),
    coverage: {
      ...base.coverage,
      source: `${base.coverage.source} + tenant override`,
      fieldCount: Object.keys(fields).length,
    },
  };
}

/**
 * Check a definition's shape at load time.
 *
 * Committed definitions are JSON, so nothing typechecks them — a misspelled key
 * would simply mean an unenforced rule, which is exactly the failure a
 * data-driven validator is prone to and exactly what nobody would notice.
 * `check:marc-schema` runs this over every committed file.
 */
export function validateSchema(schema: AvramSchema): string[] {
  const problems: string[] = [];
  if (!schema.title) problems.push('title is required.');
  if (!schema.profile) problems.push('profile is required, e.g. "marc21/bibliographic".');
  if (!schema.coverage) {
    problems.push('coverage is required — a partial definition must say so.');
  } else if (
    schema.coverage.confidence !== 'generated' &&
    schema.coverage.confidence !== 'transcribed'
  ) {
    problems.push(
      'coverage.confidence must be "generated" or "transcribed". It decides whether a rule read ' +
        'out of a table may block a save, so it cannot be left unsaid.',
    );
  }
  if (!schema.fields || typeof schema.fields !== 'object') {
    problems.push('fields is required.');
    return problems;
  }

  const actual = Object.keys(schema.fields).length;
  if (schema.coverage && schema.coverage.fieldCount !== actual) {
    problems.push(
      `coverage.fieldCount says ${schema.coverage.fieldCount} but the file defines ${actual}. ` +
        'That number is what stops a coverage note drifting into a boast.',
    );
  }

  for (const [tag, field] of Object.entries(schema.fields)) {
    const where = `field ${tag}`;
    if (!/^[0-9A-Za-z]{3}$/.test(tag) && tag !== 'LDR') {
      problems.push(`${where}: a tag is three characters, or LDR.`);
    }
    if (field.positions && field.subfields) {
      problems.push(`${where}: a field has positions or subfields, never both.`);
    }
    if (field.positions) {
      for (const key of Object.keys(field.positions)) {
        try {
          const { to } = parsePositionKey(key);
          if (field.length !== undefined && to >= field.length) {
            problems.push(
              `${where}: position ${key} runs past the declared length ${field.length}.`,
            );
          }
        } catch (err) {
          problems.push(`${where}: ${(err as Error).message}`);
        }
      }
    }
    for (const [code, sub] of Object.entries(field.subfields ?? {})) {
      if (code.length !== 1)
        problems.push(`${where}: subfield code "${code}" is not one character.`);
      if (sub === null || typeof sub !== 'object') {
        problems.push(`${where} $${code}: a subfield definition is an object.`);
      }
    }
    for (const [name, indicator] of [
      ['indicator1', field.indicator1],
      ['indicator2', field.indicator2],
    ] as const) {
      for (const code of Object.keys(indicator?.codes ?? {})) {
        if (normalizeCode(code).length !== 1) {
          problems.push(`${where} ${name}: "${code}" is not a single indicator value.`);
        }
      }
    }
  }

  for (const group of schema.groups ?? []) {
    if (group.tags.length < 2) problems.push(`group "${group.label}" needs at least two tags.`);
    for (const tag of group.tags) {
      if (!schema.fields[tag]) {
        problems.push(`group "${group.label}" names ${tag}, which the definition does not define.`);
      }
    }
  }

  return problems;
}

/** Load a definition, refusing a malformed one rather than half-applying it. */
export function loadSchema(raw: unknown, override?: AvramOverride): AvramSchema {
  const schema = raw as AvramSchema;
  const problems = validateSchema(schema);
  if (problems.length) {
    throw new MarcError(
      'avram-invalid',
      `This format definition cannot be used:\n  ${problems.join('\n  ')}`,
    );
  }
  return applyOverride(schema, override);
}
