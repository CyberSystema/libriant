import type { LibraryType } from '@libriant/db-control';

/**
 * The pure half of the subject-access bundle (privacy-legal-15): age
 * assessment, the shared-mailbox filter, and the download filename. Kept out of
 * the service so the decisions that can actually hurt someone are testable
 * without a database — see `subject-access-bundle.spec.ts`.
 */

/**
 * The age at which the person exercises the Article 15/20 right themselves
 * rather than through whoever holds parental responsibility.
 *
 * 18, civil majority — NOT the lower age Greece has set under Article 8(1) for
 * a child's own consent to an information-society service. That is a different
 * question (consent to processing) and this flag does not answer it; a school
 * asking "may this pupil consent?" must not read this number as the answer.
 */
export const AGE_OF_MAJORITY_YEARS = 18;

/**
 * Whether the data subject is a child, and on what evidence.
 *
 * privacy-legal-12. `dateOfBirth` has been a stored column since day one and
 * nothing in `apps/api/src` has ever read it as an age. This is the one place
 * that does, and it is deliberately narrow: it does not gate a notification, it
 * does not shorten a retention period, it does not block anything. It labels
 * the one act where getting it wrong discloses a child's home address, photo
 * and complete borrowing history to an adult standing at the desk who may have
 * no right to it.
 */
export type MinorAssessment = {
  /**
   * `null` — not `false` — when no date of birth is on file. A school library
   * that never fills the column would otherwise read "isMinor: false" over
   * every pupil in it, which is the worst possible way to be wrong here.
   */
  isMinor: boolean | null;
  ageYears: number | null;
  basis: 'date_of_birth' | 'no_date_of_birth';
  /**
   * The library's type is `school` and the record carries no date of birth, so
   * the safe assumption is that the subject is a pupil. Advisory: it changes
   * the wording of the handling notice, nothing else.
   */
  presumedChild: boolean;
};

/**
 * Completed years between two instants, in UTC.
 *
 * UTC, not the library's local time: `dateOfBirth` is a `@db.Date` column and
 * Prisma hands it back as UTC midnight, so mixing in a local calendar would
 * shift the birthday by the offset. The consequence is that on the birthday
 * itself the flag can lag by up to that offset — for a Greek library, a few
 * hours during which an 18-year-old is still reported as 17. That direction is
 * the harmless one: it asks the librarian for more care, not less.
 */
export function completedYears(dateOfBirth: Date, now: Date): number {
  let years = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const months = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (months < 0 || (months === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())) years -= 1;
  return years;
}

export function assessMinor(
  dateOfBirth: Date | null,
  libraryType: LibraryType | null,
  now: Date,
): MinorAssessment {
  if (!dateOfBirth || Number.isNaN(dateOfBirth.getTime())) {
    return {
      isMinor: null,
      ageYears: null,
      basis: 'no_date_of_birth',
      presumedChild: libraryType === 'school',
    };
  }
  const ageYears = completedYears(dateOfBirth, now);
  return {
    isMinor: ageYears < AGE_OF_MAJORITY_YEARS,
    ageYears,
    basis: 'date_of_birth',
    presumedChild: false,
  };
}

/**
 * Does this queued/sent notice belong to the person the bundle is about?
 *
 * The outbox has no member id — `toEmail` is the only handle, which is exactly
 * how `MembersService.erase()` finds the rows it purges. Erasure may safely
 * over-match: deleting one notice too many harms nobody. **Disclosure may
 * not.** The DPIA pack tells a school library that the way to route a pupil's
 * notices to a parent is to put the parent's address on the member record, so
 * one mailbox holding two siblings' overdue notices is not a corner case, it is
 * the documented workflow. Matching on the address alone would put the brother's
 * borrowing history into the sister's Article 15 answer.
 *
 * So a notice that names a loan or a reservation is kept only when that loan or
 * reservation is this member's. A notice that names neither cannot be
 * attributed either way and is kept: it was addressed to this member's own
 * recorded address, and dropping it would under-answer the request.
 */
export function noticeIsAboutSubject(
  metadata: unknown,
  subjectLoanIds: ReadonlySet<string>,
  subjectReservationIds: ReadonlySet<string>,
): boolean {
  if (typeof metadata !== 'object' || metadata === null) return true;
  const meta = metadata as Record<string, unknown>;
  const loanId = typeof meta.loanId === 'string' ? meta.loanId : null;
  if (loanId) return subjectLoanIds.has(loanId);
  const reservationId = typeof meta.reservationId === 'string' ? meta.reservationId : null;
  if (reservationId) return subjectReservationIds.has(reservationId);
  return true;
}

/**
 * Name of the file the browser saves. It ends up in the librarian's Downloads
 * folder next to whatever else they produced that week, so it carries the
 * library and the membership number rather than a cuid — and it carries NO
 * name, because a filename is the one part of this bundle that gets read aloud
 * over a shared screen.
 */
export function subjectAccessFilename(slug: string, memberNumber: string, now: Date): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const day = now.toISOString().slice(0, 10);
  return `libriant-${safe(slug) || 'library'}-${safe(memberNumber) || 'member'}-${day}.json`;
}
