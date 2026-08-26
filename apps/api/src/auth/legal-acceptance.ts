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
 * ## Why a compiled-in table rather than reading the markdown at runtime
 *
 * The API container has no reliable copy of `locales/` to read — boot-and-config
 * found that `LOCALES_ROOT` is set for the API, which reads nothing, and NOT set
 * for the web app, which serves the documents from the copy baked into its image
 * at build time. A runtime file read would therefore be recording a file that
 * may not exist next to the process, while the bytes the visitor actually saw
 * came from the build. Compiling the digests in records the build, which is the
 * same thing the visitor was served, and cannot fail at runtime.
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
    cookies: '708177ff6fbe16b29179eba9407b5cf48b122c98b7572d52ccc7055c3299aa82',
    dpa: '8dee3cff7a67a5d55dcc40746d6e6206e0eeeb316d58f0a6353478b2c90f7f24',
    subprocessors: '7272a4f13ed9d83aacce4ec260a45be089228c4716a303d5e2c9377764d1c0dc',
    'acceptable-use': '44bbcf46559c16d613650c7ab7106c8d2ce1a044e681cefcf739d45410192728',
    'legal-notice': '135c3f2377e4ab35f6f412727c219b261f56c39d7d28ab5f8f8a4e1606567206',
  },
  en: {
    terms: '5a8ada982af524a560fb28e4c9d119c4edfe286ee867311f96fe92d4666f2a61',
    privacy: 'af5fd13d971c72c9bd2fc06903ed328090509e287f4608114a8a629c240ada75',
    cookies: 'fd818262e063c472e6ed14ba61b8fc57585d86e1730bad698b8118668b913d62',
    dpa: '02f1883cb8ce062d137626d20861d66bc92a83dd4e83f3b96b9e94a72e9768a2',
    subprocessors: '89a135a1437eedaceff8ce994ee93a18e8502ecffaa5d381760881e228b35233',
    'acceptable-use': 'b52e48484e20ad4295ed230f0f2a88bd9d6713c8ec54d0d3a204e371c985818f',
    'legal-notice': 'e6c4abdbda48d7fc777f31e07f42d214a697694cdc052e2435f60a49b5793271',
  },
} as const;

/** Locale whose documents were shown, falling back the way the web app does. */
export function acceptanceLocale(requested: string | undefined): 'el' | 'en' {
  return requested === 'en' ? 'en' : 'el';
}

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
export function legalAcceptanceEvidence(
  requestedLocale: string | undefined,
): LegalAcceptanceEvidence {
  const locale = acceptanceLocale(requestedLocale);
  const digests = LEGAL_CORPUS[locale]!;
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
  requestedLocale: string | undefined;
}): Prisma.AuditEventUncheckedCreateInput {
  const evidence = legalAcceptanceEvidence(input.requestedLocale);
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
 * ⚠️ **No HTTP route mounts this yet, and that is a known gap, not an
 * oversight.** The two remaining pieces of privacy-legal-09 are both `apps/web`
 * work and are tracked separately: an admin screen showing a library's
 * acceptance record, and the re-acceptance prompt that compares
 * `user.legalAcceptedVersion` against `LEGAL_VERSION` at sign-in. Until the
 * screen exists the evidence is reachable from a Node console or a psql query
 * against `audit_log WHERE action = 'tenant.legal_accepted'`, and
 * `test/integration/legal-acceptance.spec.ts` drives this function to prove the
 * record it would show is actually there and actually correct.
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
