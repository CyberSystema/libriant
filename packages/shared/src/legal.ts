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
 *
 * privacy-legal-09: bumping this is no longer optional politeness. Each version
 * has a FROZEN copy of every published document under
 * `docs/legal/accepted/<LEGAL_VERSION>/<locale>/<slug>.md`, and
 * `apps/api/src/auth/legal-acceptance.ts` carries the SHA-256 of each of those
 * files so an acceptance record names the exact bytes agreed to. Editing a
 * document under `locales/*\/legal/` without bumping this and re-freezing the
 * directory fails `apps/api/src/auth/legal-acceptance.spec.ts` — which is the
 * whole point, because before that test existed such an edit silently
 * invalidated every acceptance already recorded.
 */
export const LEGAL_VERSION = '2026-08-27';

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

/**
 * The documents a new library owner ticks at signup, in the order the consent
 * label lists them.
 *
 * privacy-legal-13: the DPA is here because an Article 28 contract that is only
 * incorporated by reference (Terms §5) leaves a public body's DPO with nothing
 * to file. Art. 28(9) accepts electronic form and incorporation by reference is
 * effective in principle, so this is not a validity fix — it is a procurement
 * one: the acceptance record now names the DPA as a document that was PUT IN
 * FRONT of the person who bound the library, not merely one the Terms mention.
 *
 * BOTH SIDES READ THIS LIST. `legalAcceptanceEvidence()` writes
 * `presented: SIGNUP_CONSENT_DOCS.includes(slug)` into the evidence row, and
 * `apps/web/lib/consent-label.ts` builds the checkbox label from it. Adding a
 * slug here therefore adds a link to the signup form; it must never be a
 * server-side-only edit, because that would record "presented" against a
 * document nobody was shown — a worse record than the one this replaces.
 * `apps/web/lib/consent-label.test.ts` fails if a slug added here has no
 * consent copy in either locale.
 */
export const SIGNUP_CONSENT_DOCS: readonly LegalDocSlug[] = ['terms', 'privacy', 'dpa'];

export function isLegalDocSlug(value: string): value is LegalDocSlug {
  return (LEGAL_DOCUMENTS as readonly string[]).includes(value);
}
