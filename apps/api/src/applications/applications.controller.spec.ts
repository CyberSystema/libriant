import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';

vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    applyHashPepper: 'unit-test-pepper-0123456789abcdef0123',
    applyNotifyTo: 'info@example.test',
    adminHost: 'admin.example.test',
    emailDriver: 'console',
  }),
}));

const { applicationFindMany } = vi.hoisted(() => ({ applicationFindMany: vi.fn() }));
vi.mock('@libriant/db-control', () => ({
  controlDb: { application: { findMany: applicationFindMany, count: vi.fn() } },
}));

import { ApplicationsController } from './applications.controller.js';

/**
 * The applications export — the sheet the operator actually works the campaign
 * from, and the one place a value we compose meets software that will try to
 * run it.
 */

/** Enough of an express Response for a handler that only sets headers and sends. */
function fakeRes() {
  const res = {
    body: '',
    status: vi.fn(() => res),
    set: vi.fn(() => res),
    send: vi.fn((b: string) => {
      res.body = b;
      return res;
    }),
  };
  return res;
}

const row = {
  createdAt: new Date('2026-08-28T09:00:00.000Z'),
  libraryName: 'Δημοτική Βιβλιοθήκη Λάρισας',
  libraryType: 'public',
  city: 'Λάρισα',
  country: 'GR',
  contactName: 'Μαρία Παπαδοπούλου',
  contactEmail: 'library@example.gr',
  phone: '+30 2410000000',
  collectionSize: '20000',
  currentSystem: null,
  message: null,
  status: 'new',
  notified: false,
  id: 'app-1',
};

async function exportCsv(rows: unknown[]): Promise<{ header: string; first: string }> {
  applicationFindMany.mockReset();
  applicationFindMany.mockResolvedValue(rows);
  const res = fakeRes();
  await new ApplicationsController({} as never).exportCsv(res as unknown as Response);
  // The leading BOM is there so Excel reads the Greek as UTF-8; it is not part
  // of the header. Spelled as an escape because a literal one in a regex is
  // exactly the invisible character `no-irregular-whitespace` exists to catch.
  const lines = res.body.replace(/^\uFEFF/, '').split('\r\n');
  return { header: lines[0] ?? '', first: lines[1] ?? '' };
}

describe('GET /admin/applications.csv', () => {
  it('carries the country, next to the town it belongs to', async () => {
    const { header, first } = await exportCsv([row]);
    expect(header.split(',')).toEqual([
      'created_at',
      'library_name',
      'library_type',
      'city',
      'country',
      'contact_name',
      'contact_email',
      'phone',
      'collection_size',
      'current_system',
      'message',
      'status',
      'notified',
      'id',
    ]);
    // The stored code, not a label: the header row is English, the data is
    // Greek, and there is no language a CSV could resolve the name in that
    // would still be the same word next year.
    expect(first.split(',')[4]).toBe('"GR"');
  });

  it('hands the phone to the spreadsheet as text, not as arithmetic', async () => {
    // A dialable number begins with `+`, and Excel reads a leading `+` as the
    // start of a formula: unneutralized, `+30 2410000000` is evaluated into a
    // reference error and the operator sees no phone number at all.
    // `neutralizeFormula`'s apostrophe forces the cell to text, which is the
    // number back — so this assertion is the guard working, not a defect.
    const { first } = await exportCsv([row]);
    expect(first).toContain(`"'+30 2410000000"`);
  });

  it('leaves the older rows that have neither alone rather than inventing them', async () => {
    // Applications taken before the form asked. NULL is the honest record of
    // "we did not ask" — an empty cell, not a guessed 'GR'.
    const { first } = await exportCsv([{ ...row, country: null, phone: null }]);
    expect(first.split(',')[4]).toBe('""');
    expect(first.split(',')[7]).toBe('""');
  });
});
