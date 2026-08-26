-- data-integrity-05, the half that lives in already-shipped data.
--
-- WHAT WAS WRONG. `ImportEngine.commitReservation` wrote a `status='ready'`
-- hold with `readyAt` set, `fulfilledByCopyId` left NULL and no copy flipped to
-- `reserved`. Three downstream paths assume a ready hold owns a copy:
--
--   * LoansService.checkout compares `reservation.fulfilledByCopyId !==
--     input.copyId` and throws, so NULL blocks EVERY pickup — measured through
--     the real POST /t/:slug/reservations/:id/fulfill route as a flat 400;
--   * ReservationsService.resolveReservation only frees a copy when
--     `fulfilledByCopyId` is set, so cancelling releases nothing;
--   * the expiry sweep filters `expiresAt < now`, and NULL is never `< now`, so
--     a file with no expiry column produced a hold the sweep can never reach.
--
-- The hold was therefore IMMORTAL. It occupied the member's
-- `reservations_one_active_per_book_member` slot forever, and `LoansService.
-- renew` refuses every renewal of that title for every member while any
-- queued/ready hold exists — so importing an existing library's hold list, the
-- entire purpose of the reservation importer, wedged renewals on each affected
-- title until a staff member found and cancelled each hold by hand.
--
-- The engine is fixed. THIS FILE IS FOR THE ROWS IT ALREADY WROTE — a library
-- that has already run a hold import is carrying them right now, and no code
-- change reaches them.
--
-- THE REPAIR, per orphan hold, in the order a librarian would do it by hand:
--
--   1. If a copy of that book is `available`, this hold was RIGHT — it just
--      never claimed anything. Claim the copy (flip it to `reserved`), point
--      `fulfilledByCopyId` at it, and set a real pickup deadline from the
--      library's own `holdPickupHours`. The patron can now collect it and the
--      sweep can now expire it.
--   2. Otherwise the hold was a lie: there is nothing to hand over. Demote it
--      to `queued` at the BACK of that book's queue. That is the honest state —
--      the patron is waiting — and the ordinary promote-on-return path will
--      offer them the book when a copy comes back.
--
-- Nothing is deleted and no patron loses their place in line.
--
-- CONCURRENCY. Each book is processed while holding
-- `pg_advisory_xact_lock(hashtextextended('book:<id>', 0))` — the SAME lock
-- domain as placeHold / promote-on-return / promote-on-expiry / cancel-expire /
-- the importer (A7-01). So even if this runs against a live database, it cannot
-- race another allocation path into handing the same copy to two people.
--
-- TIMESTAMPS. `pg_catalog.now() AT TIME ZONE 'UTC'`, never bare `now()`. These
-- columns are `timestamp(3) WITHOUT time zone` holding UTC wall time, and the
-- session TimeZone here is Europe/Athens; MEASURED, `now()::timestamp(3)` came
-- back 2026-08-26 00:41 against a Node clock of 2026-08-25T21:41Z. A pickup
-- deadline three hours in the future relative to every reader of that column is
-- not a small error — it is three extra hours of a copy held off the shelf.
--
-- SCHEMA QUALIFICATION on every call (`pg_catalog.…`), because a restore runs
-- with an empty search_path and this database has functions resolving in both
-- `pg_catalog` and `public`.
--
-- IDEMPOTENT: the second run finds no `status='ready' AND fulfilledByCopyId IS
-- NULL` rows and does nothing. VERIFIED by applying twice against a scratch
-- database seeded with both shapes.
--
-- ORDERED BEFORE 20260826090000_catalog_natural_key_uniqueness on purpose: that
-- one can legitimately REFUSE to apply (two catalogue records sharing an ISBN
-- and both carrying copies), and prisma stops at the first failure. A wedged
-- patron should not wait on an unrelated catalogue merge.

DO $$
DECLARE
  book_ids      text[];
  book_id       text;
  hold          record;
  copy_id       text;
  next_position integer;
  pickup_hours  integer;
  promoted      integer := 0;
  requeued      integer := 0;
  stamp_utc     timestamp(3) := (pg_catalog.now() AT TIME ZONE 'UTC');
BEGIN
  -- The library's own pickup window, exactly as ReservationsService reads it.
  SELECT "holdPickupHours" INTO pickup_hours FROM tenant_settings WHERE id = 1;
  IF pickup_hours IS NULL OR pickup_hours < 1 THEN
    pickup_hours := 48; -- schema default; a tenant row should always exist
  END IF;

  -- Materialise the book list BEFORE the loop body starts mutating holds, so
  -- the loop is not iterating a cursor over a table it is writing to.
  SELECT pg_catalog.array_agg(DISTINCT "bookId")
    INTO book_ids
    FROM reservations
   WHERE status = 'ready'
     AND "fulfilledByCopyId" IS NULL;

  FOREACH book_id IN ARRAY COALESCE(book_ids, ARRAY[]::text[]) LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('book:' || book_id, 0)
    );

    SELECT COALESCE(pg_catalog.max("queuePosition"), 0)
      INTO next_position
      FROM reservations
     WHERE "bookId" = book_id
       AND status = 'queued';

    -- Oldest offer first, so whoever has been waiting longest gets the copy.
    FOR hold IN
      SELECT id, "placedAt", "readyAt"
        FROM reservations
       WHERE "bookId" = book_id
         AND status = 'ready'
         AND "fulfilledByCopyId" IS NULL
       ORDER BY COALESCE("readyAt", "placedAt"), id
    LOOP
      copy_id := NULL;
      SELECT c.id
        INTO copy_id
        FROM book_copies c
       WHERE c."bookId" = book_id
         AND c.status = 'available'
         AND c."archivedAt" IS NULL
       ORDER BY c."createdAt", c.id
       LIMIT 1;

      IF copy_id IS NOT NULL THEN
        UPDATE book_copies
           SET status = 'reserved',
               "updatedAt" = stamp_utc
         WHERE id = copy_id;

        -- `reservations_ready_after_placed` wants readyAt >= placedAt and
        -- `reservations_expires_after_ready` wants expiresAt > readyAt. Keeping
        -- the original readyAt (or falling back to placedAt) satisfies the
        -- first; the deadline satisfies the second and is also the fair answer —
        -- the pickup window starts when the patron could actually have been told.
        --
        -- MEASURED FROM GREATEST(now, readyAt), NOT FROM now.
        --
        -- A bare `now + pickup_hours` is only greater than readyAt while readyAt
        -- is in the PAST, and the old importer could write a hold dated in the
        -- future: an orphan `ready` row with readyAt 400 days ahead made this
        -- statement violate reservations_expires_after_ready and abort the whole
        -- migration — taking the next migration with it, since Prisma stops at
        -- the first failure. A repair that bricks a customer's upgrade is worse
        -- than the rows it was written to repair.
        --
        -- readyAt is deliberately NOT clamped back to now. placedAt can be in
        -- the future on the same corrupt row, and readyAt >= placedAt is the
        -- constraint that would then break instead. pickup_hours is floored at 1
        -- above, so the result is strictly greater either way.
        UPDATE reservations
           SET "fulfilledByCopyId" = copy_id,
               "readyAt"   = COALESCE("readyAt", "placedAt"),
               "expiresAt" = GREATEST(stamp_utc, COALESCE("readyAt", "placedAt"))
                             + (pickup_hours || ' hours')::interval,
               "queuePosition" = NULL,
               "updatedAt" = stamp_utc
         WHERE id = hold.id;
        promoted := promoted + 1;
      ELSE
        next_position := next_position + 1;
        -- `reservations_queue_position_when_queued` requires a position >= 1 on
        -- every queued hold, which is why the position is computed rather than
        -- nulled.
        UPDATE reservations
           SET status = 'queued',
               "queuePosition" = next_position,
               "readyAt"   = NULL,
               "expiresAt" = NULL,
               "updatedAt" = stamp_utc
         WHERE id = hold.id;
        requeued := requeued + 1;
      END IF;

      INSERT INTO audit_log (
        id, "actorType", action, "targetType", "targetId", "beforeJson", "afterJson", "occurredAt"
      ) VALUES (
        'holdfix' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''),
        'system',
        'reservation.repaired',
        'reservation',
        hold.id,
        pg_catalog.jsonb_build_object(
          'status', 'ready',
          'fulfilledByCopyId', NULL,
          'expiresAt', NULL
        ),
        pg_catalog.jsonb_build_object(
          'status', CASE WHEN copy_id IS NULL THEN 'queued' ELSE 'ready' END,
          'fulfilledByCopyId', copy_id,
          'migration', '20260826085000_repair_orphan_ready_holds',
          'reason', 'data-integrity-05: an imported ready hold owned no copy, so it could never be collected and never expired'
        ),
        stamp_utc
      );
    END LOOP;
  END LOOP;

  IF promoted + requeued > 0 THEN
    RAISE NOTICE 'data-integrity-05: repaired % orphan ready hold(s) — % now hold a copy, % moved to the queue; see audit_log action=reservation.repaired',
      promoted + requeued, promoted, requeued;
  END IF;
END $$;
