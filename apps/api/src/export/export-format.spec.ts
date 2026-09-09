import { describe, expect, it } from 'vitest';
import { ExportFormat } from '@libriant/db-control';
import { EXPORT_FORMATS } from './export.dto.js';

/**
 * The DTO's format list and the database's enum must be the same set.
 *
 * They are two hand-maintained copies of one fact, and the drift is silent in
 * the worst direction: a value the database accepts and the DTO refuses looks to
 * a librarian like "the export button is broken", with a 400 that says the
 * format must be one of a list the format IS on. The reverse — a DTO value the
 * enum lacks — is a 500 from Prisma at insert time.
 *
 * Phase 11b added `catalog_marc` and had to touch both, which is what made the
 * gap worth closing rather than noting.
 */
describe('EXPORT_FORMATS', () => {
  it('is exactly the ExportFormat enum', () => {
    expect([...EXPORT_FORMATS].sort()).toEqual(Object.values(ExportFormat).sort());
  });
});
