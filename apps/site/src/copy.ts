/**
 * Page chrome, in both languages.
 *
 * The home page's hero, feature cards and closing CTA come from the app's own
 * `locales/{el,en}/landing.json`, so the site and the product say the same
 * thing. Everything the site adds around them — the offer panel, the three
 * steps, the trust list, the application form, the thank-you and 404 pages —
 * lives here.
 *
 * Content pages are authored as data in `content/pages.{el,en}.json` instead;
 * this file is only for strings the templates need.
 */

import type { Lang } from './shell.js';

export type LibraryTypeOption = { value: string; label: string };

/**
 * Values are the `LibraryType` enum from the product — they are written to the
 * database and must not change. Only the labels differ per language, and the
 * Greek ones name the kinds of library that actually exist in Greece, so a
 * δημοτική librarian finds a row they recognise.
 */
export const LIBRARY_TYPE_OPTIONS: Record<Lang, ReadonlyArray<LibraryTypeOption>> = {
  el: [
    { value: 'public', label: 'Δημόσια ή δημοτική βιβλιοθήκη' },
    { value: 'academic', label: 'Ακαδημαϊκή βιβλιοθήκη (ΑΕΙ ή ερευνητικού φορέα)' },
    { value: 'school', label: 'Σχολική βιβλιοθήκη' },
    { value: 'special', label: 'Ειδική βιβλιοθήκη (φορέα, ιδρύματος, συλλόγου)' },
    { value: 'community', label: 'Κοινοτική ή λαϊκή βιβλιοθήκη' },
    { value: 'other', label: 'Άλλο' },
  ],
  en: [
    { value: 'public', label: 'Public or municipal library' },
    { value: 'academic', label: 'Academic library (university or research body)' },
    { value: 'school', label: 'School library' },
    { value: 'special', label: 'Special library (organisation, foundation, society)' },
    { value: 'community', label: 'Community library' },
    { value: 'other', label: 'Other' },
  ],
};

type HomeCopy = {
  metaTitle: string;
  metaDescription: (spots: number) => string;
  heroEyebrow: string;
  heroCtaOpen: (spots: number) => string;
  heroCtaClosed: string;
  heroSecondary: string;
  heroNoteOpen: (spots: number) => string;
  heroNoteClosed: string;
  offerBadge: string;
  offerTitle: (spots: number) => string;
  offerLede: (spots: number, plan: string, months: number) => string;
  statSpots: (remaining: number, total: number) => string;
  statMonths: (months: number) => string;
  statMonthsLabel: string;
  statFree: string;
  statFreeLabel: string;
  statFrom: (price: string) => string;
  statFromLabel: string;
  capsIntro: (plan: string) => string;
  offerFine: (months: number, entry: string, plan: string, planned: string) => string;
  featuresFallback: string;
  howTitle: string;
  howSubtitle: string;
  steps: ReadonlyArray<{ title: string; body: string }>;
  trustTitle: string;
  trustSubtitle: string;
  trust: ReadonlyArray<{ title: string; body: string }>;
  applyTitle: string;
  applySubtitle: string;
  waitlistTitle: string;
  waitlistSubtitle: string;
};

export const HOME: Record<Lang, HomeCopy> = {
  el: {
    metaTitle: 'Libriant — Διαχείριση βιβλιοθήκης, απλά',
    metaDescription: (s) =>
      `Πλήρες σύστημα διαχείρισης βιβλιοθήκης στα ελληνικά — κατάλογος, μέλη, δανεισμοί, κρατήσεις. Ο πρώτος χρόνος δωρεάν για τις ${s} πρώτες βιβλιοθήκες.`,
    heroEyebrow: 'Διαχείριση βιβλιοθήκης, απλά',
    heroCtaOpen: (s) => `Κρατήστε μία από τις ${s} θέσεις`,
    heroCtaClosed: 'Λίστα αναμονής',
    heroSecondary: 'Δείτε τι κάνει',
    heroNoteOpen: (s) =>
      `Ο πρώτος χρόνος δωρεάν για τις ${s} πρώτες βιβλιοθήκες. Χωρίς κάρτα, χωρίς δέσμευση.`,
    heroNoteClosed: 'Οι θέσεις του πρώτου κύκλου συμπληρώθηκαν.',
    offerBadge: 'Προσφορά έναρξης',
    offerTitle: (s) => `Ο πρώτος χρόνος δωρεάν για τις ${s} πρώτες βιβλιοθήκες`,
    offerLede: (s, plan, m) =>
      `Το Libriant είναι ολοκληρωμένο και έτοιμο. Για την έναρξή του, οι ${s} πρώτες βιβλιοθήκες παίρνουν ολόκληρο το πακέτο ${plan} για ${m} μήνες, χωρίς χρέωση.`,
    statSpots: (r, t) => `θέσεις διαθέσιμες${r !== t ? ` από ${t}` : ''}`,
    statMonths: (m) => `${m} μήνες`,
    statMonthsLabel: 'πλήρους πρόσβασης',
    statFree: 'Δωρεάν',
    statFreeLabel: 'για ολόκληρο τον πρώτο χρόνο',
    statFrom: (p) => `από ${p}`,
    statFromLabel: 'τον μήνα, μετά τον πρώτο χρόνο',
    capsIntro: (plan) => `Τι περιλαμβάνει το πακέτο ${plan}:`,
    offerFine: (m, entry, plan, planned) =>
      `Χωρίς πιστωτική κάρτα και χωρίς αυτόματη ανανέωση. Μετά τους ${m} μήνες επιλέγετε το πακέτο που ταιριάζει στο μέγεθος της βιβλιοθήκης σας — τα πακέτα ξεκινούν από <strong>${entry} τον μήνα</strong>, ενώ το ${plan}, που παίρνετε δωρεάν τώρα, κοστίζει ${planned}. Οι ιδρυτικές βιβλιοθήκες κρατούν μόνιμη έκπτωση — και για μικρές συλλογές (έως 5.000 τίτλους) υπάρχει δωρεάν πακέτο.`,
    featuresFallback: 'Ό,τι χρειάζεται η βιβλιοθήκη σας',
    howTitle: 'Πώς δουλεύει',
    howSubtitle: 'Τρία βήματα, και το βαρύ κομμάτι το αναλαμβάνουμε εμείς.',
    steps: [
      {
        title: 'Στέλνετε την αίτηση',
        body: 'Δύο λεπτά, χωρίς δεσμεύσεις. Απαντάμε σε κάθε αίτηση εντός δύο εργάσιμων ημερών.',
      },
      {
        title: 'Μεταφέρουμε τον κατάλογό σας',
        body: 'Μας στέλνετε ό,τι έχετε — CSV, Excel, MARC, ακόμη και ένα ακατάστατο υπολογιστικό φύλλο. Την εισαγωγή την αναλαμβάνουμε εμείς.',
      },
      {
        title: 'Δουλεύετε κανονικά',
        body: 'Η βιβλιοθήκη σας είναι έτοιμη από την πρώτη μέρα, με το προσωπικό σας εκπαιδευμένο και τον κατάλογο στη θέση του.',
      },
    ],
    trustTitle: 'Τι μπορείτε να επαληθεύσετε πριν αποφασίσετε',
    trustSubtitle: 'Ό,τι λέμε εδώ μπορείτε να το ελέγξετε.',
    trust: [
      {
        title: 'Τα δεδομένα σας είναι δικά σας.',
        body: 'Εξαγωγή ολόκληρου του καταλόγου με ένα κλικ, όποτε θέλετε, χωρίς να μας ρωτήσετε.',
      },
      {
        title: 'Καμία αυτόματη χρέωση.',
        body: 'Δεν καταχωρίζετε κάρτα, άρα δεν υπάρχει τίποτα να χρεωθεί στο τέλος του χρόνου.',
      },
      {
        title: 'Ελληνικά και αγγλικά εξαρχής.',
        body: 'Όχι μετάφραση που προστέθηκε μετά — και οι δύο γλώσσες είναι ισότιμες σε κάθε οθόνη.',
      },
      {
        title: 'Δεδομένα στην Ευρωπαϊκή Ένωση.',
        body: 'Καθημερινά αντίγραφα ασφαλείας και σχεδιασμός σύμφωνος με τον ΓΚΠΔ, με Σύμβαση Επεξεργασίας Δεδομένων πριν καταχωρίσετε το πρώτο μέλος.',
      },
      {
        title: 'Χωρίς παρακολούθηση.',
        body: 'Ούτε αναλυτικά στοιχεία ούτε cookies παρακολούθησης — γι’ αυτό δεν είδατε παράθυρο συγκατάθεσης.',
      },
      {
        title: 'Ελεγμένο πριν διατεθεί.',
        body: 'Πλήρης έλεγχος ασφαλείας πριν από τη διάθεση, και αυτοματοποιημένες δοκιμές σε κάθε αλλαγή του κώδικα.',
      },
    ],
    applyTitle: 'Κάντε αίτηση',
    applySubtitle:
      'Συμπληρώστε τα στοιχεία της βιβλιοθήκης σας και επικοινωνούμε μαζί σας μέσα σε δύο εργάσιμες ημέρες.',
    waitlistTitle: 'Λίστα αναμονής',
    waitlistSubtitle: 'Ο πρώτος κύκλος έκλεισε.',
  },
  en: {
    metaTitle: 'Libriant — Library management, made simple',
    metaDescription: (s) =>
      `A complete library management system in Greek and English — catalogue, members, loans, holds. The first year free for the first ${s} libraries.`,
    heroEyebrow: 'Library management, made simple',
    heroCtaOpen: (s) => `Claim one of the ${s} places`,
    heroCtaClosed: 'Join the waiting list',
    heroSecondary: 'See what it does',
    heroNoteOpen: (s) =>
      `The first year free for the first ${s} libraries. No card, no commitment.`,
    heroNoteClosed: 'The first round of places has been filled.',
    offerBadge: 'Launch offer',
    offerTitle: (s) => `The first year free, for the first ${s} libraries`,
    offerLede: (s, plan, m) =>
      `Libriant is finished and ready. To launch it, the first ${s} libraries get the whole ${plan} plan for ${m} months at no charge.`,
    statSpots: (r, t) => `places available${r !== t ? ` of ${t}` : ''}`,
    statMonths: (m) => `${m} months`,
    statMonthsLabel: 'of full access',
    statFree: 'Free',
    statFreeLabel: 'for the whole first year',
    statFrom: (p) => `from ${p}`,
    statFromLabel: 'a month, after the first year',
    capsIntro: (plan) => `What the ${plan} plan includes:`,
    offerFine: (m, entry, plan, planned) =>
      `No credit card and no automatic renewal. After ${m} months you choose the plan that fits your library — plans start at <strong>${entry} a month</strong>, while ${plan}, which you get free now, costs ${planned}. Founding libraries keep a permanent discount — and for smaller collections (up to 5,000 titles) there is a free plan.`,
    featuresFallback: 'Everything your library needs',
    howTitle: 'How it works',
    howSubtitle: 'Three steps, and we take on the heavy part.',
    steps: [
      {
        title: 'You send the application',
        body: 'Two minutes, no commitment. We answer every application within two working days.',
      },
      {
        title: 'We move your catalogue',
        body: 'Send us whatever you have — CSV, Excel, MARC, even an untidy spreadsheet. We handle the import.',
      },
      {
        title: 'You get on with your work',
        body: 'Your library is ready from day one, with your staff shown how it works and your catalogue in place.',
      },
    ],
    trustTitle: 'What you can verify before you decide',
    trustSubtitle: 'Everything we say here, you can check.',
    trust: [
      {
        title: 'Your data is yours.',
        body: 'Export the whole catalogue in one click, whenever you like, without asking us.',
      },
      {
        title: 'No automatic charge.',
        body: 'You never enter a card, so there is nothing to be charged at the end of the year.',
      },
      {
        title: 'Greek and English from the start.',
        body: 'Not a translation added afterwards — both languages are equal on every screen.',
      },
      {
        title: 'Data in the European Union.',
        body: 'Daily backups and a GDPR-shaped design, with a Data Processing Agreement signed before you register your first member.',
      },
      {
        title: 'No tracking.',
        body: 'No analytics and no tracking cookies — which is why you saw no consent banner.',
      },
      {
        title: 'Audited before release.',
        body: 'A full security audit before release, and automated tests on every change to the code.',
      },
    ],
    applyTitle: 'Apply',
    applySubtitle: 'Tell us about your library and we will be in touch within two working days.',
    waitlistTitle: 'Waiting list',
    waitlistSubtitle: 'The first round has closed.',
  },
};

type FormCopy = {
  errorTitle: string;
  libraryName: string;
  libraryType: string;
  choose: string;
  city: string;
  collectionSize: string;
  collectionSizeHint: string;
  contactName: string;
  contactEmail: string;
  phone: string;
  optional: string;
  currentSystem: string;
  currentSystemHint: string;
  message: string;
  messageHint: string;
  honeypot: string;
  consentBefore: string;
  consentLink: string;
  consentAfter: string;
  submit: string;
  replyPromise: string;
  closedTitle: (spots: number) => string;
  closedBody: string;
  closedContact: (email: string) => string;
};

export const FORM: Record<Lang, FormCopy> = {
  el: {
    errorTitle: 'Η αίτηση δεν στάλθηκε.',
    libraryName: 'Όνομα βιβλιοθήκης',
    libraryType: 'Τύπος βιβλιοθήκης',
    choose: 'Επιλέξτε…',
    city: 'Πόλη / δήμος',
    collectionSize: 'Περίπου πόσοι τίτλοι;',
    collectionSizeHint: 'Μια χονδρική εκτίμηση αρκεί.',
    contactName: 'Το όνομά σας',
    contactEmail: 'Email επικοινωνίας',
    phone: 'Τηλέφωνο',
    optional: 'Προαιρετικό.',
    currentSystem: 'Τι χρησιμοποιείτε σήμερα;',
    currentSystemHint: 'π.χ. ΑΒΕΚΤ, Koha, φύλλο Excel, χειρόγραφο αρχείο — ή τίποτα ακόμη.',
    message: 'Θέλετε να μας πείτε κάτι άλλο;',
    messageHint: 'Προαιρετικό — τι σας δυσκολεύει σήμερα, τι θα θέλατε να λύσει το Libriant.',
    honeypot: 'Μη συμπληρώσετε αυτό το πεδίο',
    consentBefore: 'Διάβασα την ',
    consentLink: 'Πολιτική Απορρήτου',
    consentAfter:
      ' και κατανοώ ότι θα χρησιμοποιήσετε τα παραπάνω στοιχεία <strong>μόνο</strong> για να απαντήσετε στην αίτησή μου.',
    submit: 'Στείλτε την αίτηση',
    replyPromise: 'Απαντάμε σε κάθε αίτηση εντός δύο εργάσιμων ημερών.',
    closedTitle: (s) => `Οι ${s} θέσεις συμπληρώθηκαν`,
    closedBody:
      'Η προσφορά έναρξης ολοκληρώθηκε. Το Libriant παραμένει διαθέσιμο — επικοινωνήστε μαζί μας για τα τρέχοντα πακέτα.',
    closedContact: (e) =>
      `Για την επόμενη προσφορά ή για μια προσφορά στα μέτρα σας, στείλτε μας ένα email στο <a href="mailto:${e}">${e}</a> με το όνομα και την πόλη της βιβλιοθήκης σας. Θα σας ειδοποιήσουμε πρώτους.`,
  },
  en: {
    errorTitle: 'The application was not sent.',
    libraryName: 'Library name',
    libraryType: 'Type of library',
    choose: 'Choose…',
    city: 'Town or municipality',
    collectionSize: 'Roughly how many titles?',
    collectionSizeHint: 'A rough estimate is enough.',
    contactName: 'Your name',
    contactEmail: 'Contact email',
    phone: 'Phone',
    optional: 'Optional.',
    currentSystem: 'What do you use today?',
    currentSystemHint: 'e.g. ABEKT, Koha, an Excel sheet, a paper register — or nothing yet.',
    message: 'Anything else you would like to tell us?',
    messageHint: 'Optional — what is difficult today, and what you would like Libriant to solve.',
    honeypot: 'Do not fill in this field',
    consentBefore: 'I have read the ',
    consentLink: 'Privacy Policy',
    consentAfter:
      ' and understand that you will use the details above <strong>only</strong> to answer my application.',
    submit: 'Send the application',
    replyPromise: 'We answer every application within two working days.',
    closedTitle: (s) => `All ${s} places are taken`,
    closedBody:
      'The launch offer has closed. Libriant is still available — get in touch about the current plans.',
    closedContact: (e) =>
      `For the next offer, or for something suited to your library, email us at <a href="mailto:${e}">${e}</a> with your library's name and town. We will let you know first.`,
  },
};

type ThanksCopy = {
  title: string;
  metaDescription: string;
  h1: string;
  received: string;
  nextTitle: string;
  steps: ReadonlyArray<string>;
  spam: (email: string) => string;
  meanwhileTitle: string;
  meanwhile: string;
  changedTitle: string;
  changed: (email: string) => string;
  back: string;
};

export const THANKS: Record<Lang, ThanksCopy> = {
  el: {
    title: 'Η αίτησή σας στάλθηκε — Libriant',
    metaDescription: 'Λάβαμε το αίτημά σας. Επικοινωνούμε μαζί σας μέσα σε δύο εργάσιμες ημέρες.',
    h1: 'Η αίτησή σας στάλθηκε',
    received: 'Ευχαριστούμε — τη λάβαμε.',
    nextTitle: 'Τι γίνεται τώρα',
    steps: [
      '<strong>Μέσα σε δύο εργάσιμες ημέρες</strong> θα λάβετε απάντηση, θετική ή αρνητική. Δεν αφήνουμε καμία αίτηση αναπάντητη.',
      '<strong>Αν υπάρχει διαθέσιμη θέση</strong>, θα κανονίσουμε μια σύντομη συζήτηση για να δούμε τι έχετε σήμερα και πώς θα το μεταφέρουμε.',
      '<strong>Τη μεταφορά του καταλόγου την κάνουμε εμείς.</strong> Εσείς μας στέλνετε το αρχείο σας όπως το έχετε.',
    ],
    spam: (e) =>
      `Αν δεν λάβετε τίποτα μέσα σε τρεις ημέρες, ελέγξτε τον φάκελο ανεπιθύμητης αλληλογραφίας και μετά γράψτε μας απευθείας στο <a href="mailto:${e}">${e}</a>.`,
    meanwhileTitle: 'Στο μεταξύ',
    meanwhile:
      'Όσο περιμένετε, δείτε <a href="/features">τι κάνει το Libriant</a> — και, αν έχετε ήδη κατάλογο σε αρχείο, <a href="/migration">πώς γίνεται η μετάπτωση</a>. Αν προκύψει ερώτηση, <a href="/contact">γράψτε μας</a>.',
    changedTitle: 'Αλλάξατε γνώμη;',
    changed: (e) =>
      `Στείλτε ένα email στο <a href="mailto:${e}">${e}</a> και διαγράφουμε την αίτησή σας. Δεν χρειάζεται να εξηγήσετε τίποτα, και δεν θα σας ξαναγράψουμε.`,
    back: '← Επιστροφή στην αρχική',
  },
  en: {
    title: 'Your application has been sent — Libriant',
    metaDescription: 'We have your application. We will be in touch within two working days.',
    h1: 'Your application has been sent',
    received: 'Thank you — we have it.',
    nextTitle: 'What happens now',
    steps: [
      '<strong>Within two working days</strong> you will get an answer, yes or no. We leave no application unanswered.',
      '<strong>If a place is available</strong>, we will arrange a short conversation to see what you have today and how we move it across.',
      '<strong>We do the catalogue migration.</strong> You send us your file exactly as it is.',
    ],
    spam: (e) =>
      `If nothing arrives within three days, check your spam folder and then write to us directly at <a href="mailto:${e}">${e}</a>.`,
    meanwhileTitle: 'In the meantime',
    meanwhile:
      'While you wait, see <a href="/en/features">what Libriant does</a> — and, if you already have a catalogue in a file, <a href="/en/migration">how migration works</a>. If a question comes up, <a href="/en/contact">write to us</a>.',
    changedTitle: 'Changed your mind?',
    changed: (e) =>
      `Email <a href="mailto:${e}">${e}</a> and we will delete your application. You do not need to explain, and we will not write to you again.`,
    back: '← Back to the home page',
  },
};

export const NOT_FOUND: Record<Lang, { title: string; h1: string; lede: string; apply: string }> = {
  el: {
    title: 'Η σελίδα δεν βρέθηκε — Libriant',
    h1: 'Η σελίδα δεν βρέθηκε',
    lede: 'Ο σύνδεσμος που ακολουθήσατε δεν οδηγεί πουθενά. Δοκιμάστε από την <a href="/">αρχική σελίδα</a>, ή πηγαίνετε κατευθείαν σε ό,τι ψάχνατε:',
    apply: 'Φόρμα αίτησης',
  },
  en: {
    title: 'Page not found — Libriant',
    h1: 'Page not found',
    lede: 'The link you followed does not lead anywhere. Try the <a href="/en/">home page</a>, or go straight to what you were looking for:',
    apply: 'Application form',
  },
};

/** Enum values, identical in both languages — validation must not depend on locale. */
export const LIBRARY_TYPE_VALUES: ReadonlySet<string> = new Set(
  LIBRARY_TYPE_OPTIONS.el.map((o) => o.value),
);

type ErrorCopy = {
  required: Record<string, string>;
  tooLong: (max: number) => string;
  badEmail: string;
  badType: string;
  consent: string;
  invalidSubmission: string;
  checkFields: string;
  rateLimited: string;
  saveFailed: (email: string) => string;
};

/** Validation messages, in the language the visitor submitted from. */
export const ERRORS: Record<Lang, ErrorCopy> = {
  el: {
    required: {
      libraryName: 'Συμπληρώστε το όνομα της βιβλιοθήκης.',
      libraryType: 'Επιλέξτε τύπο βιβλιοθήκης.',
      city: 'Συμπληρώστε την πόλη ή τον δήμο.',
      contactName: 'Συμπληρώστε το όνομά σας.',
      contactEmail: 'Συμπληρώστε ένα email επικοινωνίας.',
    },
    tooLong: (max) => `Το πεδίο είναι πολύ μεγάλο (έως ${max} χαρακτήρες).`,
    badEmail: 'Το email δεν φαίνεται σωστό. Ελέγξτε το και δοκιμάστε ξανά.',
    badType: 'Επιλέξτε έναν από τους διαθέσιμους τύπους.',
    consent: 'Επιβεβαιώστε ότι διαβάσατε την Πολιτική Απορρήτου.',
    invalidSubmission: 'Μη έγκυρη υποβολή.',
    checkFields: 'Ελέγξτε τα πεδία που σημειώνονται παρακάτω και δοκιμάστε ξανά.',
    rateLimited:
      'Λάβαμε ήδη αρκετές υποβολές από εσάς. Δοκιμάστε ξανά σε μία ώρα, ή γράψτε μας απευθείας.',
    saveFailed: (e) =>
      `Δεν καταφέραμε να αποθηκεύσουμε την αίτησή σας. Δοκιμάστε ξανά σε λίγο, ή στείλτε μας email στο ${e}.`,
  },
  en: {
    required: {
      libraryName: 'Enter the name of your library.',
      libraryType: 'Choose a type of library.',
      city: 'Enter your town or municipality.',
      contactName: 'Enter your name.',
      contactEmail: 'Enter a contact email address.',
    },
    tooLong: (max) => `This field is too long (up to ${max} characters).`,
    badEmail: 'That email address does not look right. Check it and try again.',
    badType: 'Choose one of the available types.',
    consent: 'Please confirm that you have read the Privacy Policy.',
    invalidSubmission: 'That submission was not valid.',
    checkFields: 'Check the fields marked below and try again.',
    rateLimited:
      'We have already had several submissions from you. Try again in an hour, or write to us directly.',
    saveFailed: (e) =>
      `We could not save your application. Try again shortly, or email us at ${e}.`,
  },
};
