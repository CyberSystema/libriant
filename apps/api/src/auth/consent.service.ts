import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { controlDb, type Prisma } from '@libriant/db-control';
import { LEGAL_DOCUMENTS, LEGAL_VERSION, SIGNUP_CONSENT_DOCS } from '@libriant/shared';
import type { LegalDocSlug } from '@libriant/shared';
import { LEGAL_LOCALES, type LegalLocale } from './consent-locales.js';
import {
  LEGAL_CORPUS,
  acceptanceLocale,
  legalAcceptanceAuditData,
  type AcceptedDocument,
} from './legal-acceptance.js';

/**
 * privacy-legal-09 — the half the first attempt did not close.
 *
 * ## What was wrong with the first attempt
 *
 * Attempt one froze a copy of every document under
 * `docs/legal/accepted/<version>/` and compiled a SHA-256 per file into the
 * API, then wrote those digests onto a `tenant.legal_accepted` audit row. That
 * is a real improvement — but it was refuted on three specific points, and all
 * three are what this file exists for:
 *
 *  1. **Nothing read it.** `readLegalAcceptance()` shipped with a comment
 *     admitting no HTTP route mounted it. A reader nothing calls is not
 *     evidence; it is a function. {@link ConsentController} mounts this service
 *     at `GET /t/:slug/legal/consent/evidence`, and the integration test drives
 *     that route over HTTP.
 *  2. **A digest cannot PRODUCE the text.** A hash proves a document has not
 *     changed. Asked "what did this library agree to?", it answers with 64 hex
 *     characters. The bytes lived only in the git tree — not in a backup, not
 *     next to the acceptance, and gone from a running deployment the moment the
 *     documents were revised. `legal_document_versions` now stores the body
 *     itself, version-addressed and immutable, in the control database.
 *  3. **The version bump orphaned every earlier acceptance.** Attempt one moved
 *     `LEGAL_VERSION` from `2026-06-22` to `2026-08-26`; nothing compared a
 *     stored version against the current one, so a library that accepted the
 *     old text was silently stamped as agreeing to text it had never seen and
 *     nothing ever asked it to re-accept. {@link ConsentService.stateFor} does
 *     that comparison — it is the first code in the repo to READ
 *     `legalAcceptedVersion` — and `POST …/consent/accept` is the flow that
 *     clears it.
 *
 * ## Where the bytes come from
 *
 * `docs/legal/accepted/<version>/<locale>/<slug>.md` is the frozen copy. It is
 * loaded ONCE per version and upserted into `legal_document_versions`; from
 * then on the database is the source of truth, so the evidence survives a
 * redeploy, a repo rewrite and a restore-from-backup.
 *
 * The loader has a deliberate second source: if the frozen directory is not on
 * disk (it is copied into the API image, but an image built before that COPY
 * existed would not have it) it falls back to the live
 * `locales/<locale>/legal/<slug>.md` — and ONLY accepts it when the file hashes
 * to the digest compiled into {@link LEGAL_CORPUS} for the current version.
 * Equal hash means identical bytes, so nothing is being trusted here; and the
 * alternative — a missing directory turning every signup into a 500 — is a
 * deploy-breaker introduced by a compliance fix, which is exactly the trade
 * this remediation keeps being caught making.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
// apps/api/src/auth → repo root (mirrors the ASSETS_ROOT default in config/env.ts).
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

/** Where the frozen, version-addressed copies live. Overridable for tests. */
export const LEGAL_ARCHIVE_ROOT =
  process.env.LEGAL_ARCHIVE_ROOT?.trim() || path.join(REPO_ROOT, 'docs', 'legal', 'accepted');

/** The live (mutable) corpus the web app renders. Fallback source only. */
const LOCALES_ROOT = process.env.LOCALES_ROOT?.trim() || path.join(REPO_ROOT, 'locales');

export function sha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Drop the leading blockquote — an AUTHOR-FACING drafting note by convention.
 *
 * `apps/web/lib/legal.ts` strips it before rendering, so the bytes a visitor
 * actually saw are the file MINUS that block. Archiving the raw file would
 * archive something nobody was shown, which defeats the purpose.
 */
function stripAuthorNote(raw: string): string {
  const lines = raw.split('\n');
  if (lines[0]?.startsWith('>') !== true) return raw;
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith('>')) i++;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  return lines.slice(i).join('\n');
}

type LoadedDoc = { body: string; sha256: string; sourcePath: string };

/**
 * Read one frozen document off disk. `null` when neither source can supply it.
 * The fallback is gated on the digest so it can never substitute different text.
 */
export function loadArchivedFile(
  version: string,
  locale: LegalLocale,
  slug: LegalDocSlug,
): LoadedDoc | null {
  const rel = `docs/legal/accepted/${version}/${locale}/${slug}.md`;
  try {
    const body = readFileSync(path.join(LEGAL_ARCHIVE_ROOT, version, locale, `${slug}.md`), 'utf8');
    return { body, sha256: sha256(body), sourcePath: rel };
  } catch {
    /* fall through to the digest-gated fallback below */
  }
  if (version !== LEGAL_VERSION) return null;
  const expected = LEGAL_CORPUS[locale]?.[slug];
  if (!expected) return null;
  try {
    const raw = readFileSync(path.join(LOCALES_ROOT, locale, 'legal', `${slug}.md`), 'utf8');
    const body = stripAuthorNote(raw);
    // Only usable if it is byte-identical to what the frozen copy would hold.
    if (sha256(body) !== expected) return null;
    return { body, sha256: expected, sourcePath: `locales/${locale}/legal/${slug}.md` };
  } catch {
    return null;
  }
}

export type ConsentDocument = {
  slug: LegalDocSlug;
  /** True for the documents behind the signup checkbox; false = incorporated by reference. */
  presented: boolean;
  sha256: string;
  archivePath: string;
  /** The exact published markdown. `null` only if the archive row is missing. */
  body: string | null;
  /**
   * Whether the digest recorded at acceptance time equals the digest of the
   * archived body. `null` when the acceptance predates per-document digests.
   */
  digestMatchesAcceptance: boolean | null;
};

export type ConsentState = {
  currentVersion: string;
  /** What `tenants.legalAcceptedVersion` says — the column nothing used to read. */
  acceptedVersion: string | null;
  acceptedAt: Date | null;
  acceptedLocale: string | null;
  /** The whole point of reading the column: has the published text moved on? */
  reacceptanceRequired: boolean;
  /**
   * Whether the caller declared which translation was displayed, or the record
   * fell back to the default. `null` when nothing has been accepted yet.
   */
  acceptedLocaleAsserted: boolean | null;
  /** True when a version was accepted but no per-document evidence was recorded. */
  evidenceMissing: boolean;
};

export type ConsentEvidence = ConsentState & {
  acceptances: Array<{
    id: string;
    acceptedAt: Date;
    version: string;
    locale: string;
    ip: string | null;
    acceptedBy: { userId: string; fullName: string; email: string; role: string } | null;
    /** False = the locale below is the default, not something the caller declared. */
    localeAsserted: boolean;
    documents: ConsentDocument[];
  }>;
};

type StoredEvidence = {
  version?: string;
  locale?: string;
  localeAsserted?: boolean;
  acceptedAt?: string;
  acceptedBy?: { userId: string; fullName: string; email: string; role: string };
  documents?: AcceptedDocument[];
};

const archiveLogger = new Logger('LegalArchive');
/** One archive load per version per process — signup calls this on every request. */
const inflightArchive = new Map<string, Promise<void>>();

/**
 * Make sure every document of `version` is in `legal_document_versions`.
 *
 * Called before ANY acceptance is recorded (signup and re-acceptance alike) and
 * by the control-plane seed, so a library can never end up holding a version
 * stamp whose text cannot be produced. Idempotent and write-once: a row that
 * already exists is left alone — and if its digest disagrees with the file on
 * disk that is a published document being edited under a version stamp somebody
 * has already accepted, which is the exact silent corruption this finding is
 * about, so it throws instead of overwriting.
 *
 * A free function rather than a method because `SignupService` needs it and
 * lives in a different Nest module; making it a provider would mean editing
 * `auth.module.ts`, which this change does not own.
 */
export function ensureLegalArchive(version: string = LEGAL_VERSION): Promise<void> {
  let inflight = inflightArchive.get(version);
  if (!inflight) {
    inflight = doEnsureLegalArchive(version).catch((err: unknown) => {
      // Do not cache a failure: a transient DB blip must not poison the process
      // for its lifetime.
      inflightArchive.delete(version);
      throw err;
    });
    inflightArchive.set(version, inflight);
  }
  return inflight;
}

async function doEnsureLegalArchive(version: string): Promise<void> {
  const existing = await controlDb.legalDocumentVersion.findMany({
    where: { version },
    select: { locale: true, slug: true, sha256: true },
  });
  const have = new Map(existing.map((r) => [`${r.locale}:${r.slug}`, r.sha256]));

  const missing: Prisma.LegalDocumentVersionCreateManyInput[] = [];
  for (const locale of LEGAL_LOCALES) {
    for (const slug of LEGAL_DOCUMENTS) {
      const key = `${locale}:${slug}`;
      const loaded = loadArchivedFile(version, locale, slug);
      const already = have.get(key);
      if (already) {
        if (loaded && loaded.sha256 !== already) {
          throw new Error(
            `Legal archive conflict: ${version}/${locale}/${slug} is already archived as ` +
              `${already} but the file on disk hashes to ${loaded.sha256}. A published ` +
              `document changed without a LEGAL_VERSION bump — bump the version and freeze a ` +
              `new docs/legal/accepted/<version>/ directory instead of editing an accepted one.`,
          );
        }
        continue;
      }
      if (!loaded) {
        throw new Error(
          `Cannot archive legal document ${version}/${locale}/${slug}: no frozen copy at ` +
            `${LEGAL_ARCHIVE_ROOT}/${version}/${locale}/${slug}.md and the live ` +
            `locales/${locale}/legal/${slug}.md does not match the digest compiled into ` +
            `LEGAL_CORPUS. Refusing to record consent to text that cannot be produced later.`,
        );
      }
      missing.push({
        version,
        locale,
        slug,
        sha256: loaded.sha256,
        body: loaded.body,
        sourcePath: loaded.sourcePath,
      });
    }
  }
  if (missing.length === 0) return;
  // skipDuplicates: two API processes (or the seed and a signup) can race here;
  // the unique index decides and the loser is a no-op rather than a 500.
  await controlDb.legalDocumentVersion.createMany({ data: missing, skipDuplicates: true });
  archiveLogger.log(`archived ${missing.length} legal document(s) for version ${version}`);
}

@Injectable()
export class ConsentService {
  /** Kept as a method so controllers/tests can reach it through DI. */
  ensureArchived(version: string = LEGAL_VERSION): Promise<void> {
    return ensureLegalArchive(version);
  }

  /**
   * READ `tenants.legalAcceptedVersion` and say whether it is still current.
   *
   * This is the comparison the audit asked for and the refutation said did not
   * exist ("nothing in the code detects the mismatch because nothing reads the
   * column").
   */
  async stateFor(tenantId: string): Promise<ConsentState> {
    const tenant = await controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: { legalAcceptedVersion: true, legalAcceptedAt: true },
    });
    if (!tenant) throw new NotFoundException('Library not found.');

    const latest = await controlDb.auditEvent.findFirst({
      where: { tenantId, action: 'tenant.legal_accepted' },
      orderBy: { occurredAt: 'desc' },
      select: { afterJson: true },
    });
    const stored = (latest?.afterJson ?? null) as StoredEvidence | null;

    return {
      currentVersion: LEGAL_VERSION,
      acceptedVersion: tenant.legalAcceptedVersion,
      acceptedAt: tenant.legalAcceptedAt,
      acceptedLocale: stored?.locale ?? null,
      acceptedLocaleAsserted: stored ? (stored.localeAsserted ?? false) : null,
      reacceptanceRequired: tenant.legalAcceptedVersion !== LEGAL_VERSION,
      evidenceMissing: tenant.legalAcceptedVersion != null && stored == null,
    };
  }

  /**
   * The full record: who accepted, when, from where, and the exact text of
   * every document in the version they were shown.
   */
  async evidenceFor(tenantId: string): Promise<ConsentEvidence> {
    const state = await this.stateFor(tenantId);
    const rows = await controlDb.auditEvent.findMany({
      where: { tenantId, action: 'tenant.legal_accepted' },
      orderBy: { occurredAt: 'desc' },
      select: { id: true, occurredAt: true, ip: true, afterJson: true },
    });

    const acceptances = [];
    for (const row of rows) {
      const stored = (row.afterJson ?? {}) as StoredEvidence;
      const version = stored.version ?? state.acceptedVersion ?? LEGAL_VERSION;
      const locale = acceptanceLocale(stored.locale);
      const bodies = await controlDb.legalDocumentVersion.findMany({
        where: { version, locale },
        select: { slug: true, sha256: true, body: true, sourcePath: true },
      });
      const byslug = new Map(bodies.map((b) => [b.slug, b]));
      const recorded = new Map((stored.documents ?? []).map((d) => [d.slug, d]));

      const documents: ConsentDocument[] = LEGAL_DOCUMENTS.map((slug) => {
        const archivedDoc = byslug.get(slug) ?? null;
        const acceptedDoc = recorded.get(slug) ?? null;
        return {
          slug,
          presented: acceptedDoc?.presented ?? SIGNUP_CONSENT_DOCS.includes(slug),
          sha256: archivedDoc?.sha256 ?? acceptedDoc?.sha256 ?? '',
          archivePath:
            archivedDoc?.sourcePath ??
            acceptedDoc?.archivePath ??
            `docs/legal/accepted/${version}/${locale}/${slug}.md`,
          body: archivedDoc?.body ?? null,
          digestMatchesAcceptance:
            archivedDoc && acceptedDoc ? archivedDoc.sha256 === acceptedDoc.sha256 : null,
        };
      });

      acceptances.push({
        id: row.id,
        acceptedAt: row.occurredAt,
        version,
        locale,
        ip: row.ip,
        acceptedBy: stored.acceptedBy ?? null,
        localeAsserted: stored.localeAsserted ?? false,
        documents,
      });
    }
    return { ...state, acceptances };
  }

  /**
   * Record an acceptance of the CURRENT version for a library that is on an
   * older one (or on none). Writes the same three artefacts signup writes — the
   * tenant stamp, the accepting user's stamp, and the evidence audit row — in
   * one transaction, after the archive is guaranteed present.
   */
  async recordAcceptance(input: {
    tenantId: string;
    userId: string;
    locale: LegalLocale;
    ip?: string | null;
  }): Promise<ConsentState> {
    await ensureLegalArchive(LEGAL_VERSION);

    const user = await controlDb.user.findFirst({
      where: { id: input.userId, tenantId: input.tenantId },
      select: { id: true, fullName: true, email: true, role: true },
    });
    if (!user) throw new NotFoundException('User not found in this library.');

    const acceptedAt = new Date();
    await controlDb.$transaction(async (tx) => {
      await tx.tenant.update({
        where: { id: input.tenantId },
        data: { legalAcceptedVersion: LEGAL_VERSION, legalAcceptedAt: acceptedAt },
      });
      await tx.user.update({
        where: { id: user.id },
        data: {
          legalAcceptedVersion: LEGAL_VERSION,
          legalAcceptedAt: acceptedAt,
          legalAcceptedIp: input.ip ?? null,
        },
      });
      // Same transaction as the stamps, for the same reason signup does it:
      // a library must never carry a version stamp without the record of what
      // that version said.
      await tx.auditEvent.create({
        data: legalAcceptanceAuditData({
          tenantId: input.tenantId,
          actor: {
            userId: user.id,
            fullName: user.fullName,
            email: user.email ?? '',
            ip: input.ip ?? undefined,
          },
          acceptedAt,
          presentedLocale: input.locale,
          // The re-acceptance route REQUIRES the locale in its body, so unlike
          // signup this is always a declared fact.
          localeAsserted: true,
        }),
      });
    });
    return this.stateFor(input.tenantId);
  }
}
