-- The two branch triggers resolve `branches` at runtime, and cannot find it.
--
-- Found while investigating what the phase-20 schema rename breaks; it turns out
-- to be broken NOW, with no rename involved. Reproduced on a pristine tenant at
-- the application's own default search_path:
--
--     SET search_path TO "$user", public;
--     INSERT INTO lbr2.branches (…)                        -- a root: fine
--     INSERT INTO lbr2.branches (…, parent_branch_id, …)   -- a child:
--     ERROR:  relation "branches" does not exist
--     QUERY:  SELECT b.parent_branch_id FROM branches b WHERE b.id = v_parent
--     CONTEXT:  PL/pgSQL function lbr2.branches_guard_cycle() line 18
--
-- A PL/pgSQL body is re-parsed at RUN TIME under the CALLING session's
-- search_path, not the one in effect when the function was created. The baseline
-- created these two while its own migration session had `lbr2` on the path, so
-- they resolved then and have never resolved since. `branches_guard_cycle` fires
-- BEFORE INSERT OR UPDATE on every write, but its lookup only runs when
-- parent_branch_id IS NOT NULL — so a library with one branch never reaches it,
-- which is every library, because provisioning seeds exactly one root.
--
-- That is why nothing caught it: the seed makes `branch-main` with no parent,
-- the smoke module makes one branch, and the second branch is the first failure.
-- The first library to build a hierarchy would have met it.
--
-- These are the last two instances of the class that migration
-- 20260908090000_changelog_search_path_and_actor was written to close. That one
-- fixed the changelog triggers and was never retro-fitted to the phase-7 pair.
--
-- THE FIX IS TG_TABLE_SCHEMA, not a pinned search_path.
--
-- `SET search_path FROM CURRENT` or `SET search_path TO lbr2` would work today
-- and break at the phase-20 cutover, which renames `lbr2` to `public`: a pin
-- names a schema that will not exist, and the failure would arrive in the middle
-- of the one transaction nobody wants a surprise in. TG_TABLE_SCHEMA is whatever
-- schema the triggering table is actually in, so it is correct before the rename,
-- after it, and inside it. This is the same decision, for the same reason, that
-- 20260908090000 took and that lbr2_account_entries_balance took in phase 18.
--
-- Both bodies keep every behaviour: the 16-hop limit raising 23514, the
-- self-ancestor check, depth on every write, and the descendant recompute that
-- converges because it only writes rows whose depth actually differs.

CREATE OR REPLACE FUNCTION lbr2.branches_guard_cycle() RETURNS trigger
  LANGUAGE plpgsql AS $branches_guard_cycle$
DECLARE
  v_parent text := NEW.parent_branch_id;
  v_depth  integer := 0;
  v_hops   integer := 0;
BEGIN
  WHILE v_parent IS NOT NULL LOOP
    v_hops := v_hops + 1;
    IF v_hops > 16 THEN
      RAISE EXCEPTION
        'branch hierarchy from % exceeds 16 levels, or contains a cycle', NEW.id
        USING ERRCODE = '23514';
    END IF;
    IF v_parent = NEW.id THEN
      RAISE EXCEPTION 'branch % cannot be its own ancestor', NEW.id
        USING ERRCODE = '23514';
    END IF;
    EXECUTE pg_catalog.format(
      'SELECT b.parent_branch_id FROM %I.branches b WHERE b.id = $1', TG_TABLE_SCHEMA)
      INTO v_parent USING v_parent;
    v_depth := v_depth + 1;
  END LOOP;

  NEW.depth := v_depth;
  RETURN NEW;
END;
$branches_guard_cycle$;

CREATE OR REPLACE FUNCTION lbr2.branches_recompute_descendant_depth() RETURNS trigger
  LANGUAGE plpgsql AS $branches_depth$
BEGIN
  EXECUTE pg_catalog.format($sql$
    WITH RECURSIVE tree AS (
      SELECT b.id, $1 + 1 AS d
        FROM %1$I.branches b WHERE b.parent_branch_id = $2
      UNION ALL
      SELECT b.id, t.d + 1
        FROM %1$I.branches b JOIN tree t ON b.parent_branch_id = t.id
    )
    UPDATE %1$I.branches b SET depth = t.d
      FROM tree t WHERE b.id = t.id AND b.depth <> t.d
  $sql$, TG_TABLE_SCHEMA) USING NEW.depth, NEW.id;
  RETURN NULL;
END;
$branches_depth$;
