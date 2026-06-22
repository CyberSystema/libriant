/**
 * Canonical metadata for the public legal layer (Terms of Service, Privacy
 * Policy, DPA, etc.). Shared by the API (records which version a user accepted
 * at signup) and the web app (renders the documents + the consent UI).
 *
 * IMPORTANT: the document bodies are checked-in markdown under
 * `locales/<locale>/legal/<slug>.md`. They are DRAFTS and must be reviewed by
 * qualified legal counsel before launch — see `locales/legal-README.md`.
 */

/**
 * Version stamp for the legal documents. Bump this (to the ISO date of the
 * revision) WHENEVER a material change is published, so:
 *   - new acceptances record the new version (GDPR/contract accountability), and
 *   - a future "please re-accept the updated terms" prompt can compare a user's
 *     stored `legalAcceptedVersion` against this.
 */
export const LEGAL_VERSION = '2026-06-22';

/** Published legal documents — one markdown file per locale per slug. */
export const LEGAL_DOCUMENTS = [
  'terms',
  'privacy',
  'cookies',
  'dpa',
  'subprocessors',
  'acceptable-use',
  'legal-notice',
] as const;

export type LegalDocSlug = (typeof LEGAL_DOCUMENTS)[number];

/** The two documents a new library owner must accept at signup. */
export const SIGNUP_CONSENT_DOCS: readonly LegalDocSlug[] = ['terms', 'privacy'];

export function isLegalDocSlug(value: string): value is LegalDocSlug {
  return (LEGAL_DOCUMENTS as readonly string[]).includes(value);
}
