import type { CivilDateTime } from './types.js';

/**
 * The golden vectors, and the shape two languages have to agree on.
 *
 * §4.1 lists eight consumers of this package — circulation, holds, fees,
 * notices, the OPAC, SIP2, NCIP and the offline Rust core — "all pinned to
 * `fixtures/resolution-vectors.json`, run by both `node --test` and
 * `cargo test`". This file is the TypeScript half of that pin, and every choice
 * in the JSON shape below is a place the two would otherwise disagree silently.
 *
 * INSTANTS ARE RFC 3339 STRINGS with an explicit `Z`, never epoch numbers.
 * `chrono` parses RFC 3339 natively; a bare number invites a
 * seconds-versus-milliseconds mix-up that is off by a factor of a thousand and
 * looks plausible in a date column.
 *
 * DURATIONS ARE `{value, unit}` OBJECTS, never ISO-8601 duration strings. `P2W`
 * has no parser in the Rust standard library, and a hand-rolled one in the core
 * would be a second answer to a question this file exists to have one answer to.
 *
 * MONEY IS `{minorUnits, currency}`. `JSON.stringify({a: 1n})` THROWS, so a
 * `bigint` cannot cross this boundary at all — see `types.ts`.
 *
 * TIMEZONES ARE THE STORED IANA NAME, never `resolvedOptions().timeZone`. ICU
 * renames 152 of the 597 names Postgres accepts — `America/Argentina/Buenos_Aires`
 * comes back as `America/Buenos_Aires` — so a vector that recorded the resolved
 * name would fail against a database that stored the canonical one.
 *
 * EVERY VECTOR CARRIES THE EXPECTED TRACE, not only the outcome. Without it the
 * Rust core can produce the right due date through the wrong rule and no test
 * fails — which is exactly the failure `loans.applied_rule_id` exists to catch.
 */

/** The envelope. A version bump is how a TS/Rust schema mismatch becomes loud. */
export type VectorFile = {
  readonly version: number;
  readonly generatedFor: string;
  readonly note: string;
  readonly vectors: readonly Vector[];
};

export type Vector = RankVector | CivilVector | DueDateVector | FineVector | ResolveVector;

/** `specificity()` against the SQL generated column, for all 64 combinations. */
export type RankVector = {
  readonly kind: 'rank';
  readonly id: string;
  readonly selectors: Readonly<Record<string, string | null>>;
  readonly expectSpecificity: number;
};

/** Wall-clock ↔ instant, including every DST edge. */
export type CivilVector = {
  readonly kind: 'civil';
  readonly id: string;
  readonly timezone: string;
  readonly civil: CivilDateTime;
  readonly disambiguation: 'earlier' | 'later';
  /** RFC 3339, or null when the wall time does not exist and was rejected. */
  readonly expectInstant: string;
  readonly expectKind: 'unique' | 'gap' | 'ambiguous';
};

export type DueDateVector = {
  readonly kind: 'dueDate';
  readonly id: string;
  readonly note: string;
  readonly calendarId: string;
  readonly loanPolicyId: string;
  readonly from: string;
  readonly hasOutstandingHold?: boolean;
  /** RFC 3339, or null for an indefinite loan. */
  readonly expectDueAt: string | null;
  /** The `reason` of each roll, in order. The trace, not just the outcome. */
  readonly expectRolls: readonly string[];
};

export type FineVector = {
  readonly kind: 'fine';
  readonly id: string;
  readonly note: string;
  readonly calendarId: string;
  readonly finePolicyId: string;
  readonly dueAt: string;
  readonly asOf: string;
  readonly expectMinorUnits: number;
  readonly expectIntervals: number;
  readonly expectWithinGrace: boolean;
};

export type ResolveVector = {
  readonly kind: 'resolve';
  readonly id: string;
  readonly note: string;
  readonly snapshotId: string;
  readonly context: Readonly<Record<string, string | null>>;
  readonly at: string;
  readonly expectMatchedRuleId: string;
  readonly expectBeatenRuleIds: readonly string[];
};

/**
 * The fixtures every vector refers to by id.
 *
 * Kept in the same file as the vectors so that one artifact is the whole
 * contract: a Rust test reads one JSON document and needs nothing else from this
 * repository.
 */
export type VectorFixtures = {
  readonly calendars: Readonly<Record<string, unknown>>;
  readonly loanPolicies: Readonly<Record<string, unknown>>;
  readonly finePolicies: Readonly<Record<string, unknown>>;
  readonly snapshots: Readonly<Record<string, unknown>>;
};

export type VectorDocument = VectorFile & { readonly fixtures: VectorFixtures };
