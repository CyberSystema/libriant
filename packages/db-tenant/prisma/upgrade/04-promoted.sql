-- THE POST-PROMOTION ASSERTIONS (2.0 phase 20b).
--
-- 03-verify.sql runs before the promotion, under the copy-forward's own
-- search_path (`pg_temp, lbr2, v1_archive`). Everything it asserts is about
-- whether the DATA came across. This file asserts something different and
-- entirely: whether the database still WORKS once `lbr2` has been renamed to
-- `public` and the extensions have been moved into it.
--
-- ## Run under the application's own search_path, on purpose
--
-- The caller sets `SET LOCAL search_path TO "$user", public` before running
-- this, which is exactly what a tenant connection holds. That is not a detail —
-- it is the entire point. The failure this file exists to catch is a resolution
-- failure, and a resolution failure is invisible to any query that qualifies its
-- names. Phase 19a measured the shape:
--
--     default search_path             mail = 'a@b.GR'  ->  FALSE
--     search_path incl. extensions    mail = 'a@b.GR'  ->  TRUE
--
-- The `=` OPERATOR resolves through search_path. With citext's operators off the
-- path both sides are implicitly cast to `text` and the comparison silently
-- becomes case-sensitive — no error, no warning, correct-looking rows. Every
-- duplicate-patron check in the product turns off at once, and the first anyone
-- knows of it is two library cards for one reader.
--
-- ## Still inside the transaction
--
-- Everything here runs before COMMIT, so a failure rolls the whole cutover back.
-- An earlier design put these on a post-commit clone; that is strictly worse,
-- because by then the only remedy is a restore.
--
-- Same contract as 03-verify.sql: one row per assertion, `ok` false fails the
-- upgrade, and `detail` says what breaks rather than what was expected.
WITH h AS (
  -- The silent killer, asked the way the application asks it: UNQUALIFIED, so
  -- the operator is resolved through search_path exactly as a Prisma query
  -- resolves it. A qualified `OPERATOR(public.=)` would pass on a database where
  -- the application is already broken.
  SELECT 'H01' AS id,
         'citext still compares case-insensitively through the DEFAULT search_path' AS claim,
         ('A@B.GR'::citext = 'a@b.gr'::citext) AS ok,
         'the = operator resolves through search_path; off the path both sides cast to text and every duplicate-patron check silently becomes case-sensitive' AS detail
  UNION ALL
  -- The same question against the real column, because the type could be right
  -- and the column still have been rewritten as text by some earlier migration.
  SELECT 'H02', 'patrons.email is still citext after the promotion',
         EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute a
             JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = 'patrons'
              AND a.attname = 'email' AND pg_catalog.format_type(a.atttypid, NULL) = 'citext'),
         'a library that types Α.Παπαδοπουλου@… and one that types a.papadopoulou@… must mean the same patron'
  UNION ALL
  -- THE ONE THAT MAKES THE ARCHIVE DROPPABLE.
  --
  -- Extensions are created in `public` and an extension moves WITH its schema,
  -- so the rename carries all six into `v1_archive`. Left there, they are still
  -- the extensions the PROMOTED schema depends on — and `DROP SCHEMA v1_archive
  -- CASCADE` then cascades into live 2.0 data. Measured, on a clone:
  --
  --     NOTICE:  drop cascades to 44 other objects
  --       drop cascades to column email of table patrons
  --       drop cascades to index bib_records_search_trgm
  --       drop cascades to index patrons_search_trgm
  --       drop cascades to constraint calendar_hours_no_overlap …
  --
  -- as a NOTICE, so `ON_ERROR_STOP` does not stop. With the six moved, the same
  -- statement cascades to 32 objects, every one of them 1.0's own.
  SELECT 'H03', 'every extension lives in public, not in the archive',
         NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_extension e
             JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
            WHERE n.nspname <> 'public' AND e.extname <> 'plpgsql'),
         'an extension left in v1_archive makes DROP SCHEMA v1_archive CASCADE delete live 2.0 columns, indexes and constraints — announced as a NOTICE, so nothing stops'
  UNION ALL
  SELECT 'H04', 'the trigram search indexes survived the promotion',
         (SELECT count(*) FROM pg_catalog.pg_indexes
           WHERE schemaname = 'public' AND indexname IN ('bib_records_search_trgm', 'patrons_search_trgm')) = 2,
         'these are what make the Greek catalogue and patron search work at all'
  UNION ALL
  -- §3: "Double-booking is IMPOSSIBLE, not unlikely." Three EXCLUDE constraints
  -- carry that, and every one of them is built on btree_gist.
  SELECT 'H05', 'the three no-overlap exclusion constraints survived',
         (SELECT count(*) FROM pg_catalog.pg_constraint c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace
           WHERE n.nspname = 'public' AND c.contype = 'x'
             AND c.conname IN ('calendar_hours_no_overlap',
                               'calendar_exception_hours_no_overlap',
                               'fixed_due_date_ranges_no_overlap')) = 3,
         'these are what make an overlapping opening hour and a double-booked room refuse rather than merely be unlikely'
  UNION ALL
  SELECT 'H06', 'the 2.0 tables are in public and the archive still holds 1.0',
         (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public') > 100
         AND EXISTS (SELECT 1 FROM information_schema.tables
                      WHERE table_schema = 'v1_archive' AND table_name = 'books'),
         'the promotion must move the 2.0 schema INTO public and leave 1.0 readable in v1_archive for the rollback'
  UNION ALL
  -- The pg_proc form of what G03 was trying to be. After the promotion `public`
  -- exists again but means the 2.0 schema, so a 1.0 function body naming
  -- `public.` now resolves to the WRONG place rather than failing loudly — which
  -- is worse than the pre-promotion case, not better.
  SELECT 'H07', 'no function body names public, where the name now means something else',
         NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_proc p
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname IN ('public', 'v1_archive')
              AND p.prosqlbody IS NULL
              AND p.prosrc ~ '(^|[^A-Za-z0-9_."])public\s*\.'
              AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                               WHERE d.objid = p.oid AND d.deptype = 'e')),
         'a 1.0 body naming public. used to resolve to 1.0 and now resolves to the 2.0 schema, silently'
  UNION ALL
  -- The trigger fix from 20260919100000, asserted where it matters. These two
  -- resolve their table at RUN TIME, and the promotion changes what schema that
  -- is. TG_TABLE_SCHEMA is why they keep working; a pinned search_path would
  -- have broken exactly here.
  SELECT 'H08', 'the branch triggers still resolve their own table after the rename',
         (SELECT count(*) FROM pg_catalog.pg_proc p
            JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND p.proname IN ('branches_guard_cycle', 'branches_recompute_descendant_depth')
             AND p.prosrc LIKE '%TG_TABLE_SCHEMA%') = 2,
         'a pinned search_path would name lbr2, which the promotion has just taken away'
)
SELECT id, claim, ok, detail FROM h ORDER BY id;
