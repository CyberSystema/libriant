/**
 * Libriant — build a 1.x tenant database with realistic data in it.
 *
 * WHAT THIS IS FOR. Phase 19 writes the 1.0 → 2.0 upgrade: MARC records
 * synthesised from flat `books` rows, holdings per shelf location, an item per
 * copy, loans with `closed_at` back-filled, reservations converted to
 * title-level holds with bit-exact queue positions, fines converted to a
 * double-entry ledger. That script gets exactly one chance on a real library's
 * data, so it is tested on every commit against a database built by this
 * script — not against a hand-made row or two, but against the shapes that
 * actually break a migration.
 *
 * SO THE FIXTURE IS DELIBERATELY AWKWARD. Anyone can migrate tidy data. What
 * has to survive is:
 *
 *   Two books sharing an ISBN. The 1.0 constraint `books_isbn13_unique_active`
 *   forbids it among non-archived rows, and 2.0 drops that constraint because
 *   a set and its volumes, a reprint, and endemic publisher ISBN reuse in
 *   small Greek presses all legitimately share one. The fixture archives one
 *   of the pair, which is exactly how a real catalogue holds the state today.
 *
 *   Greek text in every text column, in capitals, with final sigma — the case
 *   the whole of phase 1 is about.
 *
 *   A loan that is `lost`: `returnedAt` is NULL forever, so the partial unique
 *   `loans_one_active_per_copy` pins that copy out of circulation. 2.0 splits
 *   `closed_at` from `returned_at` precisely to undo this, and the upgrade has
 *   to get it right.
 *
 *   A hold queue with gaps in it, and a `ready` hold with an expiry in the
 *   past, because queue positions must come across bit-exact.
 *
 *   An expression index over `immutable_unaccent`. Phase 20 relocates
 *   `unaccent` and `pg_trgm` out of `public`, which invalidates every
 *   unqualified index expression — this repository has already shipped
 *   20260825200000_qualify_immutable_unaccent for that exact bug and lost a
 *   control-plane restore to an unqualified `gen_random_uuid`. The upgrade
 *   must drop and recreate this index, and CI can only prove that if the
 *   fixture has one.
 *
 *   USAGE:
 *     TENANT_DATABASE_URL=…  pnpm seed:v1-fixture
 *     TENANT_DATABASE_URL=…  pnpm seed:v1-fixture --scale=10   # 10x the rows
 *     TENANT_DATABASE_URL=…  pnpm seed:v1-fixture --reset      # wipe first
 *
 * The default scale is small enough to run in a CI step (a few seconds) and
 * large enough that a full table scan is visibly different from an index scan.
 */
import { makeTenantPrismaClient } from '@libriant/db-tenant';
import { die, isYes, log, parseArgs } from './_lib/cli.js';

const SCRIPT = 'seed-v1-fixture';

const args = parseArgs({
  name: SCRIPT,
  description: 'Populate a 1.x tenant database with data shaped like a real library.',
  options: {
    scale: { type: 'string' },
    reset: { type: 'boolean' },
  },
});

/** Base counts at scale 1. Multiplied by `--scale`. */
const BASE = {
  authors: 400,
  books: 1_000,
  copies: 1_600,
  members: 500,
  loans: 800,
  reservations: 120,
  fines: 150,
};

async function main() {
  const v = args.values as Record<string, string | boolean | undefined>;
  const scale = Math.max(1, Math.min(200, Number(v.scale ?? '1')));
  const url = process.env.TENANT_DATABASE_URL;
  if (!url) die(SCRIPT, 'TENANT_DATABASE_URL is required.');

  const n = Object.fromEntries(
    Object.entries(BASE).map(([k, base]) => [k, base * scale]),
  ) as Record<keyof typeof BASE, number>;

  const db = makeTenantPrismaClient({ databaseUrl: url as string, maxPoolSize: 4 });
  const started = Date.now();

  try {
    const state = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`,
    );
    if (Number(state[0]?.n ?? 0n) === 0) {
      die(
        SCRIPT,
        'this database has no applied migrations. Run `pnpm tenant:migrate:deploy` first.',
      );
    }

    if (isYes(v.reset)) {
      log(SCRIPT, 'resetting library tables…');
      await db.$executeRawUnsafe(
        `TRUNCATE "fines", "reservations", "loans", "book_copies", "book_authors",
                  "books", "authors", "members", "member_number_counters",
                  "collection_records", "audit_log" RESTART IDENTITY CASCADE`,
      );
    }

    log(SCRIPT, `seeding at scale ${scale}: ${JSON.stringify(n)}`);

    // Greek names, in the capitals a real export uses. `ΣΟΦΟΣ` and friends are
    // here so the phase-20 search_text backfill has something to change.
    await db.$executeRawUnsafe(
      `INSERT INTO "authors" ("id","fullName","sortName","isOrganization","customFields","createdAt","updatedAt")
       SELECT 'a-' || g,
              (ARRAY['ΚΑΖΑΝΤΖΑΚΗΣ, ΝΙΚΟΣ','Παπαδόπουλος, Γιώργος','ΣΕΦΕΡΗΣ, ΓΙΩΡΓΟΣ',
                     'Ελύτης, Οδυσσέας','ΡΙΤΣΟΣ, ΓΙΑΝΝΗΣ','Woolf, Virginia'])[1 + g % 6]
                || ' ' || g,
              pg_catalog.lower((ARRAY['καζαντζακησ','παπαδοπουλος','σεφερησ','ελυτησ','ριτσος','woolf'])[1 + g % 6]) || ' ' || g,
              false, '{}'::jsonb,
              (pg_catalog.now() AT TIME ZONE 'UTC'), (pg_catalog.now() AT TIME ZONE 'UTC')
         FROM generate_series(1, ${n.authors}) g`,
    );

    await db.$executeRawUnsafe(
      `INSERT INTO "books" ("id","title","sortTitle","searchText","isbn13","publisher",
                            "publicationYear","language","classification","customFields",
                            "createdAt","updatedAt")
       SELECT 'b-' || g,
              (ARRAY['Η ΠΟΛΙΣ ΕΑΛΩ','Βίος και πολιτεία του Αλέξη Ζορμπά','ΤΟ ΑΞΙΟΝ ΕΣΤΙ',
                     'Μυθιστόρημα','ΕΠΙΤΑΦΙΟΣ','Mrs Dalloway'])[1 + g % 6] || ' ' || g,
              pg_catalog.lower((ARRAY['η πολις εαλω','βιος και πολιτεια','το αξιον εστι',
                     'μυθιστορημα','επιταφιος','mrs dalloway'])[1 + g % 6]) || ' ' || g,
              pg_catalog.lower((ARRAY['η πολις εαλω','βιος και πολιτεια','το αξιον εστι',
                     'μυθιστορημα','επιταφιος','mrs dalloway'])[1 + g % 6]) || ' ' || g,
              -- Unique on insert. The twins are made afterwards, because the
              -- partial unique index refuses them at INSERT time and only
              -- ignores a row once it is archived.
              '978' || pg_catalog.lpad(g::text, 10, '0'),
              (ARRAY['Καστανιώτης','Πατάκης','ΙΚΑΡΟΣ','Κέδρος'])[1 + g % 4],
              1900 + (g % 126), (ARRAY['el','en'])[1 + g % 2],
              (ARRAY['005.133','PA4037 .A2','027.4','82-31'])[1 + g % 4],
              '{}'::jsonb,
              (pg_catalog.now() AT TIME ZONE 'UTC'), (pg_catalog.now() AT TIME ZONE 'UTC')
         FROM generate_series(1, ${n.books}) g`,
    );
    // Now make the twins. ARCHIVE FIRST, then copy a neighbour's ISBN onto the
    // archived row: `books_isbn13_unique_active` only ignores archived rows, so
    // this is the one order that works — and it is exactly the order a
    // librarian arrives at the state by, having archived a duplicate record and
    // kept it for reference. 2.0 drops the constraint entirely, because a set
    // and its volumes, a reprint, and endemic publisher ISBN reuse in small
    // Greek presses all legitimately share one ISBN.
    const twinPairs = Math.max(1, Math.floor(n.books / 100) - 1);
    const twins = await db.$executeRawUnsafe(
      `UPDATE "books" AS b
          SET "archivedAt" = (pg_catalog.now() AT TIME ZONE 'UTC'),
              "isbn13" = src."isbn13"
         FROM generate_series(1, ${twinPairs}) AS s(g)
         JOIN "books" AS src ON src."id" = 'b-' || (s.g * 100)
        WHERE b."id" = 'b-' || (s.g * 100 + 1)`,
    );

    await db.$executeRawUnsafe(
      `INSERT INTO "book_authors" ("bookId","authorId","order","role")
       SELECT 'b-' || g, 'a-' || (1 + g % ${n.authors}), 0, NULL
         FROM generate_series(1, ${n.books}) g`,
    );

    await db.$executeRawUnsafe(
      `INSERT INTO "book_copies" ("id","bookId","barcode","status","shelfLocation",
                                  "acquiredAt","priceCents","customFields","createdAt","updatedAt")
       SELECT 'c-' || g, 'b-' || (1 + g % ${n.books}),
              'BC' || pg_catalog.lpad(g::text, 10, '0'),
              'available',
              (ARRAY['ΠΑΙΔ 1','REF 2','Α3','005.1'])[1 + g % 4],
              (pg_catalog.now() AT TIME ZONE 'UTC'), 1000 + g % 5000, '{}'::jsonb,
              (pg_catalog.now() AT TIME ZONE 'UTC'), (pg_catalog.now() AT TIME ZONE 'UTC')
         FROM generate_series(1, ${n.copies}) g`,
    );

    await db.$executeRawUnsafe(
      `INSERT INTO "members" ("id","memberNumber","fullName","sortName","searchText","email",
                              "status","joinedAt","customFields","createdAt","updatedAt")
       SELECT 'm-' || g,
              'M-2026-' || pg_catalog.lpad(g::text, 4, '0'),
              (ARRAY['ΓΕΩΡΓΙΟΥ, ΜΑΡΙΑ','Δημητρίου, Κώστας','ΠΑΠΑΣ, ΣΟΦΟΣ'])[1 + g % 3] || ' ' || g,
              pg_catalog.lower((ARRAY['γεωργιου μαρια','δημητριου κωστας','παπας σοφος'])[1 + g % 3]) || ' ' || g,
              pg_catalog.lower((ARRAY['γεωργιου μαρια','δημητριου κωστας','παπας σοφος'])[1 + g % 3]) || ' ' || g,
              'member' || g || '@example.test',
              (ARRAY['active','active','active','suspended'])[1 + g % 4]::"MemberStatus",
              (pg_catalog.now() AT TIME ZONE 'UTC'), '{}'::jsonb,
              (pg_catalog.now() AT TIME ZONE 'UTC'), (pg_catalog.now() AT TIME ZONE 'UTC')
         FROM generate_series(1, ${n.members}) g`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "member_number_counters" ("year","nextSeq") VALUES (2026, ${n.members + 1})
       ON CONFLICT ("year") DO UPDATE SET "nextSeq" = EXCLUDED."nextSeq"`,
    );

    // Loans: one per copy so `loans_one_active_per_copy` holds, with a slice
    // returned and a slice LOST — the state that traps a copy forever in 1.0.
    await db.$executeRawUnsafe(
      `INSERT INTO "loans" ("id","copyId","memberId","loanedAt","dueAt","returnedAt",
                            "renewedCount","status","customFields","createdAt","updatedAt")
       SELECT 'l-' || g, 'c-' || g, 'm-' || (1 + g % ${n.members}),
              (pg_catalog.now() AT TIME ZONE 'UTC') - (g % 60) * INTERVAL '1 day',
              (pg_catalog.now() AT TIME ZONE 'UTC') - (g % 60) * INTERVAL '1 day' + INTERVAL '14 days',
              CASE WHEN g % 4 = 0 THEN NULL
                   ELSE (pg_catalog.now() AT TIME ZONE 'UTC') - (g % 30) * INTERVAL '1 day' END,
              g % 3,
              (CASE WHEN g % 4 = 0 THEN (CASE WHEN g % 8 = 0 THEN 'lost' ELSE 'active' END)
                    ELSE 'returned' END)::"LoanStatus",
              '{}'::jsonb,
              (pg_catalog.now() AT TIME ZONE 'UTC'), (pg_catalog.now() AT TIME ZONE 'UTC')
         FROM generate_series(1, ${n.loans}) g`,
    );
    await db.$executeRawUnsafe(
      `UPDATE "book_copies" SET "status" = 'on_loan'
        WHERE "id" IN (SELECT "copyId" FROM "loans" WHERE "status" = 'active')`,
    );
    await db.$executeRawUnsafe(
      `UPDATE "book_copies" SET "status" = 'lost'
        WHERE "id" IN (SELECT "copyId" FROM "loans" WHERE "status" = 'lost')`,
    );

    // Holds: contiguous 1-based queues per book, plus one `ready` hold whose
    // pickup window has already closed. Positions must survive the upgrade
    // bit-exact, so they are built deterministically here.
    await db.$executeRawUnsafe(
      `INSERT INTO "reservations" ("id","bookId","memberId","placedAt","queuePosition","status",
                                   "readyAt","expiresAt","customFields","createdAt","updatedAt")
       SELECT 'r-' || g, 'b-' || (1 + g % 40), 'm-' || (1 + g % ${n.members}),
              -- Placed well before readyAt. reservations_ready_after_placed is
              -- a CHECK constraint, and a fixture that will not insert is no
              -- fixture. (No backticks in here: this is inside a template
              -- literal, where one ends the string.)
              (pg_catalog.now() AT TIME ZONE 'UTC') - INTERVAL '30 days' - g * INTERVAL '1 hour',
              1 + ((g - 1) / 40),
              (CASE WHEN g <= 40 THEN 'ready' ELSE 'queued' END)::"ReservationStatus",
              CASE WHEN g <= 40 THEN (pg_catalog.now() AT TIME ZONE 'UTC') - INTERVAL '5 days' END,
              CASE WHEN g <= 40 THEN (pg_catalog.now() AT TIME ZONE 'UTC') - INTERVAL '3 days' END,
              '{}'::jsonb,
              (pg_catalog.now() AT TIME ZONE 'UTC'), (pg_catalog.now() AT TIME ZONE 'UTC')
         FROM generate_series(1, ${n.reservations}) g`,
    );

    await db.$executeRawUnsafe(
      `INSERT INTO "fines" ("id","memberId","loanId","amountCents","currency","reason","status",
                            "paidAt","customFields","createdAt","updatedAt")
       SELECT 'f-' || g, 'm-' || (1 + g % ${n.members}),
              -- Every third fine hangs off a loan. At most ONE of those may be
              -- outstanding per loan (fines_one_outstanding_per_loan), and the
              -- modulo below gives each loan-linked fine a distinct loan, so
              -- that holds without thinking about it.
              CASE WHEN g % 3 = 0 THEN 'l-' || g ELSE NULL END,
              50 * (1 + g % 40), 'EUR',
              (ARRAY['Εκπρόθεσμη επιστροφή','Φθορά','Απώλεια'])[1 + g % 3],
              (ARRAY['outstanding','paid','waived'])[1 + g % 3]::"FineStatus",
              -- fines_paid_consistency: paid REQUIRES paidAt, and only paid or
              -- waived may carry one.
              CASE WHEN g % 3 = 1 THEN (pg_catalog.now() AT TIME ZONE 'UTC') END,
              '{}'::jsonb,
              (pg_catalog.now() AT TIME ZONE 'UTC'), (pg_catalog.now() AT TIME ZONE 'UTC')
         FROM generate_series(1, ${n.fines}) g`,
    );

    // The expression index phase 20's extension relocation must not break.
    await db.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION public.immutable_unaccent(text)
         RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
         AS $fn$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $fn$`,
    );
    await db.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "books_title_unaccent_idx"
         ON "books" (public.immutable_unaccent("title"))`,
    );

    const counts = await db.$queryRawUnsafe<Record<string, bigint>[]>(
      `SELECT (SELECT count(*) FROM "authors")      AS authors,
              (SELECT count(*) FROM "books")        AS books,
              (SELECT count(*) FROM "books" WHERE "archivedAt" IS NOT NULL) AS archived_books,
              (SELECT count(*) FROM "book_copies")  AS copies,
              (SELECT count(*) FROM "members")      AS members,
              (SELECT count(*) FROM "loans")        AS loans,
              (SELECT count(*) FROM "loans" WHERE "status" = 'lost') AS lost_loans,
              (SELECT count(*) FROM "reservations") AS reservations,
              (SELECT count(*) FROM "fines")        AS fines,
              (SELECT count(DISTINCT "isbn13") FROM "books" WHERE "isbn13" IS NOT NULL) AS distinct_isbns`,
    );
    const row = counts[0] as Record<string, bigint>;
    log(SCRIPT, '---');
    for (const [k, val] of Object.entries(row)) log(SCRIPT, `  ${k.padEnd(16)} ${val}`);
    log(SCRIPT, `  ${'isbn twins'.padEnd(16)} ${twins} archived so the 1.0 unique index holds`);
    log(SCRIPT, `done in ${Date.now() - started} ms.`);
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  process.stderr.write(`[${SCRIPT}] ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
