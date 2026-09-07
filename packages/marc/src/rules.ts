import { applyOverride, type AvramOverride, type AvramSchema } from './avram.js';
import { leaderAt, type MarcRecord } from './types.js';

/**
 * Cataloguing rule packs — RDA, AACR2, ISBD — expressed as data over one
 * definition.
 *
 * ## Why they are overrides and not a second validator
 *
 * A cataloguing code does not change what MARC 21 *is*; it changes what a
 * cataloguer is expected to supply. RDA wants 336/337/338 on every record and
 * AACR2 has never heard of them. That is the same shape as a tenant's local
 * practice, so it reuses the same mechanism — {@link AvramOverride} — and the
 * three compose in one order: shipped definition, then the rule pack the record
 * itself selects, then the library's own override, which wins because a library
 * that has written a rule down means it.
 *
 * ## The record chooses its own pack, and that is not a detail
 *
 * Leader/18, descriptive cataloguing form, is what a record says about itself.
 * Applying RDA's rules to a 1994 AACR2 record would flag three missing fields
 * that did not exist when it was made — on every record in an imported
 * catalogue. So the pack follows the record, not the library.
 *
 * The plan's own note on Leader/18 is carried here: `'c'` means ISBD
 * punctuation OMITTED, and it is growing under RDA. Treating `'c'` as
 * "not ISBD" — which is the intuitive reading — gets it exactly backwards.
 */

export type RulePackId = 'rda' | 'aacr2' | 'isbd';

export type RulePack = {
  readonly id: RulePackId;
  readonly label: string;
  /**
   * The Leader/18 values that select this pack. A blank is written as a space,
   * as the record carries it.
   */
  readonly descriptiveForm: readonly string[];
  readonly note: string;
  readonly override: AvramOverride;
};

/**
 * The packs, as data.
 *
 * Deliberately small. Each entry is a rule that is a property of the CODE rather
 * than of MARC 21, that this session can state without a reference, and that a
 * library would recognise. Everything else is left to the generated definition
 * and to a library's own override — an invented rule in here would be worse than
 * an absent one, because it would arrive with a cataloguing code's authority
 * behind it.
 */
export const RULE_PACKS: readonly RulePack[] = [
  {
    id: 'rda',
    label: 'RDA (Resource Description and Access)',
    // 'i' is ISBD punctuation included, which is how RDA records are coded.
    descriptiveForm: ['i'],
    note:
      'RDA describes a resource by content, media and carrier type, which AACR2 had no place ' +
      'for. A record coded as RDA and missing them is incomplete rather than wrong.',
    override: {
      fields: {
        // `confidence: 'transcribed'` on each: these three rules were written
        // here, and regenerating the BASE definition from an authority must not
        // promote them into errors that refuse saves.
        '336': {
          label: 'Content Type',
          repeatable: true,
          required: true,
          confidence: 'transcribed',
        },
        '337': { label: 'Media Type', repeatable: true, required: true, confidence: 'transcribed' },
        '338': {
          label: 'Carrier Type',
          repeatable: true,
          required: true,
          confidence: 'transcribed',
        },
      },
    },
  },
  {
    id: 'aacr2',
    label: 'AACR2',
    descriptiveForm: ['a'],
    note:
      'AACR2 records predate RDA content/media/carrier typing and predate 264. They are not ' +
      'deficient for lacking either, and this pack exists mainly to say so — it adds no ' +
      'requirements at all.',
    override: {},
  },
  {
    id: 'isbd',
    label: 'ISBD punctuation',
    // BOTH 'i' and 'c' are ISBD: 'i' includes the punctuation and 'c' omits it.
    // 'c' is growing under RDA, and reading it as "not ISBD" is the mistake the
    // 2.0 plan calls out by name. So an RDA record is also an ISBD record —
    // which is why packs COMPOSE rather than partition Leader/18.
    descriptiveForm: ['i', 'c'],
    note:
      'Leader/18 = "c" means ISBD punctuation omitted — the record IS ISBD, and the display ' +
      'layer must generate the punctuation rather than pass it through. It is growing under RDA.',
    override: {},
  },
];

/**
 * Every pack a record selects for itself, in declaration order.
 *
 * A LIST, not one: RDA and ISBD are orthogonal, not alternatives. Leader/18 =
 * 'i' means both "described under RDA" and "ISBD punctuation included", and a
 * function returning one of them would silently drop the other.
 */
export function packsFor(record: MarcRecord): RulePack[] {
  const form = leaderAt(record.leader, 'descriptiveCatalogingForm') || ' ';
  return RULE_PACKS.filter((pack) => pack.descriptiveForm.includes(form));
}

/** The first pack a record selects, for a caller that wants a label. */
export function packFor(record: MarcRecord): RulePack | null {
  return packsFor(record)[0] ?? null;
}

/**
 * The definition a record should actually be measured against.
 *
 * Composition order is shipped, then pack, then tenant — and the tenant is last
 * on purpose. A library that has written down a local practice has made a
 * decision; a rule pack is an inference from one byte of the record.
 */
export function schemaForRecord(
  base: AvramSchema,
  record: MarcRecord,
  tenantOverride?: AvramOverride,
): AvramSchema {
  let schema = base;
  for (const pack of packsFor(record)) schema = applyOverride(schema, pack.override);
  return tenantOverride ? applyOverride(schema, tenantOverride) : schema;
}
