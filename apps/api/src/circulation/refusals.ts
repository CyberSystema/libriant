import { ConflictException } from '@nestjs/common';
import type { Block } from '@libriant/circ-policy';

/**
 * Why the desk was told no.
 *
 * Every refusal in circulation carries a machine-readable `code` beside its
 * sentence, and that is not decoration: §6 phase 33's acceptance criterion is
 * "a patron renew hits the same policy refusal a librarian would, WITH THE SAME
 * ERROR CODE", and §6 phase 61's SIP2 server has to map each one onto a screen
 * message a 2014 self-check unit can display. A refusal that exists only as
 * English prose is one three later phases have to re-derive from a string.
 */
export class CirculationRefusal extends ConflictException {
  constructor(
    readonly code: string,
    message: string,
    extra: Readonly<Record<string, unknown>> = {},
  ) {
    super({ code, message, ...extra });
  }
}

/**
 * The policy said no, and here is everything it said.
 *
 * A LIST rather than the first hit, because `evaluateBlocks` returns a list for
 * a reason it states: "a librarian who clears one block and hits the next has
 * been made to do the same work twice, and a self-check machine that can only
 * report one reason gives the patron a puzzle."
 *
 * `warnings` travels with it so a desk that overrides the blocks (phase 21) does
 * not lose the things it should still have said out loud.
 */
export class CirculationBlockedError extends ConflictException {
  constructor(
    readonly operation: 'checkout' | 'renewal' | 'hold',
    readonly blocks: readonly Block[],
    readonly all: readonly Block[],
  ) {
    super({
      code: `circulation.${operation}Blocked`,
      message: BLOCKED_MESSAGE[operation],
      blocks,
      warnings: all.filter((b) => b.severity === 'warn'),
      // The permission an override will need, per block. Phase 21 builds the
      // override route; the keys are already decided, so a client can grey the
      // button out today instead of discovering the refusal after the click.
      overridePermissions: [...new Set(blocks.map((b) => b.overridePermission))],
    });
  }
}

/**
 * One sentence per operation, because "blocked" on its own tells a reader
 * nothing about what they were trying to do. `hold` joined the list in phase 17;
 * `evaluateBlocks` has taken `'hold'` as an operation since phase 12 and there
 * was simply nothing to raise until the queue existed.
 */
const BLOCKED_MESSAGE: Readonly<Record<'checkout' | 'renewal' | 'hold', string>> = {
  checkout: 'This loan is blocked. Clear or override every blocking reason to lend the copy.',
  renewal: 'This renewal is blocked.',
  hold: 'This request is blocked. Clear or override every blocking reason to place it.',
};

/**
 * The client's instant, never later than the server's.
 *
 * `loan_events_effective_not_future` is a CHECK, and a device with a fast clock
 * would otherwise hand a librarian a `23514` they cannot act on. Clamping is
 * what §6 phase 78 means by "clock-skew clamping", and phase 16 is the first
 * phase that can have skew at all — so it is the phase that has to survive it.
 *
 * Clamped rather than refused in one direction only: a client claiming the
 * FUTURE is a clock error and is silently corrected, while a client claiming the
 * distant past is a real backdated act (a Saturday book drop, a Friday checkout
 * synced on Monday) and is honoured exactly.
 */
export function clampEffective(claimed: Date | undefined, serverNow: Date): Date {
  if (claimed === undefined) return serverNow;
  return claimed > serverNow ? serverNow : claimed;
}
