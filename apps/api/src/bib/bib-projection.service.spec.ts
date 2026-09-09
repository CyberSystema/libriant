import { describe, expect, it, vi } from 'vitest';
import { BibProjectionService, NOT_THE_PROJECTORS } from './bib-projection.service.js';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';

/**
 * Two things the integration suite structurally cannot assert.
 *
 * The kind guard has no route to exercise: `create()` refuses every profile this
 * build ships no Avram definition for, which is authority, holdings and
 * classification alike until phases 45 and 84. An integration test would be
 * asserting that 409, not the guard.
 *
 * The shape of the UPDATE is the other one. The integration test proves the six
 * protected columns survive a real edit, which is the behaviour that matters —
 * but it proves it for the values it happened to set. This asserts the statement
 * itself, so the guarantee does not depend on a test remembering to seed a
 * seventh column when one is added.
 */
function fakeTx() {
  const upsert = vi.fn(async () => ({}));
  const idDelete = vi.fn(async () => ({ count: 0 }));
  const idCreate = vi.fn(async () => ({ count: 0 }));
  const clDelete = vi.fn(async () => ({ count: 0 }));
  const clCreate = vi.fn(async () => ({ count: 0 }));
  const tx = {
    bibRecord: { upsert },
    bibIdentifier: { deleteMany: idDelete, createMany: idCreate },
    bibClassification: { deleteMany: clDelete, createMany: clCreate },
  } as unknown as TxV2;
  return { tx, upsert, idDelete, idCreate, clDelete, clCreate };
}

const RECORD = {
  leader: '00000nam a2200000 a 4500',
  fields: [
    { t: '008', v: '260908s2020    gr |||||||||||000 0 gre d' },
    { t: '245', i: '10', s: [{ a: 'Βίος και πολιτεία /' }] },
    { t: '020', i: '  ', s: [{ a: '9780306406157' }] },
    { t: '082', i: '04', s: [{ a: '889.332' }] },
  ],
};

describe('BibProjectionService', () => {
  it('writes nothing at all for a non-bibliographic kind', async () => {
    // An authority record projected as a bib is a `bib_records` row that the
    // OPAC renders as a book called "Καζαντζάκης, Νίκος".
    const f = fakeTx();
    const svc = new BibProjectionService();
    for (const kind of ['authority', 'holdings', 'classification']) {
      await svc.project(f.tx, { recordId: 'r1', kind, record: RECORD, now: new Date() });
    }
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.idDelete).not.toHaveBeenCalled();
    expect(f.clDelete).not.toHaveBeenCalled();
  });

  it('never names a protected column in the UPDATE half of the upsert', async () => {
    // The whole hazard in one assertion. An `ON CONFLICT DO UPDATE SET (…) =
    // (excluded.*)` — or a Prisma `update:` handed the same object as `create:`
    // — zeroes the OPAC availability of every record a cataloguer touches,
    // un-suppresses records staff hid, and destroys the only copy of the 1.0 row
    // in `legacy_json`, which is unreconstructible once `v1_archive` is dropped.
    const f = fakeTx();
    await new BibProjectionService().project(f.tx, {
      recordId: 'r1',
      kind: 'bibliographic',
      record: RECORD,
      now: new Date(),
    });
    expect(f.upsert).toHaveBeenCalledTimes(1);
    const arg = (f.upsert.mock.calls as unknown as unknown[][])[0]![0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    for (const col of NOT_THE_PROJECTORS) {
      expect(Object.keys(arg.update), `update names ${col}`).not.toContain(col);
      expect(Object.keys(arg.create), `create names ${col}`).not.toContain(col);
    }
    // `createdAt` is the mirror image: it must be on the create and NOT on the
    // update, or every edit resets the moment the record was catalogued and the
    // "titles added this month" count reports the batch job instead.
    expect(Object.keys(arg.create)).toContain('createdAt');
    expect(Object.keys(arg.update)).not.toContain('createdAt');
  });

  it('replaces both satellite sets rather than appending to them', async () => {
    const f = fakeTx();
    await new BibProjectionService().project(f.tx, {
      recordId: 'r1',
      kind: 'bibliographic',
      record: RECORD,
      now: new Date(),
    });
    expect(f.idDelete).toHaveBeenCalledWith({ where: { bibId: 'r1' } });
    expect(f.clDelete).toHaveBeenCalledWith({ where: { bibId: 'r1' } });
    expect(f.idCreate).toHaveBeenCalledTimes(1);
    expect(f.clCreate).toHaveBeenCalledTimes(1);
  });

  it('skips the insert entirely when a record carries no identifiers', async () => {
    // `createMany` with an empty array is a round trip that inserts nothing.
    const f = fakeTx();
    await new BibProjectionService().project(f.tx, {
      recordId: 'r1',
      kind: 'bibliographic',
      record: { leader: RECORD.leader, fields: RECORD.fields.slice(0, 2) },
      now: new Date(),
    });
    expect(f.idDelete).toHaveBeenCalledTimes(1);
    expect(f.idCreate).not.toHaveBeenCalled();
    expect(f.clCreate).not.toHaveBeenCalled();
  });
});
