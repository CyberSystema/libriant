-- The marketing form now asks every applicant which country they are in, and
-- insists on a phone number. Idempotent (IF NOT EXISTS) to match the repo
-- convention.

-- ISO 3166-1 alpha-2, validated against the canonical list in
-- `@libriant/shared` before it is ever written (applications.service.ts). No
-- CHECK constraint here: the list is 243 rows of TypeScript that ICU keeps
-- honest, and a copy of it in SQL is a copy that drifts. The shape rule alone
-- ("two capitals") would not drift, but it also would not catch anything the
-- service lets through, so it buys nothing for the maintenance it costs.
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "country" TEXT;

-- NOT BACKFILLED, on purpose.
--
-- Every existing row was written by a form that never asked. Defaulting them to
-- 'GR' would be very nearly true — the launch campaign is 277 Greek libraries —
-- and that is exactly what makes it dangerous: an invented value that looks
-- right is one nobody will ever go back and check. NULL is the honest record of
-- "we did not ask", and the only reader of the column, the admin panel, can say
-- so. The column stays nullable for the same reason: it is the FORM that
-- requires an answer now, not the table, and a NOT NULL here would have to be
-- paid for with the fiction above.
--
-- "phone" needs no DDL at all — it is already TEXT NULL. What changed is what
-- goes IN it: new rows hold the dial code the applicant chose in front of the
-- number they typed ("+30 2410000000"), where rows written before today hold a
-- bare national number, or nothing. Those are not rewritten either; we do not
-- know which country the older numbers belong to, which is the whole reason the
-- form now asks.
