import type { Translator } from '@libriant/i18n';
import { SIGNUP_CONSENT_DOCS, type LegalDocSlug } from '@libriant/shared/legal';

/**
 * The sentence beside the signup checkbox, as data rather than JSX.
 *
 * privacy-legal-13: the label used to be three hard-coded fragments and two
 * hard-coded links — Terms and Privacy Policy — while the API recorded
 * acceptance against whatever `SIGNUP_CONSENT_DOCS` said. Adding the DPA to
 * that constant alone would have stamped `presented: true` on a document that
 * was never on screen, which is a worse record than the one the finding
 * complains about. So the label is built FROM the constant: a document is
 * either linked in front of the person and recorded as presented, or neither.
 *
 * It lives here, in a plain module, because `SignupForm` is a client component
 * and `lib/legal.ts` (which owns the doc→i18n-key mapping for the public legal
 * pages) reads markdown off disk with `node:fs`. It also makes the composition
 * testable without a DOM — see `consent-label.test.ts`, which is what fails if
 * a slug is added to `SIGNUP_CONSENT_DOCS` with no copy behind it.
 *
 * WHY THE LINK TEXT IS NOT `legal.docs.<doc>.title`. That is what the old label
 * used, and in Greek it was ungrammatical: the titles are nominative («Όροι
 * Χρήσης»), the sentence needs the accusative after «αποδέχομαι» («τους Όρους
 * Χρήσης»). A Greek librarian read "Έχω διαβάσει και αποδέχομαι τους Όροι
 * Χρήσης" on the one screen where they are being asked to bind their library.
 * `legal.consent.doc.<slug>` carries the inflected form, and
 * `legal.consent.article.<slug>` the article that agrees with it — Greek
 * articles are per-noun («τους» Όρους, «την» Πολιτική, «τη» Σύμβαση), so the
 * article cannot live in the connector the way it used to.
 */
export type ConsentLabelPart =
  { kind: 'text'; text: string } | { kind: 'link'; slug: LegalDocSlug; href: string; text: string };

export function consentLabelParts(
  t: Translator,
  locale: string,
  docs: readonly LegalDocSlug[] = SIGNUP_CONSENT_DOCS,
): ConsentLabelPart[] {
  const parts: ConsentLabelPart[] = [{ kind: 'text', text: `${t('legal.consent.pre')} ` }];

  docs.forEach((slug, i) => {
    if (i > 0) {
      const last = i === docs.length - 1;
      parts.push({ kind: 'text', text: last ? ` ${t('legal.consent.and')} ` : ', ' });
    }
    // No fallback on purpose: a missing key renders as the key itself and warns
    // in the console, which is loud. An empty-string fallback would silently
    // drop a document from a consent sentence the API is recording as shown.
    const article = t(`legal.consent.article.${slug}`);
    parts.push({ kind: 'text', text: `${article} ` });
    parts.push({
      kind: 'link',
      slug,
      href: `/${locale}/legal/${slug}`,
      text: t(`legal.consent.doc.${slug}`),
    });
  });

  parts.push({ kind: 'text', text: t('legal.consent.post') });
  return parts;
}
