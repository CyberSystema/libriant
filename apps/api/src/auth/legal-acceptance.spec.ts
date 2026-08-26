import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEGAL_DOCUMENTS, LEGAL_VERSION, SIGNUP_CONSENT_DOCS } from '@libriant/shared';
import type { LegalDocSlug } from '@libriant/shared';
import {
  acceptanceLocale,
  LEGAL_CORPUS,
  archivePath,
  legalAcceptanceAuditData,
  legalAcceptanceEvidence,
} from './legal-acceptance.js';

/**
 * The enforcement behind privacy-legal-09.
 *
 * An acceptance record that names a SHA-256 is only worth something if that
 * digest is provably the text a visitor was served. Three independent artefacts
 * have to agree, and this file is what makes disagreement loud:
 *
 *   A. `locales/<locale>/legal/<slug>.md` — what the web app renders TODAY,
 *      minus the leading author blockquote it strips before rendering.
 *   B. `docs/legal/accepted/<LEGAL_VERSION>/<locale>/<slug>.md` — the frozen
 *      copy of that same body for this version.
 *   C. `LEGAL_CORPUS` in legal-acceptance.ts — the digests the API records.
 *
 * These are three separate files on disk, not one value compared to itself, so
 * an edit to any published legal document fails here with the new digest and
 * the instruction that it owes a `LEGAL_VERSION` bump plus a fresh frozen
 * directory. Before this existed, such an edit silently retargeted every
 * acceptance already recorded — a date string pointing at a mutable file.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
// apps/api/src/auth → repo root
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const LOCALES = ['el', 'en'] as const;

/** Mirrors stripAuthorNote() in apps/web/lib/legal.ts and splitNote() in
 *  scripts/check-legal-docs.mjs — the leading blockquote is author-facing and
 *  is never rendered, so it is not part of what anyone accepted. */
function publishedBody(raw: string): string {
  const lines = raw.split('\n');
  if (lines[0]?.startsWith('>') !== true) return raw;
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith('>')) i++;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  return lines.slice(i).join('\n');
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function liveDigest(locale: string, slug: LegalDocSlug): string {
  const raw = readFileSync(path.join(REPO, 'locales', locale, 'legal', `${slug}.md`), 'utf8');
  return sha256(publishedBody(raw));
}

function frozenBody(locale: string, slug: LegalDocSlug): string {
  return readFileSync(path.join(REPO, archivePath(locale, slug)), 'utf8');
}

describe('legal acceptance evidence', () => {
  it('freezes a copy of every published document for this LEGAL_VERSION', () => {
    for (const locale of LOCALES) {
      for (const slug of LEGAL_DOCUMENTS) {
        expect(
          () => frozenBody(locale, slug),
          `${archivePath(locale, slug)} is missing. LEGAL_VERSION is "${LEGAL_VERSION}"; ` +
            'every published version needs its own frozen directory.',
        ).not.toThrow();
      }
    }
  });

  it('the frozen copy is byte-identical to what the web app renders today', () => {
    for (const locale of LOCALES) {
      for (const slug of LEGAL_DOCUMENTS) {
        const live = readFileSync(
          path.join(REPO, 'locales', locale, 'legal', `${slug}.md`),
          'utf8',
        );
        expect(
          frozenBody(locale, slug),
          `locales/${locale}/legal/${slug}.md has changed since ${LEGAL_VERSION} was frozen.\n` +
            'A published legal document changed without a version bump, which silently\n' +
            'retargets every acceptance already recorded. Bump LEGAL_VERSION in\n' +
            'packages/shared/src/legal.ts, re-freeze docs/legal/accepted/<new version>/,\n' +
            'and update LEGAL_CORPUS.',
        ).toBe(publishedBody(live));
      }
    }
  });

  it('LEGAL_CORPUS carries the digest of each frozen document', () => {
    for (const locale of LOCALES) {
      for (const slug of LEGAL_DOCUMENTS) {
        const fromArchive = sha256(frozenBody(locale, slug));
        expect(
          LEGAL_CORPUS[locale]?.[slug],
          `LEGAL_CORPUS.${locale}["${slug}"] does not match ${archivePath(locale, slug)}.\n` +
            `Expected ${fromArchive}. Regenerate with:\n` +
            `  shasum -a 256 docs/legal/accepted/${LEGAL_VERSION}/{el,en}/*.md`,
        ).toBe(fromArchive);
      }
    }
  });

  it('the digests the API records match the live documents, not just the archive', () => {
    // Belt and braces: if the archive and LEGAL_CORPUS were regenerated from
    // each other while `locales/` moved on, the two tests above could both pass
    // against stale bytes. This one closes that loop against the live files.
    for (const locale of LOCALES) {
      for (const slug of LEGAL_DOCUMENTS) {
        expect(LEGAL_CORPUS[locale]?.[slug]).toBe(liveDigest(locale, slug));
      }
    }
  });

  it('records every document in the version, flagging the ones actually presented', () => {
    const evidence = legalAcceptanceEvidence('el');
    expect(evidence.version).toBe(LEGAL_VERSION);
    expect(evidence.locale).toBe('el');
    expect(evidence.documents.map((d) => d.slug)).toEqual([...LEGAL_DOCUMENTS]);

    const presented = evidence.documents.filter((d) => d.presented).map((d) => d.slug);
    expect(presented).toEqual([...SIGNUP_CONSENT_DOCS]);

    // privacy-legal-13: the DPA is one of them now. It used to be flagged
    // `presented: false` here — correctly, because the signup label linked the
    // Terms and the Privacy Policy and nothing else, and the Article 28
    // agreement reached the library only through Terms §5's incorporation by
    // reference. The label is now built from SIGNUP_CONSENT_DOCS
    // (apps/web/lib/consent-label.ts), so this flag and the screen cannot
    // disagree.
    const dpa = evidence.documents.find((d) => d.slug === 'dpa');
    expect(dpa?.presented).toBe(true);
    expect(dpa?.sha256).toBe(liveDigest('el', 'dpa'));
    expect(dpa?.archivePath).toBe(`docs/legal/accepted/${LEGAL_VERSION}/el/dpa.md`);

    // A document that is still only incorporated by reference has to be
    // fingerprinted all the same — otherwise nobody can say later what the
    // Acceptable Use Policy said on the day the Terms that bind it were
    // accepted.
    const aup = evidence.documents.find((d) => d.slug === 'acceptable-use');
    expect(aup?.presented).toBe(false);
    expect(aup?.sha256).toBe(liveDigest('el', 'acceptable-use'));
  });

  it('will not mint evidence for a locale it was not told about', () => {
    // The refutation of the first attempt: `defaultLocale` was optional and the
    // locale helper fell back to 'el', so an API signup that omitted it recorded
    // the GREEK corpus as the text presented, whatever had been on screen. The
    // write path no longer guesses — it takes 'el' | 'en' and the DTO enforces
    // it (see dto/signup-consent.spec.ts). These two calls are what the type
    // system now refuses, kept as a runtime witness that the OLD behaviour is
    // gone rather than merely discouraged.
    // Reached through an `unknown` cast because the signature no longer admits
    // these values at all — which is the fix. If someone widens the parameter
    // back to `string | undefined`, the two assertions below start failing
    // (they would return 'el') and this test says why that matters.
    const loose = legalAcceptanceEvidence as unknown as (l: unknown) => { locale: string } | never;
    expect(() => loose(undefined)).toThrow();
    expect(() => loose('fr')).toThrow();

    expect(legalAcceptanceEvidence('en').locale).toBe('en');
    expect(legalAcceptanceEvidence('en').documents[0]!.sha256).toBe(liveDigest('en', 'terms'));
    expect(legalAcceptanceEvidence('el').locale).toBe('el');

    // …while the READ helper stays lenient, because it interprets locales that
    // were already stored and a historic row must still be readable.
    expect(acceptanceLocale(undefined)).toBe('el');
    expect(acceptanceLocale('fr')).toBe('el');
    expect(acceptanceLocale('en')).toBe('en');
  });

  it('builds an audit row naming who accepted and the exact bytes', () => {
    const acceptedAt = new Date('2026-08-26T10:00:00.000Z');
    const data = legalAcceptanceAuditData({
      tenantId: 'tenant-1',
      actor: {
        userId: 'user-1',
        fullName: 'Μαρία Παπαδοπούλου',
        email: 'maria@example.gr',
        ip: '198.51.100.9',
      },
      acceptedAt,
      presentedLocale: 'el',
      localeAsserted: true,
    });

    expect(data.action).toBe('tenant.legal_accepted');
    expect(data.tenantId).toBe('tenant-1');
    expect(data.actorType).toBe('user');
    expect(data.actorId).toBe('user-1');
    expect(data.ip).toBe('198.51.100.9');

    const after = data.afterJson as unknown as {
      version: string;
      locale: string;
      acceptedAt: string;
      acceptedBy: { userId: string; fullName: string; email: string; role: string };
      documents: Array<{ slug: string; sha256: string; archivePath: string }>;
    };
    expect(after.version).toBe(LEGAL_VERSION);
    expect(after.locale).toBe('el');
    expect(after.acceptedAt).toBe(acceptedAt.toISOString());
    expect(after.acceptedBy).toEqual({
      userId: 'user-1',
      fullName: 'Μαρία Παπαδοπούλου',
      email: 'maria@example.gr',
      role: 'owner',
    });
    expect(after.documents).toHaveLength(LEGAL_DOCUMENTS.length);
    // The digest in the row must be the digest of the file on disk — the whole
    // claim of the fix.
    const terms = after.documents.find((d) => d.slug === 'terms')!;
    expect(terms.sha256).toBe(liveDigest('el', 'terms'));
    expect(terms.archivePath).toBe(`docs/legal/accepted/${LEGAL_VERSION}/el/terms.md`);
  });
});
