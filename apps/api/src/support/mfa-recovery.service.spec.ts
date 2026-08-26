import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique, upsert, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: { platformSetting: { findUnique, upsert, update, delete: vi.fn() } },
}));

import { MfaRecoveryService } from './mfa-recovery.service.js';

/** Wire the fake store so `load()` returns whatever `issue()` last wrote. */
function backStore() {
  let stored: string | null = null;
  upsert.mockImplementation(async (args: { create: { value: string } }) => {
    stored = args.create.value;
  });
  update.mockImplementation(async (args: { data: { value: string } }) => {
    stored = args.data.value;
  });
  findUnique.mockImplementation(async () => (stored === null ? null : { value: stored }));
  return { peek: () => stored };
}

describe('MfaRecoveryService (launch-readiness-13)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('issues ten codes and stores only their digests', async () => {
    const store = backStore();
    const svc = new MfaRecoveryService();

    const codes = await svc.issue('adm1');

    expect(codes).toHaveLength(MfaRecoveryService.CODE_COUNT);
    expect(new Set(codes).size).toBe(codes.length); // no duplicates
    const raw = store.peek()!;
    // The plaintext must not be recoverable from the row. This is the check
    // that would have caught a live credential sitting in the database.
    for (const code of codes) {
      expect(raw).not.toContain(code);
      expect(raw).not.toContain(MfaRecoveryService.normalize(code));
    }
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'admin.mfa.recovery:adm1' } }),
    );
  });

  it('accepts a code once and refuses it the second time', async () => {
    backStore();
    const svc = new MfaRecoveryService();
    const codes = await svc.issue('adm1');

    expect(await svc.consume('adm1', codes[0]!)).toBe(true);
    expect(await svc.consume('adm1', codes[0]!)).toBe(false);
    expect(await svc.remaining('adm1')).toBe(MfaRecoveryService.CODE_COUNT - 1);
    // The others are untouched.
    expect(await svc.consume('adm1', codes[1]!)).toBe(true);
  });

  it('accepts a hand-typed code regardless of case and separators', async () => {
    backStore();
    const svc = new MfaRecoveryService();
    const codes = await svc.issue('adm1');
    const typed = codes[0]!.toLowerCase().replace(/-/g, ' ');
    expect(await svc.consume('adm1', typed)).toBe(true);
  });

  it('refuses an unknown code and an admin with no codes at all', async () => {
    backStore();
    const svc = new MfaRecoveryService();
    expect(await svc.consume('adm1', 'ABCDE-FGHJK-MNPQR-STVWX')).toBe(false);
    await svc.issue('adm1');
    expect(await svc.consume('adm1', 'ABCDE-FGHJK-MNPQR-STVWX')).toBe(false);
  });

  it('refuses a matching code it could not burn', async () => {
    // A recovery code that survives its own use is a static second password.
    backStore();
    const svc = new MfaRecoveryService();
    const codes = await svc.issue('adm1');
    update.mockRejectedValueOnce(new Error('db down'));
    expect(await svc.consume('adm1', codes[0]!)).toBe(false);
  });

  it('reports zero remaining for an admin that never enrolled', async () => {
    findUnique.mockResolvedValue(null);
    expect(await new MfaRecoveryService().remaining('nobody')).toBe(0);
  });
});
