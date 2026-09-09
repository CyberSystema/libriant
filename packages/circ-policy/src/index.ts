/**
 * `@libriant/circ-policy` — the pure circulation-policy resolver.
 *
 * §4.1 fixes the contract and every word of it is load-bearing: "Zero-dependency,
 * pure, synchronous, no `Date.now()` — every function takes an explicit instant."
 * Consumers are circulation, holds, fees, notices, the OPAC, SIP2, NCIP and the
 * offline Rust core, all pinned to `fixtures/resolution-vectors.json`, and the
 * only way eight consumers agree about a due date is that one function computes
 * it and takes no decisions of its own.
 *
 * "Zero-dependency" means zero THIRD-PARTY: this package imports
 * `@libriant/shared/money`, because the alternative is a second currency type in
 * the fee ledger. The phase line says "_Depends on:_ 1", and phase 1 is
 * `packages/shared`.
 *
 * WHAT IS NOT HERE, and where it lives instead:
 *
 *   loading a snapshot, caching it, invalidating it        phase 13
 *   `/circulation/explain`, the preview endpoint            phase 13
 *   counting a patron's loans, reading a card expiry        phase 16
 *   writing `policy_snapshot`, `loan_events`, the locks     phase 16
 *   hold queue positions, promotion, transit, the shelf     phase 17
 *   creating `fees` rows, the ledger, the accrual sweep     phase 18
 *   channels, quiet hours, digests, the renderer            phase 22
 *
 * The tell is the argument list: every function here takes only policy, calendar,
 * explicit instants and caller-supplied scalars. The moment one takes a `feeId`
 * or a database client it has moved to another phase.
 *
 * AND THERE IS NO DEFAULT POLICY, anywhere, not even for fixtures. §4.1: "never
 * fails open to a default policy — a wrong loan period is a wrong receipt." Once
 * such a constant is exported somebody writes `?? DEFAULT_LOAN_POLICY` and every
 * refusal in this package becomes unreachable.
 */
export * from './types.js';
export * from './rank.js';
export * from './calendar.js';
export * from './greek-calendar.js';
export * from './duedate.js';
export * from './fines.js';
export * from './blocks.js';
export * from './resolve.js';
