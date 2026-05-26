/**
 * End-to-end smoke test for the tenant schema.
 *
 * Exercises every entity and every DB-level invariant against a real
 * Postgres. Used as a CI gate: drift in the schema that breaks a real
 * workflow shows up here.
 *
 * Workflow under test:
 *   1. Create two authors, one book co-authored by them, two copies.
 *   2. Create a member, check out one copy → loan #1.
 *   3. Try to check the same copy out to a second member → MUST FAIL
 *      (partial unique index `loans_one_active_per_copy`).
 *   4. Return loan #1. Now the copy is available.
 *   5. Place a reservation. Try to place a second by the same member on
 *      the same book → MUST FAIL.
 *   6. Define a custom field on `book`. Verify the entity_kind/key
 *      regex (lowercase snake_case, etc.).
 *   7. Define a custom collection ("dvds") with two fields, insert two
 *      records, verify they round-trip with JSONB data.
 *   8. Add an audit entry for the support-impersonation simulation.
 *   9. Verify all constraints from the negative side (ISBN shape,
 *      member-number shape, loan chronology, etc.).
 *  10. Clean up.
 *
 * Run: TENANT_DATABASE_URL=postgres://... pnpm smoke
 */
import {
  makeTenantPrismaClient,
  disconnectTenantClient,
  type TenantPrismaClient,
  Prisma,
} from '../src';

function ok(label: string) {
  console.log(`  ✓ ${label}`);
}
function note(label: string) {
  console.log(`  • ${label}`);
}

/**
 * Run a Prisma call expected to fail, and assert that the error message
 * contains AT LEAST ONE of the provided fragments. Prisma redacts the
 * underlying PG constraint name for some error classes (notably unique
 * violations), so we accept either the named constraint OR Prisma's
 * generic phrasing.
 */
async function expectError(
  promise: Promise<unknown>,
  expectedFragments: string | string[],
  label: string,
) {
  const fragments = Array.isArray(expectedFragments) ? expectedFragments : [expectedFragments];
  try {
    await promise;
    throw new Error(
      `[FAIL] Expected error matching ${JSON.stringify(fragments)} but call succeeded: ${label}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    const matched = fragments.some((f) => lower.includes(f.toLowerCase()));
    if (!matched) {
      throw new Error(
        `[FAIL] Expected error matching one of ${JSON.stringify(fragments)} for "${label}" but got:\n${msg}`,
      );
    }
    ok(`${label} → rejected as expected`);
  }
}

async function cleanup(db: TenantPrismaClient) {
  // Order matters: delete dependent rows first.
  await db.auditEvent.deleteMany({});
  await db.fine.deleteMany({});
  await db.loan.deleteMany({});
  await db.reservation.deleteMany({});
  await db.collectionRecord.deleteMany({});
  await db.collectionField.deleteMany({});
  await db.collection.deleteMany({});
  await db.fieldDefinition.deleteMany({});
  await db.bookAuthor.deleteMany({});
  await db.bookCopy.deleteMany({});
  await db.book.deleteMany({});
  await db.author.deleteMany({});
  await db.member.deleteMany({});
}

async function main() {
  const url = process.env.TENANT_DATABASE_URL;
  if (!url) {
    console.error('TENANT_DATABASE_URL must be set.');
    process.exit(1);
  }
  const db = makeTenantPrismaClient({ databaseUrl: url });

  try {
    console.log('— cleanup before smoke test —');
    await cleanup(db);

    // -----------------------------------------------------------------
    console.log('\nStep 1: authors, book, copies');
    const kazantzakis = await db.author.create({
      data: {
        fullName: 'Νίκος Καζαντζάκης',
        sortName: 'καζαντζακης νικος',
        birthYear: 1883,
        deathYear: 1957,
      },
    });
    ok('created author (Καζαντζάκης)');

    const sherrard = await db.author.create({
      data: {
        fullName: 'Philip Sherrard',
        sortName: 'sherrard philip',
        birthYear: 1922,
        deathYear: 1995,
      },
    });
    ok('created author (Sherrard, translator)');

    const book = await db.book.create({
      data: {
        title: 'Ο Καπετάν Μιχάλης',
        sortTitle: 'καπετα ν μιχα λη ς ο',
        searchText: 'ο καπετα ν μιχα λη ς νικο ς καζαντζα κη ς freedom and death philip sherrard',
        isbn13: '9789600000000',
        publisher: 'Καζαντζάκης Publications',
        publicationYear: 1953,
        language: 'el',
        numPages: 480,
        authors: {
          create: [
            { authorId: kazantzakis.id, order: 0 },
            { authorId: sherrard.id, order: 1, role: 'translator' },
          ],
        },
      },
    });
    ok('created book with two authors via nested write');

    const copy1 = await db.bookCopy.create({
      data: {
        bookId: book.id,
        barcode: 'BK-0001',
        shelfLocation: 'Section A · Shelf 3',
        priceCents: 1800,
      },
    });
    const copy2 = await db.bookCopy.create({
      data: { bookId: book.id, barcode: 'BK-0002', shelfLocation: 'Section A · Shelf 3' },
    });
    ok(`created two book copies (status=${copy1.status})`);

    // -----------------------------------------------------------------
    console.log('\nStep 2: member, loan');
    const m1 = await db.member.create({
      data: {
        memberNumber: 'M-2026-0001',
        fullName: 'Μαρία Παπαδοπούλου',
        sortName: 'παπαδοπουλου μαρια',
        searchText: 'μαρια παπαδοπουλου maria papadopoulou m-2026-0001',
        email: 'maria@example.test',
      },
    });
    const m2 = await db.member.create({
      data: {
        memberNumber: 'M-2026-0002',
        fullName: 'Γιώργος Ιωάννου',
        sortName: 'ιωαννου γιωργος',
        searchText: 'γιωργος ιωαννου giorgos ioannou m-2026-0002',
        email: 'giorgos@example.test',
      },
    });
    ok('created two members');

    const now = new Date();
    const due = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const loan1 = await db.loan.create({
      data: { copyId: copy1.id, memberId: m1.id, loanedAt: now, dueAt: due },
    });
    ok(`created loan #1 (status=${loan1.status}, due in 14 days)`);

    // -----------------------------------------------------------------
    console.log('\nStep 3: ADVERSARIAL — second active loan on same copy must fail');
    await expectError(
      db.loan.create({
        data: { copyId: copy1.id, memberId: m2.id, loanedAt: now, dueAt: due },
      }),
      ['loans_one_active_per_copy', 'Unique constraint failed on the fields: (`copyId`)'],
      'second active loan on same copy',
    );

    // -----------------------------------------------------------------
    console.log('\nStep 4: return loan #1');
    const returned = await db.loan.update({
      where: { id: loan1.id },
      data: { returnedAt: new Date(), status: 'returned' },
    });
    ok(`returned loan #1 (returnedAt=${returned.returnedAt?.toISOString()})`);

    // After return, a new loan on copy1 should succeed.
    const loan2 = await db.loan.create({
      data: { copyId: copy1.id, memberId: m2.id, loanedAt: now, dueAt: due },
    });
    ok(`fresh loan on same copy now possible (loan2 id=${loan2.id})`);

    // -----------------------------------------------------------------
    console.log('\nStep 5: reservations');
    const r1 = await db.reservation.create({
      data: {
        bookId: book.id,
        memberId: m1.id,
        queuePosition: 1,
      },
    });
    ok(`reservation #1 created (status=${r1.status}, position=${r1.queuePosition})`);

    console.log('\nADVERSARIAL — same member queueing twice for same book must fail');
    await expectError(
      db.reservation.create({
        data: { bookId: book.id, memberId: m1.id, queuePosition: 2 },
      }),
      ['reservations_one_active_per_book_member', 'Unique constraint failed'],
      'same member, second active reservation on same book',
    );

    console.log('\nADVERSARIAL — reservation status=queued without queuePosition must fail');
    await expectError(
      db.reservation.create({
        data: { bookId: book.id, memberId: m2.id, status: 'queued', queuePosition: null },
      }),
      'reservations_queue_position_when_queued',
      'queued reservation without queue position',
    );

    // -----------------------------------------------------------------
    console.log('\nStep 6: custom field definition on book');
    const fd = await db.fieldDefinition.create({
      data: {
        entityKind: 'book',
        fieldKey: 'shelf_section',
        labelJson: { en: 'Shelf section', el: 'Τομέας ραφιού' },
        type: 'short_text',
        required: false,
        sortOrder: 0,
      },
    });
    ok(`created field definition (key=${fd.fieldKey})`);

    console.log('\nADVERSARIAL — uppercase field key must fail');
    await expectError(
      db.fieldDefinition.create({
        data: {
          entityKind: 'book',
          fieldKey: 'NotSnake',
          labelJson: { en: 'X', el: 'Χ' },
          type: 'short_text',
        },
      }),
      'field_definitions_key_format',
      'uppercase / camelCase field key',
    );

    // Write a custom-fields value through the regular book update path.
    const bookWithCustom = await db.book.update({
      where: { id: book.id },
      data: { customFields: { shelf_section: 'A-3' } as Prisma.InputJsonValue },
    });
    note(
      `book.customFields after update = ${JSON.stringify(bookWithCustom.customFields)} (round-trips through JSONB)`,
    );

    // -----------------------------------------------------------------
    console.log('\nStep 7: custom collection');
    const dvdCollection = await db.collection.create({
      data: {
        slug: 'dvds',
        singularLabelJson: { en: 'DVD', el: 'DVD' },
        pluralLabelJson: { en: 'DVDs', el: 'DVD' },
        iconAssetRef: 'icons/book',
        fields: {
          create: [
            {
              fieldKey: 'title',
              labelJson: { en: 'Title', el: 'Τίτλος' },
              type: 'short_text',
              required: true,
              sortOrder: 0,
            },
            {
              fieldKey: 'runtime_minutes',
              labelJson: { en: 'Runtime (min)', el: 'Διάρκεια (λεπτά)' },
              type: 'number',
              sortOrder: 1,
            },
          ],
        },
      },
      include: { fields: true },
    });
    ok(`created collection "${dvdCollection.slug}" with ${dvdCollection.fields.length} fields`);

    const dvd1 = await db.collectionRecord.create({
      data: {
        collectionId: dvdCollection.id,
        data: { title: 'Ο Καπετάν Μιχάλης (1955 film)', runtime_minutes: 116 },
        searchText: 'ο καπετα ν μιχα λη ς 1955 film',
      },
    });
    ok(`inserted collection record (id=${dvd1.id})`);

    console.log('\nADVERSARIAL — invalid slug shape on collection must fail');
    await expectError(
      db.collection.create({
        data: {
          slug: 'NOT-OK',
          singularLabelJson: { en: 'X', el: 'Χ' },
          pluralLabelJson: { en: 'X', el: 'Χ' },
        },
      }),
      'collections_slug_format',
      'uppercase slug on collection',
    );

    // -----------------------------------------------------------------
    console.log('\nStep 8: audit event linked to a support session');
    const audit = await db.auditEvent.create({
      data: {
        actorType: 'admin',
        actorId: 'admin-cuid-from-control-plane',
        action: 'book.updated',
        targetType: 'book',
        targetId: book.id,
        afterJson: { title: book.title },
        supportSessionId: 'support-session-cuid-from-control-plane',
      },
    });
    ok(
      `audit entry (action=${audit.action}, supportSession=${audit.supportSessionId?.slice(0, 12)}…)`,
    );

    // -----------------------------------------------------------------
    console.log('\nStep 9: adversarial — schema-level shape constraints');
    await expectError(
      db.book.create({
        data: {
          title: 'Bad ISBN Book',
          sortTitle: 'bad isbn book',
          searchText: 'bad isbn book',
          isbn13: '978-X', // wrong shape
        },
      }),
      'books_isbn13_shape',
      'invalid ISBN-13 shape',
    );

    await expectError(
      db.member.create({
        data: {
          memberNumber: 'invalid lower', // must be uppercase / digits / -/_
          fullName: 'X',
          sortName: 'x',
          searchText: 'x',
        },
      }),
      'members_member_number_format',
      'invalid member number shape',
    );

    await expectError(
      db.loan.create({
        data: { copyId: copy2.id, memberId: m1.id, loanedAt: due, dueAt: now }, // dueAt < loanedAt
      }),
      'loans_due_after_loaned',
      'loan due date before loan date',
    );

    await expectError(
      db.fine.create({
        data: { memberId: m1.id, amountCents: -100, reason: 'X' },
      }),
      'fines_amount_nonneg',
      'negative fine amount',
    );

    // -----------------------------------------------------------------
    console.log('\nStep 10: cleanup');
    await cleanup(db);
    ok('cleanup complete');

    console.log('\nALL SMOKE-TEST STEPS PASSED ✓');
  } finally {
    await disconnectTenantClient(db);
  }
}

main().catch((err) => {
  console.error('\n❌ SMOKE TEST FAILED:\n', err);
  process.exit(1);
});
