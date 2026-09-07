import type { AvramSchema } from './avram.js';
import { EMPTY_LEADER, type MarcField, type MarcRecord } from './types.js';

/**
 * Cataloguing templates — the record a cataloguer starts from.
 *
 * A template is the answer to "I am about to catalogue a book": a leader with
 * the right type and level, an 008 of the right shape, and the fields somebody
 * is expected to fill in, in the order they are usually filled. It is not
 * validation and it is not a rule; it is a starting point, and getting it right
 * is most of what makes cataloguing in a new system tolerable.
 *
 * Phase 9 gives every library its own in `catalog_templates`. These are the ones
 * this build ships, as data, and they are what `check:marc-schema` measures:
 * **a template may only bind a tag its definition defines.** A template offering
 * a field the validator knows nothing about is a form that invites a cataloguer
 * to fill in something nothing will ever check — which is worse than not
 * offering it, because it looks supported.
 */

export type TemplateField = {
  readonly tag: string;
  /** Indicators to start with, as the two characters the record carries. */
  readonly i?: string;
  /** Subfield codes to lay out, in order, each empty. */
  readonly codes?: readonly string[];
  /** A fixed-field value to start from. */
  readonly v?: string;
  /** Shown beside the field in the editor. */
  readonly hint?: string;
};

export type CatalogTemplate = {
  readonly id: string;
  readonly label: string;
  readonly profile: string;
  /** The leader this material starts from — 24 characters. */
  readonly leader: string;
  readonly fields: readonly TemplateField[];
};

/**
 * A starting 008: blanks, with the fill character `|` at every position the
 * shipped definition constrains.
 *
 * `|` means "no attempt to code" and is exactly what an unfilled position is. A
 * template full of blanks would start every new record with a validation
 * warning, which teaches a cataloguer on their first day that the warnings do
 * not mean anything.
 */
function startingFixedField(length: number, fill: readonly number[]): string {
  const out = new Array<string>(length).fill(' ');
  for (const at of fill) out[at] = '|';
  return out.join('');
}

const STARTING_008 = startingFixedField(40, [6, 38, 39]);

/**
 * The shipped templates.
 *
 * Two, not twenty. Each one binds only tags the shipped definition describes —
 * that is the gate's rule, and it also bounds how much can be got wrong: a
 * template for a material whose 008 layout this build cannot validate would be
 * offering a form it cannot check.
 */
export const SHIPPED_TEMPLATES: readonly CatalogTemplate[] = [
  {
    id: 'book',
    label: 'Book',
    profile: 'marc21/bibliographic',
    // Leader/06 'a' language material, /07 'm' monograph.
    leader: '00000nam a2200000 a 4500',
    fields: [
      { tag: '008', v: STARTING_008, hint: 'Dates, place, language and cataloguing source.' },
      { tag: '020', i: '  ', codes: ['a'], hint: 'ISBN.' },
      {
        tag: '100',
        i: '1 ',
        codes: ['a', 'd'],
        hint: 'Author, surname first. Leave out for a title main entry.',
      },
      {
        tag: '245',
        i: '10',
        codes: ['a', 'b', 'c'],
        hint: 'Indicator 2 counts the characters to skip when filing.',
      },
      { tag: '250', i: '  ', codes: ['a'] },
      { tag: '264', i: ' 1', codes: ['a', 'b', 'c'], hint: 'Place, publisher, date.' },
      { tag: '300', i: '  ', codes: ['a', 'b', 'c'] },
      { tag: '500', i: '  ', codes: ['a'] },
      {
        tag: '650',
        i: ' 0',
        codes: ['a'],
        hint: 'Indicator 2 says which thesaurus the heading came from.',
      },
      { tag: '700', i: '1 ', codes: ['a', 'e'] },
    ],
  },
  {
    id: 'serial',
    label: 'Serial',
    profile: 'marc21/bibliographic',
    // Leader/07 's' serial.
    leader: '00000nas a2200000 a 4500',
    fields: [
      { tag: '008', v: STARTING_008 },
      { tag: '022', i: '  ', codes: ['a'], hint: 'ISSN.' },
      {
        tag: '245',
        i: '00',
        codes: ['a', 'b'],
        hint: 'A serial usually has a title main entry, so indicator 1 is 0.',
      },
      { tag: '264', i: ' 1', codes: ['a', 'b', 'c'] },
      { tag: '300', i: '  ', codes: ['a'] },
      { tag: '500', i: '  ', codes: ['a'] },
      { tag: '650', i: ' 0', codes: ['a'] },
    ],
  },
];

/** The starting record a template describes. */
export function recordFromTemplate(template: CatalogTemplate): MarcRecord {
  const fields: MarcField[] = template.fields.map((f) =>
    f.v !== undefined
      ? { t: f.tag, v: f.v }
      : {
          t: f.tag,
          i: (f.i ?? '  ').padEnd(2, ' ').slice(0, 2),
          s: (f.codes ?? []).map((c) => ({ [c]: '' })),
        },
  );
  return { leader: template.leader || EMPTY_LEADER, fields };
}

/**
 * Every way a template disagrees with the definition it claims to be for.
 *
 * The gate's rule, and the reason it is a rule: a template that offers a tag the
 * definition does not describe is a form inviting a cataloguer to fill in
 * something nothing will ever check.
 */
export function checkTemplate(template: CatalogTemplate, schema: AvramSchema): string[] {
  const problems: string[] = [];
  if (template.profile !== schema.profile) {
    problems.push(
      `template "${template.id}" is for ${template.profile} and was checked against ${schema.profile}.`,
    );
  }
  if (template.leader.length !== 24) {
    problems.push(`template "${template.id}" has a ${template.leader.length}-character leader.`);
  }
  for (const field of template.fields) {
    const def = schema.fields[field.tag];
    if (!def) {
      problems.push(
        `template "${template.id}" binds ${field.tag}, which ${schema.profile} does not define. ` +
          'A template may only offer fields the validator can check.',
      );
      continue;
    }
    if (field.v !== undefined && def.subfields) {
      problems.push(`template "${template.id}": ${field.tag} takes subfields, not a fixed value.`);
    }
    if (field.codes?.length && def.positions) {
      problems.push(
        `template "${template.id}": ${field.tag} is a fixed field and has no subfields.`,
      );
    }
    if (field.v !== undefined && def.length !== undefined && field.v.length !== def.length) {
      problems.push(
        `template "${template.id}": ${field.tag} must be ${def.length} characters and the ` +
          `template starts it at ${field.v.length}.`,
      );
    }
    for (const code of field.codes ?? []) {
      if (def.subfields && !def.subfields[code]) {
        problems.push(
          `template "${template.id}": ${field.tag} $${code} is not defined for that field.`,
        );
      }
    }
  }
  return problems;
}
