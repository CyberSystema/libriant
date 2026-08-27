import { GoneException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { controlDb, type LibraryType } from '@libriant/db-control';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { StorageService } from '../storage/storage.service.js';
import {
  assessMinor,
  noticeIsAboutSubject,
  subjectAccessFilename,
  type MinorAssessment,
} from './subject-access-bundle.js';

/**
 * Per-data-subject access and portability (GDPR Art. 15 and Art. 20) —
 * privacy-legal-15.
 *
 * ## The failure this exists for
 *
 * The only export in the product was `POST /t/:slug/exports`: the WHOLE
 * library, every member's name, date of birth, address, phone and complete
 * borrowing history, in one file that then sits downloadable for 24 hours. When
 * one member asked what the library held about them, that dump plus a manual
 * extraction was the answer on offer — a fresh disclosure risk created every
 * time somebody exercised a right, which is the opposite of what Art. 5(1)(c)
 * asks for. DPA §7.2 said so in as many words rather than pretending otherwise.
 *
 * ## What this produces
 *
 * One member, everything held about them, as JSON: the registry row, their
 * loans, their reservations, their fines, the notices the platform addressed to
 * them, the activity log entries about their record, and their photo. JSON
 * rather than the CSV/XLSX/SQL the tenant export offers, because Art. 20 asks
 * for "structured, commonly used and machine-readable" and this is relational
 * data — a folder of CSVs would need a zip and would lose the shape that makes
 * it portable.
 *
 * ## Matching is by id, deliberately
 *
 * `MembersService.erase()` finds this person's residue by id AND by searching
 * for their e-mail address inside every audit payload, because erasure may
 * safely over-match: redacting one row too many harms nobody. Disclosure is the
 * mirror image. A row that merely CONTAINS the address may be about the person
 * at the next desk, and putting it in an Art. 15 answer is a personal-data
 * breach committed while answering a privacy request. So every section here is
 * matched on a foreign key, and the bundle says out loud, in `notCovered`, that
 * it under-matches on purpose.
 *
 * The one section that cannot be matched on a key is the notice history — the
 * control-plane outbox holds no member id — so it matches on the address AND
 * then drops anything the notice's own metadata attributes to another member.
 * See {@link noticeIsAboutSubject}.
 */

/**
 * Per-section row cap. A member with a decade of borrowing is a few hundred
 * loans, so this is not a real ceiling for anybody — it is a bound on how much
 * one HTTP response can be made to allocate. When a section is cut, the bundle
 * says so in `truncated` instead of silently answering less than the right
 * requires.
 */
const SECTION_LIMIT = 5_000;

/**
 * Largest photo inlined as base64. A member photo is a passport-style snap of a
 * face; anything past this is an import artefact, and turning 25 MB (the upload
 * ceiling) into 34 MB of base64 in a single JSON response is how a librarian's
 * browser tab dies mid-request. Above the cap the bundle carries the storage
 * reference and says why the bytes are missing.
 */
const PHOTO_INLINE_LIMIT_BYTES = 8 * 1024 * 1024;

export type SubjectAccessBundle = Record<string, unknown> & { generatedAt: string };

export type SubjectAccessResult = {
  filename: string;
  bundle: SubjectAccessBundle;
};

@Injectable()
export class SubjectAccessService {
  private readonly logger = new Logger(SubjectAccessService.name);

  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  async build(
    tenant: TenantContext,
    memberId: string,
    actor: TenantActor,
  ): Promise<SubjectAccessResult> {
    const client = this.tenantPrisma.getClient(tenant);
    const member = await client.member.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException('Member not found.');
    if (member.erasedAt) {
      // 410, not 200 with a page of tombstones. Handing back `[erased]` in
      // every field reads like an answer and is not one, and re-assembling what
      // is left of an erased person is precisely what Art. 17 forbade.
      throw new GoneException(
        'This member’s record was erased under Article 17, so there is nothing left to disclose. ' +
          'The library’s activity log still records that the erasure happened.',
      );
    }

    const libraryType = await this.libraryTypeOf(tenant);
    const now = new Date();
    const minor = assessMinor(member.dateOfBirth, libraryType, now);

    const [loans, reservations, fines] = await Promise.all([
      client.loan.findMany({
        where: { memberId },
        orderBy: [{ loanedAt: 'desc' }, { id: 'desc' }],
        take: SECTION_LIMIT + 1,
        select: {
          id: true,
          loanedAt: true,
          dueAt: true,
          returnedAt: true,
          renewedCount: true,
          status: true,
          notes: true,
          customFields: true,
          createdAt: true,
          copy: { select: { barcode: true, book: { select: { title: true, isbn13: true } } } },
        },
      }),
      client.reservation.findMany({
        where: { memberId },
        orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
        take: SECTION_LIMIT + 1,
        select: {
          id: true,
          placedAt: true,
          queuePosition: true,
          status: true,
          readyAt: true,
          expiresAt: true,
          fulfilledAt: true,
          canceledAt: true,
          notes: true,
          customFields: true,
          book: { select: { title: true, isbn13: true } },
        },
      }),
      client.fine.findMany({
        where: { memberId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: SECTION_LIMIT + 1,
        select: {
          id: true,
          loanId: true,
          amountCents: true,
          currency: true,
          reason: true,
          status: true,
          paidAt: true,
          notes: true,
          customFields: true,
          createdAt: true,
          archivedAt: true,
        },
      }),
    ]);

    const loanIds = new Set(loans.map((l) => l.id));
    const reservationIds = new Set(reservations.map((r) => r.id));

    const [activity, notifications, photo] = await Promise.all([
      this.activityFor(client, memberId, loanIds, reservationIds, fines),
      this.notificationsFor(tenant, member.email, loanIds, reservationIds),
      this.photoFor(tenant, member.photoAssetRef),
    ]);

    const loanPage = loans.slice(0, SECTION_LIMIT);
    const reservationPage = reservations.slice(0, SECTION_LIMIT);
    const finePage = fines.slice(0, SECTION_LIMIT);
    const truncated = {
      loans: loans.length > SECTION_LIMIT,
      reservations: reservations.length > SECTION_LIMIT,
      fines: fines.length > SECTION_LIMIT,
      activity: activity.truncated,
      notifications: notifications.truncated,
    };

    const bundle: SubjectAccessBundle = {
      bundle: 'libriant.subject-access',
      bundleVersion: 1,
      generatedAt: now.toISOString(),
      basis: ['GDPR Article 15 (access)', 'GDPR Article 20 (portability)'],
      library: { slug: tenant.slug, name: tenant.name, libraryType },
      dataSubject: {
        id: member.id,
        memberNumber: member.memberNumber,
        fullName: member.fullName,
        email: member.email,
        phone: member.phone,
        dateOfBirth: member.dateOfBirth ? member.dateOfBirth.toISOString().slice(0, 10) : null,
        addressLine1: member.addressLine1,
        addressLine2: member.addressLine2,
        city: member.city,
        postalCode: member.postalCode,
        country: member.country,
        status: member.status,
        joinedAt: member.joinedAt,
        archivedAt: member.archivedAt,
        customFields: member.customFields,
        // Free text a librarian typed ABOUT this person. It is their personal
        // data and Art. 15 reaches it — but it is also the field most likely to
        // name somebody else ("collected by her father"), so `handling` below
        // tells the librarian to read it before the file leaves the building.
        staffNotes: member.staffNotes,
        minor,
      },
      loans: loanPage,
      reservations: reservationPage,
      fines: finePage,
      notifications: notifications.items,
      activity: activity.items,
      photo,
      truncated,
      notCovered: NOT_COVERED,
      handling: handlingNotice(minor),
    };

    await this.audit.record(tenant, actor, {
      action: 'member.data_exported',
      targetType: 'member',
      targetId: member.id,
      // Counts only. The row that records answering a subject-access request
      // must not become a second copy of the answer.
      after: {
        loans: loanPage.length,
        reservations: reservationPage.length,
        fines: finePage.length,
        notifications: notifications.items.length,
        activity: activity.items.length,
        photoIncluded: photo !== null && photo.dataBase64 !== null,
      },
    });

    return {
      filename: subjectAccessFilename(tenant.slug, member.memberNumber, now),
      bundle,
    };
  }

  /**
   * The library's own category, which `TenantContext` does not carry. Only
   * `school` changes anything (see {@link assessMinor}), and a failure to read
   * it must not fail a subject-access request — the bundle degrades to "type
   * unknown" rather than 500ing on a librarian with a member at the counter.
   */
  private async libraryTypeOf(tenant: TenantContext): Promise<LibraryType | null> {
    try {
      const row = await controlDb.tenant.findUnique({
        where: { id: tenant.id },
        select: { libraryType: true },
      });
      return row?.libraryType ?? null;
    } catch (err) {
      this.logger.warn(`could not read libraryType for ${tenant.slug}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Activity-log entries about this person: the rows targeting their member
   * record, their loans, their reservations and their fines.
   *
   * `actorId` is NOT carried through. Which member of staff edited the record
   * is that employee's personal data, not the member's, and Art. 15(4) says the
   * copy must not adversely affect the rights of others; the library can still
   * read the full attributed trail in its own activity feed. `actorType` and
   * `viaSupport` stay, because "a Libriant support session touched your record"
   * is something the data subject is entitled to know.
   */
  private async activityFor(
    client: ReturnType<TenantPrismaService['getClient']>,
    memberId: string,
    loanIds: ReadonlySet<string>,
    reservationIds: ReadonlySet<string>,
    fines: ReadonlyArray<{ id: string }>,
  ): Promise<{ items: Record<string, unknown>[]; truncated: boolean }> {
    const rows = await client.auditEvent.findMany({
      where: {
        OR: [
          { targetType: 'member', targetId: memberId },
          { targetType: 'loan', targetId: { in: [...loanIds] } },
          { targetType: 'reservation', targetId: { in: [...reservationIds] } },
          { targetType: 'fine', targetId: { in: fines.map((f) => f.id) } },
        ],
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: SECTION_LIMIT + 1,
      select: {
        id: true,
        occurredAt: true,
        action: true,
        actorType: true,
        targetType: true,
        targetId: true,
        beforeJson: true,
        afterJson: true,
        supportSessionId: true,
      },
    });
    const page = rows.slice(0, SECTION_LIMIT);
    return {
      truncated: rows.length > SECTION_LIMIT,
      items: page.map((r) => ({
        id: r.id,
        occurredAt: r.occurredAt,
        action: r.action,
        actorType: r.actorType,
        viaSupport: r.supportSessionId !== null,
        targetType: r.targetType,
        targetId: r.targetId,
        before: r.beforeJson,
        after: r.afterJson,
      })),
    };
  }

  /**
   * Every notice the platform composed for this person, from the control-plane
   * outbox.
   *
   * The outbox has no member id — it is keyed on the e-mail address — so this
   * matches on the address AND on the loan/reservation the notice names, and
   * drops anything whose loan or reservation belongs to somebody else. See
   * {@link noticeIsAboutSubject}: the shared mailbox is not hypothetical, it is
   * the workflow the DPIA pack tells school libraries to use for pupils.
   *
   * On the shipped configuration (`EMAIL_DRIVER=console`) these rows exist and
   * were never delivered; `status` says which, and that is itself something an
   * Art. 15 answer should not gloss over.
   */
  private async notificationsFor(
    tenant: TenantContext,
    email: string | null,
    loanIds: ReadonlySet<string>,
    reservationIds: ReadonlySet<string>,
  ): Promise<{ items: Record<string, unknown>[]; truncated: boolean }> {
    const loans = [...loanIds];
    const reservations = [...reservationIds];
    if (!email && loans.length === 0 && reservations.length === 0) {
      return { items: [], truncated: false };
    }
    type Row = {
      id: string;
      kind: string;
      toEmail: string;
      subject: string;
      bodyMarkdown: string | null;
      status: string;
      metadataJson: unknown;
      scheduledFor: Date;
      deliveredAt: Date | null;
      failedAt: Date | null;
      abandonedAt: Date | null;
      createdAt: Date;
    };
    const rows = await controlDb.$queryRaw<Row[]>`
      SELECT "id",
             "kind"::text        AS "kind",
             "toEmail"::text     AS "toEmail",
             "subject",
             "bodyMarkdown",
             "status"::text      AS "status",
             "metadataJson",
             "scheduledFor", "deliveredAt", "failedAt", "abandonedAt", "createdAt"
        FROM "email_outbox"
       WHERE "tenantId" = ${tenant.id}
         AND (
              (${email}::citext IS NOT NULL AND "toEmail" = ${email}::citext)
           OR ("metadataJson"->>'loanId'        = ANY(${loans}::text[]))
           OR ("metadataJson"->>'reservationId' = ANY(${reservations}::text[]))
         )
       ORDER BY "createdAt" DESC
       LIMIT ${SECTION_LIMIT + 1}`;

    const mine = rows.filter((r) => noticeIsAboutSubject(r.metadataJson, loanIds, reservationIds));
    const page = mine.slice(0, SECTION_LIMIT);
    return {
      truncated: mine.length > SECTION_LIMIT,
      items: page.map((r) => ({
        id: r.id,
        kind: r.kind,
        toEmail: r.toEmail,
        subject: r.subject,
        body: r.bodyMarkdown,
        status: r.status,
        scheduledFor: r.scheduledFor,
        deliveredAt: r.deliveredAt,
        failedAt: r.failedAt,
        abandonedAt: r.abandonedAt,
        createdAt: r.createdAt,
      })),
    };
  }

  /**
   * The member's photo, inlined. A face is the most identifying thing the
   * system holds about anybody, so a bundle that named a file on a volume the
   * member cannot reach would not be "a copy of the personal data".
   *
   * A storage failure degrades to a reference plus a reason and never fails the
   * request: the rest of the answer is still owed within a month, and losing it
   * because one file could not be read would be the wrong trade.
   */
  private async photoFor(
    tenant: TenantContext,
    ref: string | null,
  ): Promise<Record<string, unknown> | null> {
    if (!ref) return null;
    if (ref.startsWith('photos/placeholder')) {
      return { ref, dataBase64: null, omitted: 'placeholder' };
    }
    try {
      const stat = await this.storage.stat(tenant, ref);
      if (stat.sizeBytes > PHOTO_INLINE_LIMIT_BYTES) {
        return { ref, sizeBytes: stat.sizeBytes, dataBase64: null, omitted: 'too_large' };
      }
      const data = await this.storage.get(tenant, ref);
      return {
        ref,
        sizeBytes: data.byteLength,
        contentType: stat.contentType ?? null,
        dataBase64: data.toString('base64'),
      };
    } catch (err) {
      this.logger.warn(`subject-access: could not read photo ${ref}: ${(err as Error).message}`);
      return { ref, dataBase64: null, omitted: 'unreadable' };
    }
  }
}

/**
 * What this file deliberately does NOT contain. Stated in the bundle itself
 * because an Art. 15 answer that quietly omits things is worse than one that
 * names its own edges — and because the first question a DPO asks of any
 * subject-access export is "and what else is there?".
 */
const NOT_COVERED = [
  'Encrypted backups. Copies of this data age out on the backup rotation and are not searchable per member.',
  'Anything the library holds outside Libriant — paper cards, spreadsheets, its own e-mail.',
  'Records in custom collections the library defined itself: those rows carry no link to a member, so nothing can attribute them automatically.',
  'Activity-log entries that name this person only inside another record’s free text. Every section except the notice history is matched on an identifier rather than by searching for a name or an address, so that one member’s answer cannot contain another member’s row; the notice history has no member id to match on and is filtered instead (see below).',
  'Notices sent to an address this member no longer uses, unless the notice itself names one of their loans or reservations — and notices addressed to a shared mailbox that belong to a different member, which are dropped on purpose.',
  'Libriant control-plane accounts. Those describe library STAFF, not members.',
];

/**
 * Instructions for the human who is about to hand this file to somebody, in
 * both languages the product ships. Greek first: the librarian reading it works
 * in a Greek public or school library.
 *
 * This is the age-aware half of privacy-legal-12. It does not gate anything —
 * see `subject-access-bundle.ts` for why the flag is advisory — but the moment
 * of maximum harm for a child's data in this product is an adult at the desk
 * being handed their whole record, and that moment now says so.
 */
function handlingNotice(minor: MinorAssessment): Record<string, unknown> {
  const el = [
    'Το αρχείο αυτό απαντά σε αίτημα πρόσβασης (άρθρο 15) ή φορητότητας (άρθρο 20) ΓΚΠΔ. Επιβεβαιώστε ποιος δικαιούται να το παραλάβει πριν το παραδώσετε.',
    'Τα πεδία ελεύθερου κειμένου (σημειώσεις προσωπικού, σημειώσεις δανεισμού, αιτιολογία προστίμου, στιγμιότυπα δραστηριότητας) ενδέχεται να κατονομάζουν τρίτους. Ελέγξτε τα: το άρθρο 15 παρ. 4 ορίζει ότι το αντίγραφο δεν θίγει τα δικαιώματα άλλων.',
  ];
  const en = [
    'This file answers a GDPR access (Art. 15) or portability (Art. 20) request. Confirm who is entitled to receive it before handing it over.',
    'Free-text fields (staff notes, loan notes, fine reasons, activity snapshots) may name other people. Review them: Art. 15(4) says the copy must not adversely affect the rights of others.',
  ];
  if (minor.isMinor === true) {
    el.push(
      `Σύμφωνα με την ημερομηνία γέννησης στο μητρώο, το πρόσωπο είναι ${minor.ageYears} ετών, δηλαδή ανήλικο. Το δικαίωμα ασκείται συνήθως από τον ασκούντα τη γονική μέριμνα — επιβεβαιώστε την ιδιότητα του αιτούντος.`,
    );
    en.push(
      `The date of birth on file makes this person ${minor.ageYears}, a minor. The right is normally exercised by the holder of parental responsibility — verify who is asking.`,
    );
  } else if (minor.presumedChild) {
    el.push(
      'Η βιβλιοθήκη είναι σχολική και δεν υπάρχει καταχωρημένη ημερομηνία γέννησης. Αντιμετωπίστε το πρόσωπο ως ανήλικο μαθητή εκτός αν γνωρίζετε το αντίθετο.',
    );
    en.push(
      'This is a school library and no date of birth is on file. Treat the subject as a pupil, and therefore a child, unless you know otherwise.',
    );
  }
  return { el, en };
}
