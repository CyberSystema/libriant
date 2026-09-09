import { Injectable } from '@nestjs/common';
import { zonedCivil, type CivilDateTime } from '@libriant/circ-policy';

/**
 * The one place circulation is allowed to ask what time it is.
 *
 * §6 phase 13 asks for "`TenantClockService` + the ESLint ban on raw `Date`
 * arithmetic in `circulation/`", and the two halves are one idea: every
 * function in `packages/circ-policy` takes an explicit instant, so SOMETHING has
 * to supply one, and the whole value of that design evaporates if forty call
 * sites each supply their own.
 *
 * ## What a "tenant clock" is for, given there is only one clock
 *
 * It does not make time tenant-specific — there is one UTC instant and every
 * process shares it. What it makes tenant-specific is the CIVIL READING of that
 * instant, which is what a library actually reasons in: "is the desk open now?",
 * "what is today's date for the overdue sweep?", "does this loan roll to
 * tomorrow?" all resolve differently in `Europe/Athens` and `UTC`, and 1.0 had
 * no way to ask them at all — there is no timezone column anywhere in the 1.0
 * schema, which is `circ-5` in one sentence.
 *
 * So the service does three things and refuses to do a fourth:
 *
 *   `now()`          the instant, read ONCE per operation and passed down
 *   `civil(...)`     that instant as a wall-clock reading in a branch's zone
 *   `at(iso)`        an explicit instant, for replay and for tests
 *
 * and it will not do arithmetic. Adding a day to an instant is
 * `computeDueDate`'s job, in `packages/circ-policy`, where it is pure, where 630
 * golden vectors pin it, and where phase 77's Rust core runs the same code. A
 * `clock.addDays()` here would be a second implementation of the thing the whole
 * of phase 12 exists to have exactly one of.
 *
 * ## Read the clock ONCE per operation
 *
 * This is the discipline the type system cannot enforce and the reason the
 * service exists rather than a bare `Date.now()`. A checkout that reads the
 * clock in the loan-period calculation, again in the fine-grace calculation and
 * again when stamping `loaned_at` has three instants and can straddle midnight
 * between them — which is a one-day error in the due date, on one loan, at
 * 23:59:59, reproducible only at 23:59:59. `now()` at the top of the service
 * method, passed everywhere, cannot do that.
 *
 * ## Why it is not `Date.now()` behind a fig leaf
 *
 * Because it is the seam. An integration test that needs a Tuesday in August, a
 * replay that must reproduce a charge from March, and phase 77's offline client
 * reconciling a loan taken while the network was down all need to supply the
 * instant rather than take the process's. `TenantClockService` is a Nest
 * provider, so all three override it in one line; forty `Date.now()` calls
 * cannot be overridden at all.
 */
@Injectable()
export class TenantClockService {
  /**
   * The current instant.
   *
   * The only clock read in circulation that can reach a DUE DATE. There is one
   * other in this directory — `PolicySnapshotService` measures its own cache
   * entries' age four times — and the ESLint block in `eslint.config.mjs` names
   * both files explicitly rather than exempting the directory, so a third would
   * fail the build. Cache age is wall-clock by nature, local to the process, and
   * never reaches a receipt; a due date is none of those things.
   */
  now(): Date {
    return new Date(Date.now());
  }

  /**
   * An explicit instant, for a caller that has one — a replayed offline
   * operation, a backdated return, a test that needs a spring-forward night.
   *
   * Throws rather than returning an Invalid Date: an invalid instant flowing
   * into `computeDueDate` produces `NaN` timestamps and a due date of
   * `Invalid Date`, which stores as NULL and reads at the desk as "no due date".
   */
  at(instant: string | number | Date): Date {
    const d = instant instanceof Date ? new Date(instant.getTime()) : new Date(instant);
    if (Number.isNaN(d.getTime())) {
      throw new RangeError(
        `"${String(instant)}" is not an instant. Circulation refuses to compute against one ` +
          'rather than producing a due date of Invalid Date.',
      );
    }
    return d;
  }

  /**
   * That instant as a wall-clock reading in a branch's zone.
   *
   * Delegates to `packages/circ-policy`'s `zonedCivil`, which is the only code
   * in this system permitted to cross into ICU — measured at 30.4 µs to
   * construct a formatter and 3.74 µs per `formatToParts` against 0.009 µs for
   * the integer arithmetic that replaced it, which is why the crossings are
   * counted.
   */
  civil(instant: Date, timezone: string): CivilDateTime {
    return zonedCivil(instant, timezone);
  }
}
