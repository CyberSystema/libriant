/**
 * How long a toast stays, and how loudly it is announced.
 *
 * frontend-22: every toast was dismissed after a flat 5 s with no pause, no
 * history and no way to get it back, while the component's own doc comment
 * claimed hovering paused it. That is WCAG 2.1 SC 2.2.1 (Timing Adjustable,
 * Level A), and it hurt worst exactly where it mattered most — toasts are the
 * only channel for "this offline action was lost", for the fine created by a
 * return, and for print failures. An error the user did not read is an error
 * that did not happen.
 *
 * So confirmations and errors no longer get the same treatment: a success
 * message may expire on its own, an error may not. The rules live here as
 * plain functions because "how long should this have left after two pauses"
 * is the kind of arithmetic that is quietly wrong for months.
 */

export type ToastSeverity = 'info' | 'success' | 'warning' | 'critical';

/**
 * `null` = sticky: it stays until the user dismisses it.
 *
 * `critical` is sticky because it is the only record of something that went
 * wrong. `warning` gets double the confirmation time because it usually
 * carries a consequence to read ("fine created", "hold promoted"), not just an
 * acknowledgement.
 */
export const DEFAULT_TOAST_DURATION_MS: Readonly<Record<ToastSeverity, number | null>> = {
  info: 5000,
  success: 5000,
  warning: 10000,
  critical: null,
};

export function defaultDurationFor(severity: ToastSeverity): number | null {
  return DEFAULT_TOAST_DURATION_MS[severity];
}

/**
 * An explicit `durationMs` from the caller always wins, including an explicit
 * `null` (sticky) and an explicit number on a critical toast. `undefined`
 * means "no opinion" and falls through to the severity default.
 */
export function resolveDuration(
  severity: ToastSeverity,
  explicit: number | null | undefined,
): number | null {
  return explicit === undefined ? defaultDurationFor(severity) : explicit;
}

/**
 * Errors interrupt; everything else waits its turn.
 *
 * `role="alert"` is `aria-live="assertive"` and is announced on insertion,
 * which is what a failure needs — announcing "your checkout was refused"
 * politely, after whatever the screen reader is already saying, was the other
 * half of frontend-20. Non-critical toasts get *no* role on purpose: they are
 * announced by the stack's own persistent polite region, and nesting a second
 * live region inside it risks the same message being read twice.
 */
export function liveRegionRoleFor(severity: ToastSeverity): 'alert' | undefined {
  return severity === 'critical' ? 'alert' : undefined;
}

/** A sticky toast has no timer at all, so nothing to pause or resume. */
export function isSticky(durationMs: number | null): boolean {
  return durationMs === null;
}

/**
 * A dismissal timer that can be paused and resumed without losing or
 * resetting the time already served.
 */
export type ToastTimer = {
  /** Total lifetime, or null for sticky. */
  totalMs: number | null;
  /** Time already served across previous running stretches. */
  consumedMs: number;
  /** Timestamp the current running stretch began, or null while paused. */
  runningSince: number | null;
};

export function startTimer(totalMs: number | null, now: number): ToastTimer {
  return { totalMs, consumedMs: 0, runningSince: totalMs === null ? null : now };
}

export function pauseTimer(timer: ToastTimer, now: number): ToastTimer {
  if (timer.runningSince === null) return timer;
  return {
    totalMs: timer.totalMs,
    consumedMs: timer.consumedMs + Math.max(0, now - timer.runningSince),
    runningSince: null,
  };
}

export function resumeTimer(timer: ToastTimer, now: number): ToastTimer {
  if (timer.totalMs === null || timer.runningSince !== null) return timer;
  return { totalMs: timer.totalMs, consumedMs: timer.consumedMs, runningSince: now };
}

/**
 * Milliseconds left before dismissal, or `null` when the toast is sticky.
 * Never negative — a caller can hand the result straight to `setTimeout`.
 */
export function remainingMs(timer: ToastTimer, now: number): number | null {
  if (timer.totalMs === null) return null;
  const served =
    timer.consumedMs + (timer.runningSince === null ? 0 : Math.max(0, now - timer.runningSince));
  return Math.max(0, timer.totalMs - served);
}
