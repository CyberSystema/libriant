import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateMany } = vi.hoisted(() => ({ updateMany: vi.fn() }));

vi.mock('@libriant/db-control', () => ({
  controlDb: { announcement: { updateMany } },
}));

import { publishDueAnnouncements } from './announcement-publish.job.js';

describe('publishDueAnnouncements', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stamps publishedAt on due, unpublished, non-archived announcements', async () => {
    updateMany.mockResolvedValue({ count: 2 });
    const res = await publishDueAnnouncements();

    expect(updateMany).toHaveBeenCalledTimes(1);
    const arg = updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: { publishedAt: Date };
    };
    expect(arg.where.publishedAt).toBeNull();
    expect(arg.where.archivedAt).toBeNull();
    expect(arg.where.publishAt).toMatchObject({ not: null });
    expect((arg.where.publishAt as { lte: Date }).lte).toBeInstanceOf(Date);
    expect(arg.data.publishedAt).toBeInstanceOf(Date);
    expect(res.counts?.published).toBe(2);
  });

  it('reports a no-op when nothing is due', async () => {
    updateMany.mockResolvedValue({ count: 0 });
    const res = await publishDueAnnouncements();
    expect(res.counts?.published).toBe(0);
    expect(res.message).toMatch(/no scheduled/i);
  });
});
