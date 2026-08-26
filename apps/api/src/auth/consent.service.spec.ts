import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGAL_DOCUMENTS, LEGAL_VERSION } from '@libriant/shared';
import { LEGAL_CORPUS } from './legal-acceptance.js';

/**
 * The document loader behind the consent record (privacy-legal-09).
 *
 * Two properties are worth a unit test because both are load-bearing and both
 * are silent when broken:
 *
 *  1. The frozen copy under `docs/legal/accepted/<version>/` really is the
 *     published text — if it drifts, every acceptance record points at bytes
 *     nobody was shown, which is the original defect wearing a different hat.
 *  2. The fallback to the live `locales/` tree is DIGEST-GATED. It exists so a
 *     missing archive directory cannot turn every signup into a 500, but a
 *     fallback that served whatever it found would quietly reintroduce
 *     "acceptance points at a mutable file". It has to refuse text that does
 *     not hash to the compiled expectation.
 *
 * The module reads its roots from the environment at import time, so each case
 * resets the module registry and re-imports — testing the shipped code path
 * rather than a parameterised copy of it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
// apps/api/src/auth → repo root
const REPO = path.resolve(HERE, '..', '..', '..', '..');

const ORIGINAL_ARCHIVE = process.env.LEGAL_ARCHIVE_ROOT;
const ORIGINAL_LOCALES = process.env.LOCALES_ROOT;

afterEach(() => {
  if (ORIGINAL_ARCHIVE === undefined) delete process.env.LEGAL_ARCHIVE_ROOT;
  else process.env.LEGAL_ARCHIVE_ROOT = ORIGINAL_ARCHIVE;
  if (ORIGINAL_LOCALES === undefined) delete process.env.LOCALES_ROOT;
  else process.env.LOCALES_ROOT = ORIGINAL_LOCALES;
  vi.resetModules();
});

async function freshModule() {
  vi.resetModules();
  return import('./consent.service.js');
}

describe('the frozen legal archive', () => {
  it('holds the published text of every document, in both locales', async () => {
    const { loadArchivedFile } = await freshModule();
    for (const locale of ['el', 'en'] as const) {
      for (const slug of LEGAL_DOCUMENTS) {
        const doc = loadArchivedFile(LEGAL_VERSION, locale, slug);
        expect(doc, `no frozen copy of ${locale}/${slug} for ${LEGAL_VERSION}`).not.toBeNull();
        // Compared against the digest table compiled into the API, which the
        // sibling spec independently compares against locales/ — so agreement
        // here is agreement between three artefacts, not a value with itself.
        expect(doc!.sha256, `${locale}/${slug} drifted from LEGAL_CORPUS`).toBe(
          LEGAL_CORPUS[locale]![slug],
        );
        expect(doc!.sourcePath).toBe(`docs/legal/accepted/${LEGAL_VERSION}/${locale}/${slug}.md`);
        expect(doc!.body.length).toBeGreaterThan(200);
      }
    }
  });

  it('has nothing frozen for a version that was never published', async () => {
    const { loadArchivedFile } = await freshModule();
    expect(loadArchivedFile('1999-01-01', 'el', 'terms')).toBeNull();
  });
});

describe('the fallback to the live corpus', () => {
  it('serves the published bytes when the archive directory is absent', async () => {
    // Simulates an image built before `COPY docs/legal/accepted` existed. The
    // live locales/ tree is still there, so the fallback should carry it — and
    // is allowed to only because the bytes hash to the compiled digest.
    process.env.LEGAL_ARCHIVE_ROOT = mkdtempSync(path.join(tmpdir(), 'lbr-empty-archive-'));
    const { loadArchivedFile } = await freshModule();
    const doc = loadArchivedFile(LEGAL_VERSION, 'el', 'terms');
    expect(doc).not.toBeNull();
    expect(doc!.sha256).toBe(LEGAL_CORPUS.el!.terms);
    expect(doc!.sourcePath).toBe('locales/el/legal/terms.md');
  });

  it('REFUSES text that does not hash to the compiled digest', async () => {
    // The whole point of the gate. A `locales/` tree that has moved on from
    // the accepted version must not be served as the accepted version — that
    // is precisely "the record is a date pointing at a mutable file".
    const archive = mkdtempSync(path.join(tmpdir(), 'lbr-empty-archive-'));
    const locales = mkdtempSync(path.join(tmpdir(), 'lbr-tampered-locales-'));
    mkdirSync(path.join(locales, 'el', 'legal'), { recursive: true });
    const real = readFileSync(path.join(REPO, 'locales', 'el', 'legal', 'terms.md'), 'utf8');
    writeFileSync(
      path.join(locales, 'el', 'legal', 'terms.md'),
      `${real}\n\n## 99. Ο πάροχος δεν φέρει καμία ευθύνη.\n`,
      'utf8',
    );
    process.env.LEGAL_ARCHIVE_ROOT = archive;
    process.env.LOCALES_ROOT = locales;

    const { loadArchivedFile } = await freshModule();
    expect(loadArchivedFile(LEGAL_VERSION, 'el', 'terms')).toBeNull();

    // And the tampered file really is different, so the null above is the gate
    // firing rather than the file simply being unreadable.
    const tampered = readFileSync(path.join(locales, 'el', 'legal', 'terms.md'), 'utf8');
    expect(createHash('sha256').update(tampered, 'utf8').digest('hex')).not.toBe(
      LEGAL_CORPUS.el!.terms,
    );
  });
});
