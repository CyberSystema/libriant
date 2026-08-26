import { controlDb, type Prisma } from '@libriant/db-control';
import { LEGAL_DOCUMENTS, LEGAL_VERSION, SIGNUP_CONSENT_DOCS } from '@libriant/shared';
import type { LegalDocSlug } from '@libriant/shared';

/**
 * Evidence of WHICH legal text a library agreed to (privacy-legal-09).
 *
 * ## The failure this exists for
 *
 * Signup wrote `legalAcceptedVersion` / `legalAcceptedAt` / `legalAcceptedIp`
 * and stopped. `LEGAL_VERSION` was a single date string covering all seven
 * documents, and the web app renders `locales/<locale>/legal/<slug>.md` from
 * disk at request time — so the "record" was a date pointing at a mutable file.
 * Edit one paragraph of the Privacy Policy without bumping the string and every
 * stored acceptance silently starts referring to text nobody ever saw. Article
 * 5(2) and 7(1) require the ability to DEMONSTRATE what was agreed; a date
 * pointing at HEAD demonstrates nothing.
 *
 * ## What replaces it
 *
 * Two artefacts, and the pairing is the point:
 *
 *  1. `docs/legal/accepted/<LEGAL_VERSION>/<locale>/<slug>.md` — a frozen copy
 *     of the PUBLISHED body of every document in that version (the leading
 *     author blockquote stripped, exactly as `apps/web/lib/legal.ts` strips it
 *     before rendering). Version-addressed and immutable: a new version means a
 *     new directory, never an edit in place.
 *  2. {@link LEGAL_CORPUS} below — the SHA-256 of each of those files, compiled
 *     into the API. Signup records these digests against the tenant, so an
 *     acceptance names the exact bytes and not just a date.
 *
 * `legal-acceptance.spec.ts` recomputes both from the live
 * `locales/*\/legal/*.md` and fails if any of the three disagree. That test is
 * the mechanism that makes a silent edit impossible: change a published
 * document and the suite tells you, with the new digest, that you owe a
 * `LEGAL_VERSION` bump and a new frozen directory.
 *
 * ## Why a compiled-in table of digests
 *
 * A digest cannot be wrong at runtime the way a file read can: it records what
 * the image was BUILT from, which is the same thing the visitor was served.
 *
 * ## What a digest still cannot do, and where the rest of the fix lives
 *
 * It cannot PRODUCE the text. Asked "what did this library agree to?", a hash
 * answers with 64 hex characters — which is why this file alone was not enough
 * and the finding was reopened. The bytes now live in the control database,
 * one immutable row per (version, locale, slug) in `legal_document_versions`,
 * written from the frozen directory above and read back over HTTP at
 * `GET /t/:slug/legal/consent/evidence`. See `consent.service.ts`; the digests
 * here are what lets that archived body be CHECKED against what was recorded at
 * acceptance time rather than merely believed.
 */

/**
 * SHA-256 of `docs/legal/accepted/<LEGAL_VERSION>/<locale>/<slug>.md`.
 *
 * REGENERATE WITH (from the repo root), then bump `LEGAL_VERSION` and re-freeze
 * the directory:
 *
 *   shasum -a 256 docs/legal/accepted/<version>/{el,en}/*.md
 *
 * Do not hand-edit a single entry to make the test pass — the test failing means
 * a published document changed, and a changed document needs a new version
 * directory, not a new hash under the old one.
 */
export const LEGAL_CORPUS: Readonly<Record<string, Readonly<Record<LegalDocSlug, string>>>> = {
  el: {
    terms: '95cd8b5087217546e4083eaecad014b82b07d01445950908b2467617a4d17dd4',
    privacy: 'a20e95812ef6d50a90a6f87eb6cbd8d3b611ba0d315dd6e34ee804f5117d887e',
    cookies: 'cb35380648534cdb6b5aab6ec3bb688baf6f868a2008911c5bd6ff510212819d',
    dpa: 'd7b4c2e524c2071ce5df8e4a178a3dbdd5fc1898cd756d7a3302612c025676c0',
    subprocessors: '7272a4f13ed9d83aacce4ec260a45be089228c4716a303d5e2c9377764d1c0dc',
    'acceptable-use': '44bbcf46559c16d613650c7ab7106c8d2ce1a044e681cefcf739d45410192728',
    'legal-notice': '22632c4148476815a0f89db4618ab3ac046829dcfe3cbf49607d67f6cbe01d6f',
  },
  en: {
    terms: '5a8ada982af524a560fb28e4c9d119c4edfe286ee867311f96fe92d4666f2a61',
    privacy: 'af5fd13d971c72c9bd2fc06903ed328090509e287f4608114a8a629c240ada75',
    cookies: '5067fd2f919a7b918bc948ef75e3e3518e4a48deffc0332edd089853491bc960',
    dpa: '4fe0557906650f643e317109665cae0685a4aa78f013f8c613a996047efc49f0',
    subprocessors: '89a135a1437eedaceff8ce994ee93a18e8502ecffaa5d381760881e228b35233',
    'acceptable-use': 'b52e48484e20ad4295ed230f0f2a88bd9d6713c8ec54d0d3a204e371c985818f',
    'legal-notice': 'f486b93c112134b1fc64b928e3ddb807cf5efcb321de4bd538798993d658566d',
  },
} as const;

/**
 * Interpret a locale string that was ALREADY STORED, falling back the way the
 * web app does.
 *
 * READ PATH ONLY. This used to be on the write path too, and that was the
 * second half of why attempt one at privacy-legal-09 was refuted: the signup
 * DTO's `defaultLocale` is optional, so an API signup that omitted it recorded
 * the GREEK corpus as the text presented — regardless of what the caller had
 * actually shown. Guessing is fine when re-reading a row whose locale we once
 * knew; it is not fine when minting the evidence. The write path now takes
 * {@link LegalLocaleStrict} and the DTO refuses a signup that will not say
 * which language of the Terms it displayed.
 */
export function acceptanceLocale(requested: string | undefined): 'el' | 'en' {
  return requested === 'en' ? 'en' : 'el';
}

/** The locales the legal corpus is actually published in. */
export type LegalLocaleStrict = 'el' | 'en';

/** Repo-relative path of the frozen copy — quotable in a dispute or a DSAR. */
export function archivePath(locale: string, slug: LegalDocSlug): string {
  return `docs/legal/accepted/${LEGAL_VERSION}/${locale}/${slug}.md`;
}

export type AcceptedDocument = {
  slug: LegalDocSlug;
  sha256: string;
  archivePath: string;
  /** True for the documents the owner ticked, false for those incorporated by reference. */
  presented: boolean;
};

export type LegalAcceptanceEvidence = {
  version: string;
  locale: 'el' | 'en';
  documents: AcceptedDocument[];
};

/**
 * The evidence bundle for one acceptance.
 *
 * Covers ALL seven documents, not just the two behind the signup checkbox:
 * `LEGAL_VERSION` is one stamp over the whole corpus, and the Terms incorporate
 * the DPA and the Acceptable Use Policy by reference, so an acceptance record
 * that fingerprints only `terms` and `privacy` still cannot say what the DPA
 * said on that day. `presented` marks which two were actually shown, so the
 * record does not overclaim.
 */
export function legalAcceptanceEvidence(locale: LegalLocaleStrict): LegalAcceptanceEvidence {
  const digests = LEGAL_CORPUS[locale];
  // Defence in depth behind the type. The failure this replaces was silent: an
  // unrecognised locale used to resolve to the Greek corpus and the acceptance
  // was written naming documents the person had never seen. A throw is the only
  // safe behaviour here — there is no correct guess.
  if (!digests) {
    throw new Error(
      `No frozen legal corpus for locale "${String(locale)}" at version ${LEGAL_VERSION}. ` +
        'Refusing to record an acceptance against a corpus that was not published.',
    );
  }
  return {
    version: LEGAL_VERSION,
    locale,
    documents: LEGAL_DOCUMENTS.map((slug) => ({
      slug,
      sha256: digests[slug],
      archivePath: archivePath(locale, slug),
      presented: SIGNUP_CONSENT_DOCS.includes(slug),
    })),
  };
}

export type AcceptanceActor = {
  userId: string;
  fullName: string;
  email: string;
  ip?: string;
};

/**
 * Build the `tenant.legal_accepted` control-plane audit row.
 *
 * Returned as data rather than written here so the caller can put it INSIDE the
 * transaction that creates the Tenant and the owner User. That is deliberate:
 * a library must not be able to exist without the record of what it agreed to,
 * and "best-effort audit" — correct for a checkout, where losing a row must not
 * fail the sale — is the wrong posture for the evidence of contract formation.
 * Same transaction, so both rows land or neither does.
 */
export function legalAcceptanceAuditData(input: {
  tenantId: string;
  actor: AcceptanceActor;
  acceptedAt: Date;
  /** The corpus that was ON SCREEN. */
  presentedLocale: LegalLocaleStrict;
  /**
   * Did the caller actually TELL us that, or is `presentedLocale` the default?
   *
   * privacy-legal-09: the old code could not tell the difference, so a signup
   * that omitted the locale produced a record indistinguishable from one that
   * declared Greek. Recording the distinction is the difference between
   * evidence and a plausible-looking assertion — and both translations of the
   * version are archived either way, so nothing is unrecoverable.
   */
  localeAsserted: boolean;
}): Prisma.AuditEventUncheckedCreateInput {
  const evidence = legalAcceptanceEvidence(input.presentedLocale);
  return {
    tenantId: input.tenantId,
    actorType: 'user',
    actorId: input.actor.userId,
    action: 'tenant.legal_accepted',
    targetType: 'tenant',
    targetId: input.tenantId,
    afterJson: {
      version: evidence.version,
      locale: evidence.locale,
      localeAsserted: input.localeAsserted,
      acceptedAt: input.acceptedAt.toISOString(),
      // WHO accepted, in what capacity (Terms §2.4 — the public-body
      // authority-to-bind warranty is worth exactly as much as the record of
      // who gave it).
      acceptedBy: {
        userId: input.actor.userId,
        fullName: input.actor.fullName,
        email: input.actor.email,
        role: 'owner',
      },
      // WHAT they accepted, to the byte.
      documents: evidence.documents,
    } as unknown as Prisma.InputJsonValue,
    ip: input.actor.ip ?? null,
  };
}

/**
 * Read back the acceptance evidence for a tenant — newest first.
 *
 * The finding's other half is that nothing ever READ what signup wrote, so the
 * evidence has to be answerable without git archaeology: given a tenant id this
 * returns who accepted, when, from where, and the digest + frozen path of every
 * document, which is what an HDPA file or a contract dispute needs.
 *
 * This is the low-level reader over `audit_log`. The MOUNTED read path is
 * `ConsentController` (`GET /t/:slug/legal/consent` and `…/consent/evidence`),
 * which additionally joins the archived bodies so the answer is the text and
 * not just its fingerprint. Shipping this function with nothing calling it was
 * half of why the first attempt was refuted; it is kept because the integration
 * test uses it as an INDEPENDENT second view of the same row, and a fixture
 * that reads the same code path it asserts proves nothing.
 */
export async function readLegalAcceptance(tenantId: string) {
  const rows = await controlDb.auditEvent.findMany({
    where: { tenantId, action: 'tenant.legal_accepted' },
    orderBy: { occurredAt: 'desc' },
    select: { id: true, occurredAt: true, actorId: true, ip: true, afterJson: true },
  });
  return rows.map((r) => ({
    id: r.id,
    acceptedAt: r.occurredAt,
    userId: r.actorId,
    ip: r.ip,
    evidence: r.afterJson as unknown as {
      version: string;
      locale: string;
      acceptedBy: { userId: string; fullName: string; email: string; role: string };
      documents: AcceptedDocument[];
    } | null,
  }));
}
