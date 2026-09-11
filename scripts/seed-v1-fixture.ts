#!/usr/bin/env tsx
/**
 * A 1.0 library, generated deterministically, for the upgrade to be run against
 * (2.0 phase 19b).
 *
 * ## Two profiles, and why not one
 *
 * §6's acceptance fixture is 50,000 books / 12,000 authors / 80,000 copies /
 * 40,000 loans. Running that on every commit would add roughly twenty minutes to
 * a job that already applies thirteen migrations, runs two DR drills, replays a
 * shadow-database drift check and runs the smoke suite — for a signal that does
 * not change between commits.
 *
 *   `ci`         1,000 books and proportional, EVERY awkward shape present.
 *                Runs on every commit. Seconds.
 *   `acceptance` §6's numbers. Nightly and on demand.
 *
 * The split only works because the SHAPES are in both. A fast fixture that is
 * merely smaller tests a different library: the rows that break a migration are
 * the zero-amount fine, the duplicate queue position, the Greek title with a
 * leading article, the member with no email. Those are seeded explicitly at both
 * sizes rather than left to a probability.
 *
 * ## Deterministic
 *
 * A fixed LCG, no `Math.random`, no clock. A migration that fails once in CI and
 * never again is worse than one that fails every time: the second can be fixed.
 */
import { Client } from 'pg';
import { PG_SESSION_OPTIONS } from '@libriant/shared/postgres-session';
import { die, log, parseArgs } from './_lib/cli.js';

const NAME = 'seed-v1-fixture';

const args = parseArgs({
  name: NAME,
  description: "Fill a database's 1.0 `public` schema with a deterministic library.",
  options: { url: { type: 'string' }, profile: { type: 'string' } },
  required: ['url'],
});

const PROFILES = {
  ci: {
    books: 1_000,
    authors: 320,
    copies: 1_600,
    members: 500,
    loans: 800,
    holds: 120,
    fines: 150,
    audit: 2_000,
  },
  acceptance: {
    books: 50_000,
    authors: 12_000,
    copies: 80_000,
    members: 25_000,
    loans: 40_000,
    holds: 6_000,
    fines: 7_500,
    audit: 40_000,
  },
} as const;

const profile = (args.values.profile as keyof typeof PROFILES | undefined) ?? 'ci';
if (!(profile in PROFILES)) die(NAME, `unknown profile ${profile}; expected ci or acceptance`);
const N = PROFILES[profile];

/** A fixed LCG. See the file docblock: reproducibility beats variety. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}
const rand = lcg(19_260_919);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const id = (p: string, n: number): string => `${p}${String(n).padStart(19, '0')}`;

/**
 * A DISTINCT, check-digit-valid ISBN-13 per book.
 *
 * 1.0 carries `books_isbn13_unique_active`, which §3 DROPS in 2.0 — "a set and
 * its volumes, a reprint, and endemic publisher ISBN reuse in small Greek
 * presses all legitimately share an ISBN, and the 1.0 constraint would refuse
 * the exact catalogues this product exists to import". The fixture still has to
 * be a valid 1.0 library, so every ISBN here is unique; the DUPLICATE case
 * belongs to the phase-20 cutover test, which is where the constraint is dropped.
 */
function isbn13(n: number): string {
  const body = `978${String(n).padStart(9, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

/**
 * Greek titles with LEADING ARTICLES, because 245 ind2 is the thing most likely
 * to be silently wrong and the thing no row count would show.
 */
const TITLES = [
  'Η πόλις εάλω',
  'Ο Ζορμπάς',
  'Το κιβώτιο',
  'Βίος και πολιτεία του Αλέξη Ζορμπά',
  'The Hobbit',
  'Le Petit Prince',
  'ΠΟΛΙΣ',
];
const NAMES = [
  'Καζαντζάκης, Νίκος',
  'Παπαδόπουλος, Γιώργος',
  'Σεφέρης, Γιώργος',
  'Tolkien, J.R.R.',
];

async function main(): Promise<void> {
  const c = new Client({
    connectionString: args.values.url as string,
    options: PG_SESSION_OPTIONS,
  });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL search_path TO public`);

    await c.query(
      `INSERT INTO tenant_settings (id, currency, "loanPeriodDays", "maxRenewals",
         "finePerDayCents", "fineCapCents", "holdPickupHours", "maxActiveLoans", "defaultLocale",
         "createdAt", "updatedAt", "renewalsEnabled", "overdueFinesEnabled", "lostItemFeesEnabled",
         "lostItemDefaultFeeCents", "reservationsEnabled", "notifyDueSoon", "dueSoonDays",
         "notifyOverdue", "notifyHoldReady", "notificationTemplates")
       VALUES (1, 'EUR', 21, 0, 20, 0, 72, 5, 'el', pg_catalog.now(), pg_catalog.now(),
               true, true, true, 2500, true, true, 3, true, true, '{"overdue":"Το βιβλίο σας"}')
       ON CONFLICT (id) DO NOTHING`,
    );
    // maxRenewals 0 and fineCapCents 0 are DELIBERATE and mean different things:
    // zero renewals is a real setting, zero cap means uncapped. The verifier
    // asserts both crossings (F04, F05).

    const authors: string[] = [];
    for (let i = 0; i < N.authors; i += 1) {
      const aid = id('clauth', i);
      authors.push(aid);
      await c.query(
        `INSERT INTO authors (id, "fullName", "sortName", "isOrganization", "birthYear", "deathYear",
           notes, "customFields", "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,'{}',pg_catalog.now(),pg_catalog.now())`,
        [
          aid,
          pick(NAMES),
          `sort ${i}`,
          i % 40 === 0,
          1883 + (i % 60),
          null,
          i % 25 === 0 ? 'a note' : null,
        ],
      );
    }
    // AN ORPHAN AUTHOR — linked to no book. It has no MARC home and assertion
    // A12 requires it to be RECORDED rather than lost. No candidate design for
    // this phase had that assertion at all.
    await c.query(
      `INSERT INTO authors (id, "fullName", "sortName", "isOrganization", "customFields", "createdAt", "updatedAt")
       VALUES ('clauth-orphan', 'Ορφανός, Συγγραφέας', 'orfanos', false, '{}', pg_catalog.now(), pg_catalog.now())`,
    );

    for (let i = 0; i < N.books; i += 1) {
      const bid = id('clbook', i);
      await c.query(
        `INSERT INTO books (id, title, subtitle, "sortTitle", "searchText", isbn13, isbn10,
           publisher, "publicationYear", language, edition, "numPages", description,
           classification, "customFields", "createdAt", "updatedAt", "archivedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'{}',
                 pg_catalog.now() - ($15 || ' days')::interval, pg_catalog.now(), $16)`,
        [
          bid,
          pick(TITLES),
          i % 7 === 0 ? 'μυθιστόρημα' : null,
          `sort ${i}`,
          `search ${i}`,
          // One in 50 has a BAD check digit, which must land in 020 $z with an
          // exception rather than being dropped or silently accepted.
          // One in 50 has a BAD check digit and must land in 020 $z with an
          // exception; the rest are distinct and valid.
          i % 50 === 0 ? `978000000${String(i).padStart(3, '0')}1` : i % 3 === 0 ? isbn13(i) : null,
          i % 11 === 0 ? `026203${String(i % 1000).padStart(3, '0')}4` : null,
          i % 5 === 0 ? 'Εκδόσεις Καστανιώτη' : null,
          1950 + (i % 70),
          // One in 60 has a language code outside ISO 639-2/B.
          i % 60 === 0 ? 'zz' : i % 4 === 0 ? 'en' : 'el',
          null,
          120 + (i % 400),
          i % 9 === 0 ? 'Μια περίληψη.' : null,
          i % 6 === 0 ? '889.332' : i % 13 === 0 ? 'ΛΟΓ-ΚΑΖ' : null,
          String(30 + (i % 3000)),
          i % 97 === 0 ? new Date() : null,
        ],
      );
      const howMany = i % 13 === 0 ? 0 : 1 + (i % 3);
      for (let k = 0; k < howMany; k += 1) {
        await c.query(
          `INSERT INTO book_authors ("bookId", "authorId", "order", role) VALUES ($1,$2,$3,$4)
           ON CONFLICT DO NOTHING`,
          // A TRANSLATOR AT ORDER 0 on one in 30 — the shape that migrates as
          // the author if $e is dropped from the main entry.
          [
            bid,
            authors[(i * 3 + k) % authors.length],
            k,
            k === 0 && i % 30 === 0 ? 'translator' : k > 0 ? 'editor' : null,
          ],
        );
      }
    }

    for (let i = 0; i < N.members; i += 1) {
      await c.query(
        `INSERT INTO members (id, "memberNumber", "fullName", "sortName", "searchText", email, phone,
           "dateOfBirth", "addressLine1", city, "postalCode", country, status, "staffNotes",
           "joinedAt", "customFields", "createdAt", "updatedAt", "archivedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                 pg_catalog.now(),'{}',pg_catalog.now(),pg_catalog.now(),$15)`,
        [
          id('clmemb', i),
          `M-2026-${String(i).padStart(5, '0')}`,
          'Παπαδοπούλου, Ελένη',
          `sort ${i}`,
          `search ${i}`,
          // MOST MEMBERS HAVE NO EMAIL. A search_text built without COALESCE
          // goes NULL for all of them, and the source column is gone afterwards.
          i % 4 === 0 ? `Ε.Παπαδοπουλου${i}@example.gr` : null,
          i % 3 === 0 ? '2101234567' : null,
          null,
          i % 5 === 0 ? 'Οδός 1' : null,
          i % 5 === 0 ? 'Αθήνα' : null,
          null,
          null,
          // `archived` has no patron_status counterpart — a bare cast is 22P02.
          i % 23 === 0 ? 'archived' : i % 17 === 0 ? 'suspended' : 'active',
          null,
          i % 23 === 0 ? new Date() : null,
        ],
      );
    }
    await c.query(
      `INSERT INTO member_number_counters (year, "nextSeq") VALUES (2026, $1)
       ON CONFLICT (year) DO NOTHING`,
      [N.members + 500],
    );

    const copies: string[] = [];
    for (let i = 0; i < N.copies; i += 1) {
      const cid = id('clcopy', i);
      copies.push(cid);
      await c.query(
        `INSERT INTO book_copies (id, "bookId", barcode, status, "shelfLocation", "conditionNotes",
           "acquiredAt", "priceCents", "customFields", "createdAt", "updatedAt", "archivedAt")
         VALUES ($1,$2,$3,$4,$5,$6,pg_catalog.now(),$7,'{}',pg_catalog.now(),pg_catalog.now(),NULL)`,
        [
          cid,
          id('clbook', i % N.books),
          // A GREEK barcode: items.barcode_norm folds and patron_cards does not.
          i % 40 === 0 ? `ΑΒΓ-${i}` : `BC-${i}`,
          // All six 1.0 statuses appear; three have no 2.0 counterpart.
          pick([
            'available',
            'available',
            'available',
            'on_loan',
            'reserved',
            'lost',
            'damaged',
            'withdrawn',
          ]),
          i % 6 === 0 ? 'Ράφι Α1' : null,
          null,
          1000 + (i % 3000),
        ],
      );
    }

    for (let i = 0; i < N.loans; i += 1) {
      const returned = i % 3 !== 0;
      const lost = !returned && i % 11 === 0;
      await c.query(
        `INSERT INTO loans (id, "copyId", "memberId", "loanedAt", "dueAt", "returnedAt",
           "renewedCount", status, notes, "customFields", "createdAt", "updatedAt")
         VALUES ($1,$2,$3, pg_catalog.now() - interval '40 days', pg_catalog.now() - interval '19 days',
                 $4,$5,$6,$7,'{}',pg_catalog.now(),pg_catalog.now())`,
        [
          id('clloan', i),
          copies[i % copies.length],
          id('clmemb', i % N.members),
          returned ? new Date() : null,
          i % 7,
          lost ? 'lost' : returned ? 'returned' : 'active',
          // A LOST loan's note is the one that says so, and it is dropped by any
          // design that routes notes onto the `returned` event.
          lost ? 'lost report filed 12/3' : i % 9 === 0 ? 'borrower says posted back' : null,
        ],
      );
    }

    for (let i = 0; i < N.holds; i += 1) {
      await c.query(
        `INSERT INTO reservations (id, "bookId", "memberId", "placedAt", "queuePosition", status,
           "readyAt", "expiresAt", "customFields", "createdAt", "updatedAt")
         VALUES ($1,$2,$3, pg_catalog.now() - interval '5 days', $4,$5,$6,$7,'{}',
                 pg_catalog.now(), pg_catalog.now())`,
        [
          id('clresv', i),
          // Deliberately few bibs, so queues are DEEP and the positions collide.
          id('clbook', i % 20),
          id('clmemb', (i * 7) % N.members),
          // DUPLICATES AND GAPS — the corruption 1.0 can actually reach, and
          // the reason "bit-exact" cannot survive.
          //
          // NOT position 0: 1.0 carries `reservations_queue_position_when_queued`
          // CHECK (status <> 'queued' OR queuePosition >= 1), so a zero is
          // refused at the source and the blanket `> 0` decrement ABORTS there
          // rather than committing one. What 1.0 does NOT have is a unique on
          // (bookId, queuePosition) — `reservations_bookId_status_queuePosition_idx`
          // is a plain index — so two queued requests for one book can share a
          // position, and nothing makes the sequence dense. Both are refused by
          // 2.0's `holds_one_hold_per_position` and by the contiguity assertion,
          // which is what forces the renumber.
          i % 5 === 0 ? 1 : 1 + (i % 4),
          i % 6 === 0 ? 'ready' : i % 13 === 0 ? 'canceled' : 'queued',
          i % 6 === 0 ? new Date() : null,
          i % 6 === 0 ? new Date(Date.now() + 86_400_000 * 3) : null,
        ],
      );
    }

    for (let i = 0; i < N.fines; i += 1) {
      await c.query(
        `INSERT INTO fines (id, "memberId", "loanId", "amountCents", currency, reason, status,
           "paidAt", notes, "customFields", "createdAt", "updatedAt", "archivedAt")
         VALUES ($1,$2,$3,$4,'EUR',$5,$6,$7,$8,'{}',pg_catalog.now(),pg_catalog.now(),$9)`,
        [
          id('clfine', i),
          id('clmemb', i % N.members),
          i % 2 === 0 ? id('clloan', i % N.loans) : null,
          // A ZERO fine on one in 25: fees_amount_is_positive refuses it, and
          // promoting it to a cent would invent a debt.
          i % 25 === 0 ? 0 : 100 + (i % 900),
          i % 8 === 0 ? 'lost item replacement' : 'overdue',
          i % 3 === 0 ? 'paid' : i % 7 === 0 ? 'waived' : 'outstanding',
          i % 3 === 0 ? new Date() : null,
          i % 10 === 0 ? 'agreed instalments' : null,
          // An ARCHIVED but PAID fine: the fact that is lost if archived_at is
          // folded into status='cancelled'.
          i % 31 === 0 ? new Date() : null,
        ],
      );
    }

    for (let i = 0; i < N.audit; i += 1) {
      await c.query(
        `INSERT INTO audit_log (id, "actorType", "actorId", action, "targetType", "targetId",
           "beforeJson", "afterJson", ip, "userAgent", "supportSessionId", "occurredAt")
         VALUES ($1,'user',$2,'update','book',$3,$4,$5,'10.0.0.1','test',$6,
                 pg_catalog.now() - ($7 || ' days')::interval)`,
        [
          id('claudit', i),
          'user-1',
          id('clbook', i % N.books),
          JSON.stringify({ title: 'before' }),
          JSON.stringify({ title: 'after' }),
          i % 50 === 0 ? 'sess-1' : null,
          // SPREAD ACROSS MONTHS, so the partition routing is exercised: a row
          // whose month has no partition aborts with 23514.
          String(i % 400),
        ],
      );
    }

    await c.query('COMMIT');
    log(
      NAME,
      `seeded the ${profile} profile: ${N.books} books, ${N.copies} copies, ${N.members} members`,
    );
  } catch (err: unknown) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    await c.end();
  }
}

main().catch((err: unknown) => {
  // tsx loads a script as CJS, so `await main()` at top level is a build error
  // ("Top-level await is currently not supported with the cjs output format").
  // Every other script here ends the same way for the same reason.
  console.error(err);
  process.exitCode = 1;
});
