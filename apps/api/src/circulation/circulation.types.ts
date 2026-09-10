import type { Block, CalendarRoll } from '@libriant/circ-policy';
import type { DeviceClaim } from './sync-replay.js';

/**
 * The shapes the three verbs share.
 *
 * `apps/api/src/circulation/**` is under two ESLint bans — no clock read and no
 * millisecond date arithmetic (phase 13), plus the advisory-lock rule (phase
 * 16) — so every instant in this directory arrives as a parameter and every
 * date computation goes through `@libriant/circ-policy`. That is why every input
 * below carries `effectiveAt` explicitly rather than defaulting it somewhere.
 */

/** Who is acting, and on whose behalf a device is replaying. */
export type CirculationOrigin = {
  /** `desk` unless a device or another channel says otherwise. */
  readonly source?: 'desk' | 'opac' | 'sip2' | 'ncip' | 'api' | 'offline' | 'kiosk';
  /**
   * Present ONLY for a device replay.
   *
   * Deliberately not reachable from an HTTP body. §6 phase 79 owns device
   * enrolment, attestation and revocation, and a browser minting its own device
   * id would create identities that phase then has to migrate or repudiate — so
   * `CirculationController` refuses a request that carries one and the
   * mechanism is exercised at the service layer, where the tests live, until the
   * batch push endpoint of phase 78 can supply an authenticated device
   * principal.
   */
  readonly device?: DeviceClaim;
  /**
   * When it happened, in the world. Absent means "now", which is the desk case.
   *
   * CLAMPED to the server's own instant, never refused: a device with a fast
   * clock must not hand a librarian a `23514` they cannot act on, and
   * `loan_events_effective_not_future` would otherwise fire. §6 phase 78 calls
   * this clock-skew clamping; phase 16 is the first phase that can have skew.
   */
  readonly effectiveAt?: Date;
};

/**
 * What the desk should DO with the copy in its hand.
 *
 * §6 phase 16 names `CheckinDisposition` and the plan of record says nothing
 * else about it — the word appears exactly once in the whole document. It is
 * DERIVED and returned, and deliberately NOT stored as a column:
 *
 *   - the facts that produce it are each already stored by their owning phase
 *     (the copy's new status by phase 15, the transfer by phase 15, the hold
 *     phase 17 will fill, the fine by phase 18), so a stored enum beside them is
 *     a second answer that can drift from the first;
 *   - it is an INSTRUCTION rather than a state — "put this on the hold shelf for
 *     Maria" — and an instruction goes stale the moment somebody acts on it.
 *
 * That is the same argument `ItemStatusService` makes against a trigger writing
 * history, applied to the other end of the transaction.
 *
 * `hold_shelf` and `transit` are declared and unreachable in phase 16: holds are
 * phase 17 and routing is phase 23. They are here because the DESK's vocabulary
 * is what this type is, and a client that has to learn two more values later is
 * a client that has to be redeployed to understand a returned book.
 */
export const CHECKIN_DISPOSITIONS = [
  /** Back on the shelf where it lives. */
  're_shelve',
  /** It belongs at another branch; phase 23 routes it. */
  'transit',
  /** Somebody is waiting; phase 17 fills it. */
  'hold_shelf',
  /** It came back damaged, missing a part, or flagged. Give it to a human. */
  'staff_review',
] as const;

export type CheckinDisposition = (typeof CHECKIN_DISPOSITIONS)[number];

/** What a fine came to, or why it could not be worked out. */
export type ComputedFine =
  | {
      readonly kind: 'amount';
      readonly minorUnits: number;
      readonly currency: string;
      readonly daysOverdue: number;
      readonly withinGrace: boolean;
      readonly cappedBy: 'maximumFine' | 'replacementCost' | null;
    }
  | { readonly kind: 'refused'; readonly code: string; readonly message: string };

export type CheckoutResult = {
  readonly loanId: string;
  readonly itemId: string;
  readonly patronId: string;
  readonly dueAt: string | null;
  readonly appliedRuleId: string;
  readonly snapshotVersion: number;
  readonly rolls: readonly CalendarRoll[];
  /** Warnings that did NOT stop the loan. A block would have refused it. */
  readonly warnings: readonly Block[];
  readonly replayed: boolean;
};

export type CheckinResult = {
  readonly loanId: string;
  readonly itemId: string;
  readonly disposition: CheckinDisposition;
  readonly returnedAt: string;
  readonly dueAt: string | null;
  readonly overdue: boolean;
  readonly fine: ComputedFine | null;
  /** True when the patron link was severed in the same transaction. */
  readonly anonymised: boolean;
  readonly replayed: boolean;
};

export type RenewResult = {
  readonly loanId: string;
  readonly itemId: string;
  readonly renewed: boolean;
  readonly dueAtBefore: string;
  readonly dueAtAfter: string | null;
  readonly renewalCount: number;
  /** Populated when `renewed` is false. */
  readonly blocks: readonly Block[];
  readonly warnings: readonly Block[];
  readonly replayed: boolean;
};
