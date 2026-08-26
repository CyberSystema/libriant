/**
 * privacy-legal-13. The signup checkbox is the only moment a library binds
 * itself to the Article 28 agreement, and the API writes `presented: true`
 * against every slug in `SIGNUP_CONSENT_DOCS` when it records that acceptance.
 * These tests hold the two halves together: whatever is in that list is LINKED
 * in the sentence, in both languages, with real copy behind it.
 *
 * The copy comes through `loadCatalog()` — the app's own loader, reading the
 * same `locales/{el,en}/legal.json` a request reads — rather than from a
 * fixture, because the failure being guarded against is a missing or misfiled
 * translation, and a fixture cannot be missing one.
 *
 * Run from `apps/web`: `node --import tsx --test "lib/**\/*.test.ts"`.
 */
import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { createTranslator, type Translator } from '@libriant/i18n';
import { SIGNUP_CONSENT_DOCS } from '@libriant/shared/legal';
import { consentLabelParts } from '@/lib/consent-label';
import { loadCatalog } from '@/lib/locale-loader';

// Through the app's OWN loader, so the keys are namespaced exactly as they are
// at request time and a key written into the wrong file fails here rather than
// on the signup page. Hand-building the catalog would test the fixture.
const t: Record<'el' | 'en', Translator> = {} as Record<'el' | 'en', Translator>;

before(async () => {
  for (const locale of ['el', 'en'] as const) {
    t[locale] = createTranslator(await loadCatalog(locale, ['legal']), locale);
  }
});

function translatorFor(locale: 'el' | 'en'): Translator {
  return t[locale];
}

function render(locale: 'el' | 'en'): string {
  return consentLabelParts(translatorFor(locale), locale)
    .map((p) => p.text)
    .join('');
}

test('every document recorded as presented is linked in the label', () => {
  for (const locale of ['el', 'en'] as const) {
    const linked = consentLabelParts(translatorFor(locale), locale)
      .filter((p) => p.kind === 'link')
      .map((p) => (p.kind === 'link' ? p.slug : ''));
    assert.deepEqual(
      linked,
      [...SIGNUP_CONSENT_DOCS],
      `${locale}: the label must link exactly the documents the acceptance record calls presented`,
    );
  }
});

test('the DPA is one of them, and points at the DPA page', () => {
  // The finding itself: an Article 28 agreement incorporated by reference into
  // a checkbox labelled "Terms and Privacy Policy", never shown, never named.
  assert.ok(SIGNUP_CONSENT_DOCS.includes('dpa'));
  for (const locale of ['el', 'en'] as const) {
    const dpa = consentLabelParts(translatorFor(locale), locale).find(
      (p) => p.kind === 'link' && p.slug === 'dpa',
    );
    assert.ok(dpa, `${locale}: no link to the DPA`);
    assert.equal(dpa.kind === 'link' ? dpa.href : '', `/${locale}/legal/dpa`);
  }
});

test('no document is rendered as a raw i18n key in either locale', () => {
  // What a missing `legal.consent.doc.<slug>` looks like on screen: the key.
  // This is the assertion that fails the day a slug is added to
  // SIGNUP_CONSENT_DOCS without copy, in either language.
  for (const locale of ['el', 'en'] as const) {
    for (const part of consentLabelParts(translatorFor(locale), locale)) {
      assert.ok(
        !part.text.includes('legal.consent.'),
        `${locale}: untranslated consent copy rendered as "${part.text}"`,
      );
      assert.ok(part.text.trim().length > 0 || part.text === ', ' || part.text === ' ');
    }
  }
});

test('the Greek sentence is grammatical after «αποδέχομαι»', () => {
  // Accusative, with the article each noun actually takes. The old label built
  // «τους» into the connector and used the nominative page titles, so it read
  // «αποδέχομαι τους Όροι Χρήσης … και την Σύμβαση».
  const el = render('el');
  assert.match(el, /αποδέχομαι τους Όρους Χρήσης, την Πολιτική Απορρήτου και τη Σύμβαση/);
  assert.ok(!el.includes('Όροι Χρήσης'), `nominative title leaked into the sentence: ${el}`);
});

test('the English sentence reads as one sentence', () => {
  assert.equal(
    render('en'),
    'I have read and agree to the Terms of Service, the Privacy Policy and the Data Processing Agreement.',
  );
});
