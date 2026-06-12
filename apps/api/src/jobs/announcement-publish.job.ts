import { controlDb } from '@libriant/db-control';
import type { JobResult } from './jobs.types.js';

/**
 * Scheduled-announcement publisher.
 *
 * An admin can schedule an announcement for the future: it's created with
 * `publishedAt = null` and a future `publishAt`. The per-tenant delivery query
 * only surfaces announcements where `publishedAt <= now`, so until something
 * flips `publishedAt` a scheduled announcement never goes live. This sweep is
 * that something — it stamps `publishedAt` on every due, not-yet-published,
 * non-archived announcement. Idempotent (the `publishedAt: null` filter means a
 * re-run never re-publishes).
 */
export async function publishDueAnnouncements(): Promise<JobResult> {
  const now = new Date();
  const { count } = await controlDb.announcement.updateMany({
    where: {
      publishedAt: null,
      archivedAt: null,
      publishAt: { not: null, lte: now },
    },
    data: { publishedAt: now },
  });

  return {
    message:
      count === 0
        ? 'no scheduled announcements due'
        : `published ${count} scheduled announcement(s)`,
    counts: { published: count },
  };
}
