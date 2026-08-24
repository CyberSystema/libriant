/**
 * Render a thrown value for a job log line.
 *
 * SCHEDULED-TENANTSFAILED-DISCARDED: the audit caught `accrual failed for
 * tenant=reltwo: ` — a warn line with nothing after the colon, because a
 * Prisma client-initialisation error can carry an empty `message`. A log line
 * that names the failure but not the reason is barely better than no line at
 * all, so fall back to the constructor name, and to `String(err)` for the
 * non-Error things a driver can reject with.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message) return `${err.name}: ${err.message}`;
    // Prisma wraps the real cause; surface it rather than a bare name.
    const cause = (err as { cause?: unknown }).cause;
    return cause ? `${err.name} (cause: ${describeError(cause)})` : err.name;
  }
  const s = String(err);
  return s === '[object Object]' ? JSON.stringify(err) : s;
}
