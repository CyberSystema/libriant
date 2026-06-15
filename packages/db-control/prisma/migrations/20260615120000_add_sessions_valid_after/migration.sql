-- Session-invalidation epoch (AUTH-01). Any session JWT whose `iat` predates
-- this instant is rejected by AuthGuard / AdminAuthGuard, so a password reset or
-- a forced credential/role/status change terminates already-issued cookies
-- instead of leaving them valid for the rest of their TTL.
ALTER TABLE "users" ADD COLUMN "sessionsValidAfter" TIMESTAMP(3);
ALTER TABLE "admin_users" ADD COLUMN "sessionsValidAfter" TIMESTAMP(3);
