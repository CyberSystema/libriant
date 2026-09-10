/**
 * Every table in `lbr2` that holds something about a person, and what happens to
 * it under GDPR.
 *
 * ## Why this is data rather than six `findMany` calls
 *
 * §5's compliance row promises `check:dsar-coverage`, which "makes it
 * structurally impossible for a new patron-referencing table to escape the
 * subject-access bundle". That gate belongs to phases 33 and 96 and does not
 * exist. Phase 14 takes the number of patron-referencing tables in `lbr2` from
 * ONE — `loans.patron_id` — to eleven.
 *
 * A gate written at phase 33 protects tables twelve onward. It cannot
 * retroactively catch a table phase 14 forgot; it can only freeze the
 * forgetting, because it will be written against whatever coverage map exists at
 * the time and will therefore bless whatever this phase happened to do.
 *
 * So this is the thing a later gate consumes. Today the bundle is driven FROM
 * this list rather than from six hand-written queries, which turns "did somebody
 * remember?" from unanswerable into a diff. At phase 33 the gate becomes about
 * forty lines: every table in the rendered DDL with a `patron_id` column appears
 * here, and every entry here still names a real table.
 *
 * ## The three verdicts, and why `excluded` needs a reason
 *
 * `check:schema-conventions` establishes the property an exemption list has to
 * have: "an exemption is a decision somebody made and signed, and an entry that
 * stops matching anything FAILS — a list of accepted exceptions that no longer
 * describes the tree is a list nobody reads." An `excluded` verdict without a
 * sentence is a table somebody quietly dropped from a subject-access bundle.
 */

export type PatronDataVerdict =
  /** Rendered into the subject-access bundle and cleared by an erase. */
  | 'in_bundle'
  /** Deliberately not in the bundle. `reason` says why, and it is a decision. */
  | 'excluded'
  /** The table does not exist yet. `phase` says who creates it. */
  | 'pending';

export type PatronDataTable = {
  /** The physical table name in `lbr2`. */
  readonly table: string;
  /** The column that names the person. */
  readonly patronColumn: string;
  readonly verdict: PatronDataVerdict;
  /** Required for `excluded` and `pending`. */
  readonly reason?: string;
  readonly phase?: string;
  /** What an erase does to it. `null` for a table an erase does not touch. */
  readonly onErase: 'delete' | 'anonymise' | 'retain' | null;
};

/**
 * The twelve that exist, plus the ones later phases will add.
 *
 * Ordered as the bundle renders them: the person, then how the library reaches
 * them, then what they did.
 */
export const PATRON_DATA_TABLES: readonly PatronDataTable[] = [
  {
    table: 'patrons',
    patronColumn: 'id',
    verdict: 'in_bundle',
    // The row itself survives an erase, because `loans.patron_id` and
    // `fees.patron_id` still point at it and a public library's loan history is
    // its own record. Every direct identifier on it is overwritten.
    onErase: 'anonymise',
  },
  { table: 'patron_cards', patronColumn: 'patron_id', verdict: 'in_bundle', onErase: 'delete' },
  {
    table: 'patron_identifiers',
    patronColumn: 'patron_id',
    verdict: 'in_bundle',
    // An ΑΜΚΑ or an ΑΦΜ is the most identifying thing the library holds and has
    // no operational use after the person has left.
    onErase: 'delete',
  },
  { table: 'patron_addresses', patronColumn: 'patron_id', verdict: 'in_bundle', onErase: 'delete' },
  {
    table: 'patron_relationships',
    patronColumn: 'from_patron_id',
    verdict: 'in_bundle',
    // Deleted in BOTH directions: a guardian row naming an erased child is still
    // a fact about the child.
    onErase: 'delete',
  },
  { table: 'patron_blocks', patronColumn: 'patron_id', verdict: 'in_bundle', onErase: 'delete' },
  { table: 'patron_messages', patronColumn: 'patron_id', verdict: 'in_bundle', onErase: 'delete' },
  {
    table: 'patron_notes',
    patronColumn: 'patron_id',
    verdict: 'in_bundle',
    // A staff note about a person is personal data about that person even when
    // it is the library's own opinion — arguably especially then.
    onErase: 'delete',
  },
  {
    table: 'patron_merges',
    patronColumn: 'loser_patron_id',
    verdict: 'in_bundle',
    // The row survives, because deleting it would leave `merged_into_id`
    // pointing somewhere with no explanation. It holds counts, not identifiers.
    onErase: 'retain',
  },
  {
    table: 'loans',
    patronColumn: 'patron_id',
    verdict: 'in_bundle',
    // Nulled, not deleted. §3: the statistical buckets survive so the ISO 2789
    // return is unaffected, and the copy's own history — when it went out, when
    // it came back — is the library's record and not the borrower's.
    onErase: 'anonymise',
  },
  {
    table: 'loan_events',
    // NOT `patron_id`. The table has no such column, deliberately, and that is
    // this entry's whole point.
    patronColumn: '(reached through loans.id)',
    verdict: 'excluded',
    // §3 nulls `loans.patron_id` on return, in the same transaction. An event
    // log keeping its own copy of the patron id would make that anonymisation
    // COSMETIC — the link would survive one join away, in a table nobody
    // remembered to check — so phase 16 gave it none. Severing the loan's link
    // severs this one too, with no second erasure path to forget.
    //
    // Listed here rather than omitted precisely BECAUSE it holds circulation
    // history: a reader of this map should be able to see that the question was
    // asked and answered, which is what §5's `check:dsar-coverage` will
    // eventually enforce and what a silence would hide.
    onErase: 'retain',
    reason:
      'It holds no patron column. Every row is reached through `loans`, whose `patron_id` an ' +
      'erase nulls — so an erase reaches these rows by construction rather than by a rule ' +
      'somebody has to remember to write.',
  },
  {
    table: 'fees',
    patronColumn: 'patron_id',
    verdict: 'in_bundle',
    // A settled fee is anonymised; an OUTSTANDING one is money owed, and Article
    // 17(3)(e) leaves it standing. The erase path refuses while a balance is
    // open rather than deciding for the library.
    onErase: 'anonymise',
  },

  // -- Not in the bundle, deliberately ---------------------------------------
  {
    table: 'patron_number_counters',
    patronColumn: '—',
    verdict: 'excluded',
    reason:
      'Holds one integer per year and names nobody. It is the only patron-adjacent table with no ' +
      'patron column at all.',
    onErase: null,
  },
  {
    table: 'reading_history_policy',
    patronColumn: '—',
    verdict: 'excluded',
    reason:
      "The library's own setting, not a fact about any person. A singleton with one enum on it.",
    onErase: null,
  },
  {
    table: 'audit_log',
    patronColumn: 'target_id',
    verdict: 'excluded',
    reason:
      'The record of what STAFF did, which the library needs precisely in order to show that an ' +
      'erasure was carried out. Erasing the evidence of an erasure is the one deletion Article 17 ' +
      'cannot mean. The 1.0 erase path redacts the patron-identifying payload inside audit rows ' +
      'rather than deleting them, and phase 14 keeps that shape.',
    onErase: 'anonymise',
  },
  {
    table: 'change_events',
    patronColumn: 'entity_id',
    verdict: 'excluded',
    reason:
      'The replication feed. §5 says erasure "cascades through change_events, sync_client_changes ' +
      'and every device replica", and that cascade is phase 78 (device sync) — there is no fleet ' +
      'to cascade to until one exists. Recorded here so the gate at phase 33 inherits the ' +
      'obligation rather than the omission.',
    onErase: null,
  },

  // -- Later phases ----------------------------------------------------------
  {
    table: 'holds',
    patronColumn: 'patron_id',
    verdict: 'pending',
    phase: '17',
    reason: 'The holds queue. Phase 17 creates the table.',
    onErase: null,
  },
  {
    table: 'patron_privacy_settings',
    patronColumn: 'patron_id',
    verdict: 'pending',
    phase: '32',
    reason: 'Identity side. Phase 32 creates it with the OPAC account.',
    onErase: null,
  },
  {
    table: 'reviews',
    patronColumn: 'patron_id',
    verdict: 'pending',
    phase: '98',
    reason: 'A patron-authored review is the clearest personal data in the product.',
    onErase: null,
  },
];

/** The tables the bundle renders, in order. */
export const BUNDLE_TABLES = PATRON_DATA_TABLES.filter((t) => t.verdict === 'in_bundle');

/** Every table that exists today and holds something about a person. */
export function patronDataTablesThatExist(): readonly PatronDataTable[] {
  return PATRON_DATA_TABLES.filter((t) => t.verdict !== 'pending');
}
