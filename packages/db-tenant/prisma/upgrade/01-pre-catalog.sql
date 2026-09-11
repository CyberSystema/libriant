-- v1 → v2 copy-forward, part 1: everything that does not depend on MARC.
--
-- 2.0 phase 19b. Runs INSIDE the caller's transaction — this file opens none of
-- its own and commits nothing. `scripts/tenant-upgrade-v2.ts` is the only thing
-- that runs it, and it does so between `ALTER SCHEMA public RENAME TO
-- v1_archive` and the TypeScript catalogue pass, on one connection.
--
-- READS `v1_archive`, WRITES `lbr2`. Both are named explicitly in every
-- statement: the tenant's search_path is `"$user", public` and `public` does not
-- exist at this point in the transaction.
--
-- SQL CONSTRUCTS CANNOT BE SCHEMA-QUALIFIED, and the list is longer than this
-- repo had written down. MEASURED on PG 16.15, `pg_catalog.<x>` is a syntax
-- error or an unknown function for:
--
--     COALESCE   NULLIF   GREATEST   LEAST   CASE
--     EXTRACT(x FROM y)        SUBSTRING(x FROM y)
--
-- and works fine for everything else tested — to_jsonb, jsonb_build_object,
-- date_part, the two-argument substring, btrim, upper, lower, md5, left, max,
-- count, sum, min, length, format, to_char, gen_random_uuid, now, date_trunc,
-- string_agg, abs. The FROM-form traps are the dangerous half: they read like
-- function calls and fail at PARSE time, so a file that contains one does not
-- run at all.
--
-- 1.0 COLUMNS ARE QUOTED camelCase. `"loanedAt"`, never `loaned_at`. Getting
-- that wrong is the single most common error available against this schema and
-- it fails loudly, which is the one mercy.
--
-- EVERY INSTANT IS READ AS UTC. 1.0's columns are `timestamp without time
-- zone`, 2.0's are `timestamptz(3)`, and `x AT TIME ZONE 'UTC'` is the
-- conversion — §8 risk 2 is that Prisma's generated cast goes through the
-- SESSION zone instead, which on an Athens host silently moves every row by two
-- or three hours with nothing able to tell a shifted value from a real one.

-- ---------------------------------------------------------------------------
-- 1. Shelving locations, from the distinct shelf labels
-- ---------------------------------------------------------------------------
--
-- 1.0 has a free-text `shelfLocation` on each copy; 2.0 has a table. The
-- distinct non-null values become rows, and copies with no label keep the
-- provisioned default (`loc-general`) rather than getting a location called ''.

INSERT INTO lbr2.shelving_locations (id, branch_id, code, name, updated_at)
SELECT
  'loc-v1-' || pg_catalog.md5(c."shelfLocation"),
  'branch-main',
  pg_catalog.left(c."shelfLocation", 32),
  c."shelfLocation",
  pg_catalog.now()
FROM (SELECT DISTINCT "shelfLocation" FROM v1_archive.book_copies WHERE "shelfLocation" IS NOT NULL) c
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1b. The one patron category a 1.0 library had without naming it
-- ---------------------------------------------------------------------------
--
-- 1.0 has no patron categories: every member is priced by one `tenant_settings`
-- row. 2.0 requires `loans.patron_category_id_applied` to be NOT NULL, because
-- the whole point of the rules matrix is that a loan records which category it
-- was priced under — a loan that cannot say is a loan nobody can re-price or
-- explain, and `/circulation/explain` is the question §6 says the incumbents
-- cannot answer.
--
-- So the implicit category is made explicit. `pcat-general` is readable, like
-- `branch-main` and `rule-default`, and it is what a support conversation names.
-- The `maxActiveLoans` sentinel crossing lands on its limit row: 0 means
-- UNLIMITED in 1.0 and would mean "may borrow nothing" in 2.0.

INSERT INTO lbr2.patron_categories (id, code, name, updated_at)
VALUES ('pcat-general', 'GENERAL', 'General', pg_catalog.now())
ON CONFLICT (id) DO NOTHING;

-- The table is keyed by the category itself — one limit row per category, so no
-- id of its own. `max_fine_balance_cents` takes the fine cap for the same reason
-- `maximum_fine_cents` does: 1.0's single cap is both a per-fine ceiling and the
-- balance at which a reader is blocked, and 2.0 separates them.
INSERT INTO lbr2.patron_category_limits (
  patron_category_id, max_loans, currency, max_fine_balance_cents, updated_at)
SELECT 'pcat-general', NULLIF(s."maxActiveLoans", 0), s.currency,
       NULLIF(s."fineCapCents", 0), pg_catalog.now()
FROM v1_archive.tenant_settings s
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Patrons
-- ---------------------------------------------------------------------------
--
-- `search_text` is recomputed by the orchestrator, not copied: the 1.0 value
-- predates the phase-1 final-sigma fix, so a Greek name ending in sigma is
-- unfindable under it. It is set to the folded full name here so the NOT NULL
-- holds, and the orchestrator overwrites it with the real fold.
--
-- COALESCE ON EVERY PART. An earlier draft of this phase concatenated
-- fullName || ' ' || email || ' ' || phone with no COALESCE, which makes
-- search_text NULL for every member with no email — a majority of a typical
-- roster, unsearchable, with the source column gone.

INSERT INTO lbr2.patrons (
  id, patron_category_id, patron_number, full_name, sort_name, search_text, email, phone, date_of_birth,
  photo_asset_ref, status, staff_notes, joined_at, custom_fields,
  created_at, updated_at, archived_at, erased_at
)
SELECT
  m.id,
  'pcat-general',
  m."memberNumber",
  m."fullName",
  m."sortName",
  pg_catalog.lower(
    COALESCE(m."fullName", '') || ' ' || COALESCE(m."memberNumber", '') || ' ' ||
    COALESCE(m.email::text, '') || ' ' || COALESCE(m.phone, '')
  ),
  m.email,
  m.phone,
  m."dateOfBirth",
  m."photoAssetRef",
  -- NOT a bare cast. 1.0's MemberStatus is (active, suspended, archived) and
  -- 2.0's patron_status is (active, suspended, closed): `archived` has no
  -- counterpart and `CAST('archived' AS patron_status)` is 22P02. 2.0 says the
  -- same thing with two columns — a closed account and an `archived_at` stamp —
  -- and the stamp is carried below, so nothing is lost by the rename.
  CASE m.status::text
    WHEN 'archived' THEN CAST('closed' AS lbr2.patron_status)
    ELSE CAST(m.status::text AS lbr2.patron_status)
  END,
  m."staffNotes",
  m."joinedAt" AT TIME ZONE 'UTC',
  m."customFields",
  m."createdAt" AT TIME ZONE 'UTC',
  m."updatedAt" AT TIME ZONE 'UTC',
  m."archivedAt" AT TIME ZONE 'UTC',
  m."erasedAt" AT TIME ZONE 'UTC'
FROM v1_archive.members m;

-- The member number IS a card, and it is the PRIMARY one. A 1.0 library prints
-- it on a card and the desk scans it, so a migration that produced patrons with
-- no card would leave every reader unable to borrow.
--
-- `barcode_norm` here is trim + upper and NOT the Greek fold: `patron_cards`
-- deliberately does not fold (items.service.ts:575-582 says why — a card barcode
-- is machine-issued and printed, and folding it would let two people's cards
-- collide). `items.barcode_norm` DOES fold. All three candidate designs for this
-- phase had that backwards.
INSERT INTO lbr2.patron_cards (id, patron_id, barcode, barcode_norm, status, issued_at, updated_at)
SELECT
  'card-v1-' || m.id,
  m.id,
  m."memberNumber",
  pg_catalog.upper(pg_catalog.btrim(m."memberNumber")),
  -- `patron_card_status` is (active, lost, stolen, replaced, expired) and has no
  -- `retired`. A migrated card is `active` even for an archived member: the
  -- account is closed, the piece of plastic was never reported lost, and saying
  -- otherwise would put a reason in the record that nobody gave.
  CAST('active' AS lbr2.patron_card_status),
  m."joinedAt" AT TIME ZONE 'UTC',
  pg_catalog.now()
FROM v1_archive.members m
WHERE m."memberNumber" IS NOT NULL;

-- The staff note. `patron_notes.body`, and only where there is one.
INSERT INTO lbr2.patron_notes (id, patron_id, body, created_at, updated_at)
SELECT 'note-v1-' || m.id, m.id, m."staffNotes",
       m."createdAt" AT TIME ZONE 'UTC', m."updatedAt" AT TIME ZONE 'UTC'
FROM v1_archive.members m
WHERE m."staffNotes" IS NOT NULL;

-- One address row, only where the member actually has one. A row of five NULLs
-- asserts that the library holds an address it does not hold.
INSERT INTO lbr2.patron_addresses (
  id, patron_id, kind, line1, line2, city, postal_code, country, is_primary, updated_at
)
SELECT
  'addr-v1-' || m.id, m.id, 'home', m."addressLine1", m."addressLine2",
  m.city, m."postalCode", m.country, true, pg_catalog.now()
FROM v1_archive.members m
WHERE m."addressLine1" IS NOT NULL OR m.city IS NOT NULL OR m."postalCode" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. The member-number counter
-- ---------------------------------------------------------------------------
--
-- THE MAXIMUM of the copied counter and the recomputed high-water mark.
-- Recomputing alone re-issues a number that was minted, printed on a card, and
-- whose member row was later hard-deleted — two readers holding one number.

INSERT INTO lbr2.patron_number_counters (year, next_seq)
SELECT
  c.year,
  GREATEST(
    c."nextSeq",
    COALESCE((
      -- `substring(x FROM y)` is a SQL CONSTRUCT, not a function call, so
      -- `pg_catalog.substring(... FROM ...)` is a SYNTAX ERROR — the same family
      -- as `extract(x FROM y)`, which this repo has hit twice. The two-argument
      -- form IS a real function and qualifies cleanly.
      SELECT pg_catalog.max(pg_catalog.substring(m."memberNumber", '(\d+)$')::bigint) + 1
        FROM v1_archive.members m
       WHERE m."memberNumber" LIKE '%' || c.year::text || '%'
    ), 1)
  )
FROM v1_archive.member_number_counters c
ON CONFLICT (year) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. tenant_settings becomes the policy rows the provisioning seeded
-- ---------------------------------------------------------------------------
--
-- The rows already exist — `lp-default`, `fp-default`, `lf-default`,
-- `hp-default`, the wildcard `rule-default` — so this is an UPDATE, not an
-- INSERT. A library's actual settings land on them.
--
-- THIS SECTION IS WHY THE ROUTING MANIFEST EXISTS. Three independent designs
-- for this phase all pinned `lf-default` and left the seeded policy untouched,
-- so a library that charges 25 EUR for a lost book would have silently started
-- charging the seed default, unrecoverably once v1_archive is dropped.

UPDATE lbr2.loan_policies p
   SET period_value = s."loanPeriodDays",
       period_unit  = 'days',
       -- VERBATIM, no NULLIF. `0` renewals allowed is a real setting a library
       -- chose, not a sentinel — unlike fineCapCents and maxActiveLoans below,
       -- where 0 means "no cap" and "unlimited". Three sentinel crossings, two
       -- NULLIFs, one deliberate non-NULLIF.
       renewals_allowed = s."maxRenewals",
       renewable = s."renewalsEnabled"
  FROM v1_archive.tenant_settings s
 WHERE p.id = 'lp-default';

UPDATE lbr2.overdue_fine_policies p
   SET amount_per_interval_cents = s."finePerDayCents",
       interval_value = 1,
       interval_unit  = 'days',
       currency = s.currency,
       maximum_fine_cents = NULLIF(s."fineCapCents", 0)
  FROM v1_archive.tenant_settings s
 WHERE p.id = 'fp-default';

-- lostItemFeesEnabled / lostItemDefaultFeeCents — TWO OF THE FOUR COLUMNS every
-- candidate design for this phase silently lost. Pinning `lf-default` and
-- leaving the seeded policy untouched makes a library that charges 25 EUR for a
-- lost book start charging the seed default, unrecoverably once v1_archive is
-- dropped.
--
-- `lost_item_fee_basis` is (replacementPrice, itemTypeDefault, fixedAmount,
-- actualCost) and has NO `none`. 2.0 says "we do not charge for a lost book"
-- as a FIXED AMOUNT OF ZERO, which is what the provisioning already seeds, and
-- `lost_item_fee_policies_amounts_non_negative` explicitly permits 0. So the
-- basis is always `fixedAmount` and the SETTING lives in the amount.
UPDATE lbr2.lost_item_fee_policies p
   SET charge_basis = CAST('fixedAmount' AS lbr2.lost_item_fee_basis),
       fixed_amount_cents = CASE WHEN s."lostItemFeesEnabled"
                                 THEN s."lostItemDefaultFeeCents" ELSE 0 END,
       currency = s.currency
  FROM v1_archive.tenant_settings s
 WHERE p.id = 'lf-default';

UPDATE lbr2.hold_policies p
   SET hold_shelf_expiry_value = s."holdPickupHours",
       hold_shelf_expiry_unit  = 'hours',
       holds_allowed = s."reservationsEnabled",
       currency = s.currency
  FROM v1_archive.tenant_settings s
 WHERE p.id = 'hp-default';

-- THE OTHER TWO OF THE FOUR. A library that had overdue notices ON must not
-- come up with them OFF.
--
-- They become `notice_policy_templates` rows: a trigger with a row is on, a
-- trigger with none is off. `template_id` has NO foreign key — `notice_templates`
-- is deferred to phase 22 — so these name the ids phase 22 will create, and the
-- SETTING survives as a real row rather than as a note somebody has to read.
INSERT INTO lbr2.notice_policy_templates (id, notice_policy_id, trigger, template_id, offset_value, offset_unit, created_at)
SELECT 'npt-v1-duesoon', 'np-default', CAST('dueSoon' AS lbr2.notice_trigger_kind),
       'tmpl-due-soon', s."dueSoonDays", CAST('days' AS lbr2.duration_unit), pg_catalog.now()
  FROM v1_archive.tenant_settings s WHERE s."notifyDueSoon";
INSERT INTO lbr2.notice_policy_templates (id, notice_policy_id, trigger, template_id, created_at)
SELECT 'npt-v1-overdue', 'np-default', CAST('overdue' AS lbr2.notice_trigger_kind),
       'tmpl-overdue', pg_catalog.now()
  FROM v1_archive.tenant_settings s WHERE s."notifyOverdue";
INSERT INTO lbr2.notice_policy_templates (id, notice_policy_id, trigger, template_id, created_at)
SELECT 'npt-v1-holdready', 'np-default', CAST('holdAvailable' AS lbr2.notice_trigger_kind),
       'tmpl-hold-ready', pg_catalog.now()
  FROM v1_archive.tenant_settings s WHERE s."notifyHoldReady";

-- The 1.0 templates themselves have no 2.0 table until phase 22, so the JSON is
-- recorded rather than dropped. `upgrade_exceptions` is queryable, which a note
-- in a commit message is not.
INSERT INTO lbr2.upgrade_exceptions (id, kind, source_table, source_id, source_column, value, note, recorded_at)
SELECT 'exc-v1-notifytemplates', CAST('no_target' AS lbr2.upgrade_exception_kind),
       'tenant_settings', s.id, 'notificationTemplates', s."notificationTemplates",
       'The 1.0 notice bodies. notice_templates is deferred to phase 22, so there is no table to '
       || 'carry them into; the notice_policy_templates rows above record WHICH notices were on, '
       || 'and this records what they said.',
       pg_catalog.now()
  FROM v1_archive.tenant_settings s WHERE s."notificationTemplates" IS NOT NULL;

-- `defaultLocale` lives on the BRANCH in 2.0, not on a settings singleton: a
-- consortium's branches can differ, and the notice engine reads the branch.
UPDATE lbr2.branches b
   SET currency = s.currency,
       default_locale = s."defaultLocale"
  FROM v1_archive.tenant_settings s
 WHERE b.id = 'branch-main';

-- ---------------------------------------------------------------------------
-- 5. The eleven compat twins, row for row
-- ---------------------------------------------------------------------------
--
-- Same physical shape on both sides (phase 19a), so these are plain copies. The
-- authorization five are LIVE: the 1.0 client keeps reading them through
-- search_path until phase 20 deletes it, and PermissionGuard runs on every
-- request.

INSERT INTO lbr2.roles SELECT * FROM v1_archive.roles;
INSERT INTO lbr2.role_permissions SELECT * FROM v1_archive.role_permissions;
INSERT INTO lbr2.staff_profiles SELECT * FROM v1_archive.staff_profiles;
INSERT INTO lbr2.staff_role_grants SELECT * FROM v1_archive.staff_role_grants;
INSERT INTO lbr2.staff_permission_overrides (
  "userId", "permissionKey", effect, "limitNum", reason, "grantedByUserId", "createdAt", "updatedAt")
SELECT "userId", "permissionKey", CAST(effect::text AS lbr2."PermissionEffect"),
       "limitNum", reason, "grantedByUserId", "createdAt", "updatedAt"
  FROM v1_archive.staff_permission_overrides;
INSERT INTO lbr2.field_definitions (
  id, "entityKind", "fieldKey", "labelJson", type, required, "optionsJson", "validationJson",
  "sortOrder", indexed, "archivedAt", "createdAt", "updatedAt")
SELECT id, CAST("entityKind"::text AS lbr2."FieldEntityKind"), "fieldKey", "labelJson",
       CAST(type::text AS lbr2."FieldType"), required, "optionsJson", "validationJson",
       "sortOrder", indexed, "archivedAt", "createdAt", "updatedAt"
  FROM v1_archive.field_definitions;
INSERT INTO lbr2.collections SELECT * FROM v1_archive.collections;
INSERT INTO lbr2.collection_fields (
  id, "collectionId", "fieldKey", "labelJson", type, required, "optionsJson", "validationJson",
  "sortOrder", indexed, "archivedAt", "createdAt", "updatedAt")
SELECT id, "collectionId", "fieldKey", "labelJson", CAST(type::text AS lbr2."FieldType"),
       required, "optionsJson", "validationJson", "sortOrder", indexed,
       "archivedAt", "createdAt", "updatedAt"
  FROM v1_archive.collection_fields;
INSERT INTO lbr2.collection_records SELECT * FROM v1_archive.collection_records;
INSERT INTO lbr2._libriant_schema_state SELECT * FROM v1_archive._libriant_schema_state;
INSERT INTO lbr2._libriant_online_migrations SELECT * FROM v1_archive._libriant_online_migrations;
