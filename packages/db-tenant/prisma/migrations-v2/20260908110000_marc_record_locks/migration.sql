-- The record lock: a cataloguer's claim on a record open in the editor.
--
-- §3 names this table in one list and specifies no column of it. What is here
-- is what the phase-10 acceptance criterion forces — "lock acquire/heartbeat/
-- expiry/take-over each write the expected audit action" — plus what the
-- measurements below force. The model docblock in `prisma/schema-v2/10-marc.prisma`
-- carries the per-column reasoning and the list of columns that were considered
-- and rejected.
--
-- WHY THE UNIQUENESS IS THE KEY AND THE LIVENESS IS A PREDICATE. The intuitive
-- shape is many rows plus a partial unique index on the live ones:
--
--     CREATE UNIQUE INDEX … ON marc_record_locks (record_id) WHERE expires_at > now();
--     ERROR:  42P17: functions in index predicate must be marked IMMUTABLE
--
-- Postgres refuses it, and it is right to: an index predicate must be a
-- property of the row, and "is this lock still live" is a property of the row
-- AND the clock. So `record_id` is the PRIMARY KEY — one row per record, ever —
-- and every acquire evaluates liveness itself. The consequence worth stating is
-- the good one: a stopped sweep can never freeze a record, because no job is
-- what makes an expired lock acquirable.
--
-- NO INDEX BEYOND THE KEY. Measured over 3,000 heartbeats on one row with
-- VACUUM FULL between trials: 100.0% HOT updates with no secondary index, 87.2%
-- with one on `expires_at` — roughly one heartbeat in eight becomes a non-HOT
-- update. The table is bounded at one row per record ever opened, so the sweep's
-- sequential scan is cheaper than the write amplification. Add an index when a
-- sweep is measured slow, not before.
--
-- NO CHANGELOG TRIGGER, and that is a decision `check:changelog-coverage`
-- enforces in both directions rather than an omission. A lock beats every sixty
-- seconds while an editor is open; replicating it would make it the largest
-- producer in the feed, to tell consumers about something none of them wants.

BEGIN;

SELECT pg_catalog.set_config(
  'search_path',
  pg_catalog.current_schema() || ', public',
  true
);

CREATE TABLE marc_record_locks (
  record_id text PRIMARY KEY,
  holder_user_id text NOT NULL,
  session_id text NOT NULL,
  acquired_at timestamptz(3) NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz(3) NOT NULL,
  displaced_holder_user_id text,
  displaced_reason text,
  heartbeat_count integer NOT NULL DEFAULT 0,

  -- A lock cannot expire before it was taken. This is what makes RELEASE
  -- unambiguous: "release by backdating expires_at" is illegal, so release is a
  -- DELETE and there is exactly one way to give a record back.
  --
  -- It also has a testing consequence worth knowing: a fixture that wants an
  -- ALREADY-EXPIRED lock must backdate `acquired_at` further than the negative
  -- expiry, or the constraint refuses the fixture itself.
  CONSTRAINT marc_record_locks_ttl CHECK (expires_at > acquired_at),

  -- The pair that keeps clause 5's four actions distinguishable. The upsert
  -- that acquires is also the upsert that displaces, so the row it returns has
  -- to say whom it displaced and why — otherwise `lock_expired` and
  -- `lock_taken_over` become one indistinguishable event.
  CONSTRAINT marc_record_locks_displaced_reason
    CHECK (displaced_reason IS NULL OR displaced_reason IN ('expired', 'taken_over')),
  -- …and the two travel together or not at all.
  CONSTRAINT marc_record_locks_displaced_pair
    CHECK ((displaced_holder_user_id IS NULL) = (displaced_reason IS NULL))
);

-- ON DELETE CASCADE: a record that is hard-deleted takes its lock with it.
-- Measured as the reason `record_id` is an FK at all — without it a lock could
-- outlive the record it names and the editor would offer to open nothing.
--
-- ON UPDATE CASCADE is Prisma's default for a relation and is spelled out here
-- so the datamodel and the migration agree; `check:schema-drift` catches the
-- difference, which is how this line came to be written. It is inert in
-- practice: `marc_records.id` is a cuid and §3 says it is never re-keyed.
ALTER TABLE marc_record_locks
  ADD CONSTRAINT marc_record_locks_record_id_fkey
  FOREIGN KEY (record_id) REFERENCES marc_records(id)
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
