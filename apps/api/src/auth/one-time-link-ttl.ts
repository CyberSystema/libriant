/**
 * How long the one-time links we e-mail stay redeemable.
 *
 * These lived as `private static readonly TOKEN_TTL_SEC` on the two services
 * that mint them, which was fine while nothing else needed to know. The
 * retention sweep does: with `EMAIL_DRIVER=console` — the shipped
 * configuration, and the one the launch cohort will run under until a Resend
 * key exists — `AdminOutboxService` is the ONLY path by which a librarian
 * receives a verification or reset link. The row's `bodyMarkdown` IS the
 * delivery. A retention period that blanks a body while its link is still
 * redeemable would strand the person it was written for, so
 * `EMAIL_OUTBOX_BODY_RETENTION_DAYS` is floored against the longest of these
 * (see retention.job.ts).
 *
 * Keep this the single source of truth: a TTL raised here and not there would
 * put that floor quietly back below the window it exists to clear.
 */
export const PASSWORD_RESET_TOKEN_TTL_SEC = 60 * 60;

export const EMAIL_VERIFICATION_TOKEN_TTL_SEC = 24 * 60 * 60;

/** The window any emailed one-time link can still be redeemed in. */
export const LONGEST_ONE_TIME_LINK_TTL_SEC = Math.max(
  PASSWORD_RESET_TOKEN_TTL_SEC,
  EMAIL_VERIFICATION_TOKEN_TTL_SEC,
);
