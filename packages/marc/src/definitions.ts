import { loadSchema, type AvramOverride, type AvramSchema } from './avram.js';
import marc21Bibliographic from './definitions/marc21-bibliographic.json' with { type: 'json' };

/**
 * The format definitions this build ships, and the one place a profile is
 * resolved to one.
 *
 * ## What is here, and what is deliberately not
 *
 * One definition: MARC 21 bibliographic, partial and hand-transcribed. The
 * phase-8 line also asks for MARC 21 authority and holdings and for UNIMARC
 * bibliographic and authorities. Those are **declared and refused** rather than
 * guessed, for the reason phase 7 refused the Greek MARC-8 table: a definition
 * transcribed from memory is a table nobody can check, and UNIMARC is the one
 * the Greek market runs on, so a wrong row there would be wrong in exactly the
 * catalogues this product exists to import.
 *
 * The refusal is cheap because of how the validator treats an absent definition:
 * asking for a profile this build does not have raises a typed error naming what
 * is missing, and asking for a FIELD the definition does not describe simply
 * produces no issue. Both are honest; neither invents a rule.
 *
 * ## Why the JSON is committed rather than generated at build time
 *
 * The plan's rule for this class of artefact — "generated and committed —
 * air-gapped builds fetch nothing". `scripts/gen-marc-schema.ts` regenerates the
 * file from a vendored authority and refuses to fetch; until somebody vendors
 * one, the committed file is the source of truth and says so in its own
 * `coverage` block.
 */

/** Every profile this build can validate against. */
export const SHIPPED_PROFILES = ['marc21/bibliographic'] as const;

export type ShippedProfile = (typeof SHIPPED_PROFILES)[number];

/**
 * Profiles the plan asks for and this build does not have, with the reason.
 *
 * Listed rather than omitted so the refusal is a fact a caller can render — an
 * import of a UNIMARC file should say "this build cannot validate UNIMARC", not
 * silently report zero issues.
 */
export const UNAVAILABLE_PROFILES: Readonly<Record<string, string>> = {
  'marc21/authority':
    'No definition. The authority 008 has its own 40-position layout with no Leader-driven ' +
    'discriminant, and transcribing it from memory would be a table nobody could check.',
  'marc21/holdings':
    'No definition. The holdings 008 is 32 positions, not 40, and its position labels are the ' +
    'least certain of the three.',
  'unimarc/bibliographic':
    'No definition. UNIMARC is what ABEKT exports and therefore what the Greek market runs on, ' +
    'which is precisely why it must come from IFLA rather than from memory.',
  'unimarc/authorities': 'No definition, for the same reason as UNIMARC bibliographic.',
};

const CACHE = new Map<string, AvramSchema>();

/**
 * The shipped definition for a profile.
 *
 * Throws when the profile is not one this build has — naming it, and saying why
 * — rather than returning an empty definition. An empty definition would
 * validate every record clean, which is the one answer a validator must never
 * give by accident.
 */
export function shippedSchema(profile: string, override?: AvramOverride): AvramSchema {
  if (!override) {
    const cached = CACHE.get(profile);
    if (cached) return cached;
  }
  if (profile !== 'marc21/bibliographic') {
    const why = UNAVAILABLE_PROFILES[profile];
    throw new Error(
      why
        ? `This build has no format definition for "${profile}". ${why}`
        : `Unknown format profile "${profile}". This build ships: ${SHIPPED_PROFILES.join(', ')}.`,
    );
  }
  const schema = loadSchema(marc21Bibliographic, override);
  if (!override) CACHE.set(profile, schema);
  return schema;
}

/** Every shipped definition, for the gate and for tests. */
export function shippedSchemas(): AvramSchema[] {
  return SHIPPED_PROFILES.map((profile) => shippedSchema(profile));
}

export { marc21Bibliographic };
