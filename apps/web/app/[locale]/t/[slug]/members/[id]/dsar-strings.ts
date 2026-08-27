import type { Locale } from '@libriant/i18n';

/**
 * Strings for the subject-access control (privacy-legal-15).
 *
 * They belong in `locales/<locale>/members.json` with every other member
 * string, and the moment someone touches that namespace they should be lifted
 * into it verbatim and this file deleted. They are here because this change did
 * not own the shared catalogue files, and the alternative — shipping raw
 * `members.detail.*` keys, or an English-only button — is worse in a product
 * whose first customers read Greek. `pnpm check:translations` does not see this
 * table, so the two locales are kept in one object where a missing key is a
 * TypeScript error instead of a silent fallback.
 */
type Strings = {
  action: string;
  title: string;
  body: string;
  contains: string;
  review: string;
  minor: string;
  presumedChild: string;
  download: string;
  cancel: string;
};

const STRINGS: Record<Locale, Strings> = {
  el: {
    action: 'Εξαγωγή δεδομένων μέλους',
    title: 'Εξαγωγή των δεδομένων του μέλους {name}',
    body: 'Δημιουργεί ένα αρχείο JSON με όσα τηρεί η βιβλιοθήκη για το συγκεκριμένο μέλος — και μόνο γι’ αυτό. Απαντά σε αίτημα πρόσβασης (άρθρο 15) ή φορητότητας (άρθρο 20) ΓΚΠΔ.',
    contains:
      'Περιλαμβάνει: την καρτέλα μέλους, δανεισμούς, κρατήσεις, πρόστιμα, ειδοποιήσεις που στάλθηκαν, το ιστορικό ενεργειών και τη φωτογραφία.',
    review:
      'Ελέγξτε ποιος δικαιούται να το παραλάβει. Τα πεδία ελεύθερου κειμένου ενδέχεται να κατονομάζουν τρίτους.',
    minor:
      'Προσοχή: το μέλος είναι ανήλικο ({age} ετών). Το δικαίωμα ασκείται συνήθως από τον ασκούντα τη γονική μέριμνα.',
    presumedChild:
      'Προσοχή: σχολική βιβλιοθήκη χωρίς καταχωρημένη ημερομηνία γέννησης — αντιμετωπίστε το μέλος ως ανήλικο.',
    download: 'Λήψη αρχείου',
    cancel: 'Άκυρο',
  },
  en: {
    action: 'Export member’s data',
    title: 'Export {name}’s data',
    body: 'Produces a JSON file with everything the library holds about this one member, and nobody else. It answers a GDPR access (Art. 15) or portability (Art. 20) request.',
    contains:
      'Includes: the member record, loans, reservations, fines, notices sent, the activity history and the photo.',
    review: 'Check who is entitled to receive it. Free-text fields may name other people.',
    minor:
      'Careful: this member is a minor ({age}). The right is normally exercised by the holder of parental responsibility.',
    presumedChild:
      'Careful: school library with no date of birth on file — treat this member as a child.',
    download: 'Download file',
    cancel: 'Cancel',
  },
};

export function dsarStrings(locale: Locale): Strings {
  return STRINGS[locale] ?? STRINGS.en;
}

/**
 * Completed years, UTC — the same rule as `completedYears()` in
 * `apps/api/src/privacy/subject-access-bundle.ts`, which is the source of truth
 * and the one that ends up inside the produced file.
 *
 * Duplicated rather than imported because the API and the web app share only
 * `packages/shared`, which this change did not own. Eleven lines of arithmetic
 * with a test on each side is the lesser evil; if the two ever disagree the
 * visible symptom is a warning that differs from the bundle's own `minor`
 * block, which is exactly the discrepancy someone would notice and fix.
 */
export function ageInCompletedYears(dateOfBirth: string, now: Date): number | null {
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  let years = now.getUTCFullYear() - dob.getUTCFullYear();
  const months = now.getUTCMonth() - dob.getUTCMonth();
  if (months < 0 || (months === 0 && now.getUTCDate() < dob.getUTCDate())) years -= 1;
  return years;
}

/** Civil majority. Mirrors `AGE_OF_MAJORITY_YEARS` on the API side. */
export const AGE_OF_MAJORITY_YEARS = 18;
