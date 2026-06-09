-- Library staff accounts: admin-created users sign in with a `username`
-- (e.g. staff_3) instead of an email, and are forced through a one-time
-- credential setup. Email becomes optional (staff have none on file).

ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN "username" CITEXT;
ALTER TABLE "users" ADD COLUMN "mustChangeCredentials" BOOLEAN NOT NULL DEFAULT false;

-- Unique login handle per tenant. Standard unique index — Postgres allows
-- multiple NULLs, so email-based accounts (username NULL) don't collide.
CREATE UNIQUE INDEX "users_tenantId_username_key" ON "users"("tenantId", "username");
