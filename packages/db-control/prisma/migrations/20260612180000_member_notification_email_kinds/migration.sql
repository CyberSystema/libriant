-- Member circulation reminder email kinds (per-library opt-in notifications).
-- ALTER TYPE ... ADD VALUE can't run inside a transaction block, so each is its
-- own statement; IF NOT EXISTS keeps the migration idempotent.
ALTER TYPE "EmailMessageKind" ADD VALUE IF NOT EXISTS 'member_due_soon';
ALTER TYPE "EmailMessageKind" ADD VALUE IF NOT EXISTS 'member_overdue';
ALTER TYPE "EmailMessageKind" ADD VALUE IF NOT EXISTS 'member_hold_ready';
