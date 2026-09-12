/**
 * The canonical catalogue of importable fields per entity, plus the legacy
 * header + MARC-tag aliases that drive auto-mapping.
 *
 * `key` matches the corresponding entity service's `create()` input exactly,
 * so the engine can hand the mapped record straight through the same code the
 * manual UI uses. `kind` selects the transform the row mapper applies.
 *
 * Aliases are matched case-/punctuation-insensitively (see `normalizeHeader`
 * in auto-map.ts), so `"ISBN-13"`, `"isbn 13"` and `"isbn13"` all hit the same
 * field. MARC subfield aliases use the parser's `tag$code` column naming.
 */
import type { ImportEntityKind } from '@libriant/db-control';

export type ImportFieldKind =
  | 'text'
  | 'longtext'
  | 'int'
  | 'year'
  | 'money'
  | 'bool'
  | 'date'
  | 'datetime'
  | 'isbn13'
  | 'isbn10'
  | 'multi'
  | 'email'
  | 'enum';

export type ImportFieldDef = {
  /** Canonical target key — matches the entity service create() input. */
  key: string;
  label: string;
  kind: ImportFieldKind;
  required?: boolean;
  /** Participates in dedup (skip/upsert) + cross-entity reference resolution. */
  naturalKey?: boolean;
  enumValues?: readonly string[];
  /** Header / MARC-tag candidates for auto-mapping. */
  aliases: readonly string[];
  note?: string;
};

export type EntityReference = {
  /** Logical name surfaced to the engine + UI. */
  name: string;
  targetEntity: ImportEntityKind;
  /** Candidate field keys (priority order) that hold the foreign natural key. */
  byFields: readonly string[];
  required: boolean;
};

export type EntitySpec = {
  kind: ImportEntityKind;
  label: string;
  fields: readonly ImportFieldDef[];
  references?: readonly EntityReference[];
};

const AUTHOR: EntitySpec = {
  kind: 'author',
  label: 'Authors',
  fields: [
    {
      key: 'fullName',
      label: 'Full name',
      kind: 'text',
      required: true,
      naturalKey: true,
      aliases: [
        'author',
        'name',
        'full name',
        'author name',
        'creator',
        'συγγραφέας',
        'όνομα',
        '100$a',
        '700$a',
        '110$a',
      ],
    },
    {
      key: 'isOrganization',
      label: 'Is organization',
      kind: 'bool',
      aliases: ['organization', 'is organization', 'corporate', 'org'],
    },
    {
      key: 'birthYear',
      label: 'Birth year',
      kind: 'year',
      aliases: ['birth year', 'born', 'birthyear', 'year of birth'],
    },
    {
      key: 'deathYear',
      label: 'Death year',
      kind: 'year',
      aliases: ['death year', 'died', 'deathyear', 'year of death'],
    },
    {
      key: 'notes',
      label: 'Notes',
      kind: 'longtext',
      aliases: ['notes', 'note', 'biography', 'bio', 'σημειώσεις'],
    },
  ],
};

const BOOK: EntitySpec = {
  kind: 'book',
  label: 'Books (titles)',
  fields: [
    {
      key: 'title',
      label: 'Title',
      kind: 'text',
      required: true,
      naturalKey: true,
      aliases: [
        'title',
        'book title',
        'main title',
        'τίτλος',
        'titre',
        'titulo',
        '245$a',
        '245a',
        '24500a',
      ],
    },
    {
      key: 'subtitle',
      label: 'Subtitle',
      kind: 'text',
      aliases: ['subtitle', 'sub title', 'remainder of title', 'υπότιτλος', '245$b'],
    },
    {
      key: 'isbn13',
      label: 'ISBN-13',
      kind: 'isbn13',
      naturalKey: true,
      aliases: ['isbn', 'isbn13', 'isbn 13', 'isbn-13', 'ean', 'κωδικός isbn', '020$a', '020a'],
      note: 'A 10-digit ISBN here is auto-upgraded to 13.',
    },
    { key: 'isbn10', label: 'ISBN-10', kind: 'isbn10', aliases: ['isbn10', 'isbn 10', 'isbn-10'] },
    {
      key: 'publisher',
      label: 'Publisher',
      kind: 'text',
      aliases: ['publisher', 'imprint', 'εκδότης', 'εκδόσεις', '260$b', '264$b'],
    },
    {
      key: 'publicationYear',
      label: 'Publication year',
      kind: 'year',
      aliases: [
        'year',
        'publication year',
        'pub year',
        'published',
        'date',
        'copyright',
        'έτος',
        'χρονολογία',
        '260$c',
        '264$c',
        '008',
      ],
    },
    {
      key: 'language',
      label: 'Language',
      kind: 'text',
      aliases: ['language', 'lang', 'γλώσσα', '041$a', '008/35'],
    },
    { key: 'edition', label: 'Edition', kind: 'text', aliases: ['edition', 'έκδοση', '250$a'] },
    {
      key: 'numPages',
      label: 'Number of pages',
      kind: 'int',
      aliases: ['pages', 'page count', 'num pages', 'extent', 'σελίδες', '300$a'],
    },
    {
      key: 'description',
      label: 'Description',
      kind: 'longtext',
      aliases: ['description', 'summary', 'abstract', 'annotation', 'περιγραφή', 'σύνοψη', '520$a'],
    },
    {
      key: 'classification',
      label: 'Classification / shelf code',
      kind: 'text',
      aliases: [
        'classification',
        'call number',
        'callnumber',
        'dewey',
        'ddc',
        'shelfmark',
        'ταξινόμηση',
        'ταξινομικός αριθμός',
        '082$a',
        '050$a',
        '084$a',
      ],
    },
    {
      key: 'authors',
      label: 'Author(s)',
      kind: 'multi',
      aliases: [
        'author',
        'authors',
        'author(s)',
        'creator',
        'by',
        'συγγραφέας',
        'συγγραφείς',
        '100$a',
        '700$a',
      ],
      note: 'Multiple authors separated by ; or |. Matched/created by name.',
    },
  ],
};

const BOOK_COPY: EntitySpec = {
  kind: 'book_copy',
  label: 'Copies (items)',
  fields: [
    {
      key: 'barcode',
      label: 'Barcode',
      kind: 'text',
      required: true,
      naturalKey: true,
      aliases: [
        'barcode',
        'item barcode',
        'copy barcode',
        'accession number',
        'accession',
        'item id',
        'γραμμωτός κώδικας',
        'αριθμός εισαγωγής',
        '852$p',
        '876$p',
      ],
    },
    {
      key: 'status',
      label: 'Status',
      kind: 'enum',
      enumValues: ['available', 'on_loan', 'reserved', 'lost', 'damaged', 'withdrawn'],
      aliases: ['status', 'item status', 'copy status', 'κατάσταση'],
      note: 'Defaults to "available" when blank/unknown.',
    },
    {
      key: 'shelfLocation',
      label: 'Shelf location',
      kind: 'text',
      aliases: [
        'shelf',
        'shelf location',
        'location',
        'collection',
        'sublocation',
        'θέση',
        'ράφι',
        '852$c',
        '852$h',
      ],
    },
    {
      key: 'conditionNotes',
      label: 'Condition notes',
      kind: 'longtext',
      aliases: ['condition', 'condition notes', 'item notes', 'κατάσταση αντιτύπου'],
    },
    {
      key: 'acquiredAt',
      label: 'Acquired date',
      kind: 'date',
      aliases: [
        'acquired',
        'acquired date',
        'date acquired',
        'acquisition date',
        'ημερομηνία απόκτησης',
      ],
    },
    {
      key: 'priceCents',
      label: 'Price',
      kind: 'money',
      aliases: ['price', 'cost', 'value', 'replacement price', 'τιμή', 'κόστος'],
    },
  ],
  references: [
    {
      name: 'book',
      targetEntity: 'book',
      byFields: ['bookIsbn13', 'bookTitle'],
      required: true,
    },
  ],
};

// Pseudo-fields that exist only to carry a foreign natural key (resolved to a
// real reference at commit time, never written directly).
const BOOK_COPY_REF_FIELDS: ImportFieldDef[] = [
  {
    key: 'bookIsbn13',
    label: 'Book ISBN (to link the copy)',
    kind: 'isbn13',
    aliases: ['isbn', 'isbn13', 'book isbn', 'bib isbn', '020$a'],
  },
  {
    key: 'bookTitle',
    label: 'Book title (to link the copy)',
    kind: 'text',
    aliases: ['title', 'book title', 'τίτλος', '245$a'],
  },
];

const MEMBER: EntitySpec = {
  kind: 'member',
  label: 'Members (patrons)',
  fields: [
    {
      key: 'memberNumber',
      label: 'Member number',
      kind: 'text',
      naturalKey: true,
      aliases: [
        'member number',
        'membernumber',
        'card number',
        'cardnumber',
        'patron id',
        'patron barcode',
        'borrower number',
        'αριθμός μέλους',
        'αριθμός κάρτας',
      ],
      note: 'Auto-generated (M-YYYY-NNNN) when blank.',
    },
    {
      key: 'fullName',
      label: 'Full name',
      kind: 'text',
      required: true,
      aliases: ['name', 'full name', 'patron name', 'borrower', 'ονοματεπώνυμο', 'όνομα'],
    },
    {
      key: 'email',
      label: 'Email',
      kind: 'email',
      naturalKey: true,
      aliases: [
        'email',
        'e-mail',
        'mail',
        'email address',
        'ηλεκτρονικό ταχυδρομείο',
        'email μέλους',
      ],
    },
    {
      key: 'phone',
      label: 'Phone',
      kind: 'text',
      aliases: ['phone', 'telephone', 'tel', 'mobile', 'τηλέφωνο', 'κινητό'],
    },
    {
      key: 'dateOfBirth',
      label: 'Date of birth',
      kind: 'date',
      aliases: ['dob', 'date of birth', 'birth date', 'birthday', 'ημερομηνία γέννησης'],
    },
    {
      key: 'addressLine1',
      label: 'Address line 1',
      kind: 'text',
      aliases: ['address', 'address line 1', 'address1', 'street', 'διεύθυνση', 'οδός'],
    },
    {
      key: 'addressLine2',
      label: 'Address line 2',
      kind: 'text',
      aliases: ['address line 2', 'address2'],
    },
    { key: 'city', label: 'City', kind: 'text', aliases: ['city', 'town', 'πόλη'] },
    {
      key: 'postalCode',
      label: 'Postal code',
      kind: 'text',
      aliases: ['postal code', 'postcode', 'zip', 'zip code', 'τκ', 'ταχυδρομικός κώδικας'],
    },
    { key: 'country', label: 'Country', kind: 'text', aliases: ['country', 'χώρα'] },
    {
      key: 'status',
      label: 'Status',
      kind: 'enum',
      enumValues: ['active', 'suspended', 'archived'],
      aliases: ['status', 'member status', 'patron status', 'κατάσταση'],
    },
    {
      key: 'staffNotes',
      label: 'Staff notes',
      kind: 'longtext',
      aliases: ['notes', 'staff notes', 'comments', 'σημειώσεις'],
    },
    {
      key: 'joinedAt',
      label: 'Joined date',
      kind: 'date',
      aliases: [
        'joined',
        'join date',
        'registration date',
        'enrolled',
        'date joined',
        'ημερομηνία εγγραφής',
      ],
    },
  ],
};

const LOAN: EntitySpec = {
  kind: 'loan',
  label: 'Loans (checkouts)',
  fields: [
    {
      key: 'dueAt',
      label: 'Due date',
      kind: 'datetime',
      required: true,
      aliases: ['due', 'due date', 'date due', 'ημερομηνία επιστροφής', 'λήξη'],
    },
    {
      key: 'loanedAt',
      label: 'Checkout date',
      kind: 'datetime',
      aliases: [
        'issued',
        'checkout date',
        'loan date',
        'date issued',
        'borrowed',
        'ημερομηνία δανεισμού',
      ],
    },
    {
      key: 'returnedAt',
      label: 'Returned date',
      kind: 'datetime',
      aliases: ['returned', 'return date', 'date returned', 'ημερομηνία επιστροφής'],
    },
    {
      key: 'renewedCount',
      label: 'Renewals',
      kind: 'int',
      aliases: ['renewals', 'renewed', 'renewal count', 'times renewed', 'ανανεώσεις'],
    },
    {
      key: 'status',
      label: 'Status',
      kind: 'enum',
      enumValues: ['active', 'returned', 'lost'],
      aliases: ['status', 'loan status', 'κατάσταση'],
      note: 'Defaults to "active" (an open loan) when blank.',
    },
    {
      key: 'notes',
      label: 'Notes',
      kind: 'longtext',
      aliases: ['notes', 'comments', 'σημειώσεις'],
    },
  ],
  references: [
    {
      name: 'member',
      targetEntity: 'member',
      byFields: ['memberNumber', 'memberEmail'],
      required: true,
    },
    { name: 'copy', targetEntity: 'book_copy', byFields: ['copyBarcode'], required: true },
  ],
};

const LOAN_REF_FIELDS: ImportFieldDef[] = [
  {
    key: 'memberNumber',
    label: 'Member number (borrower)',
    kind: 'text',
    aliases: ['member number', 'card number', 'patron id', 'borrower number', 'αριθμός μέλους'],
  },
  {
    key: 'memberEmail',
    label: 'Member email (borrower)',
    kind: 'email',
    aliases: ['email', 'patron email', 'borrower email'],
  },
  {
    key: 'copyBarcode',
    label: 'Copy barcode (item)',
    kind: 'text',
    aliases: ['barcode', 'item barcode', 'item id', 'accession number', 'γραμμωτός κώδικας'],
  },
];

const RESERVATION: EntitySpec = {
  kind: 'reservation',
  label: 'Reservations (holds)',
  fields: [
    {
      key: 'placedAt',
      label: 'Placed date',
      kind: 'datetime',
      aliases: ['placed', 'hold date', 'reserved date', 'date placed', 'ημερομηνία κράτησης'],
    },
    {
      key: 'status',
      label: 'Status',
      kind: 'enum',
      enumValues: ['queued', 'ready', 'fulfilled', 'expired', 'canceled'],
      aliases: ['status', 'hold status', 'κατάσταση'],
      note: 'Defaults to "queued".',
    },
    {
      key: 'expiresAt',
      label: 'Expires date',
      kind: 'datetime',
      aliases: ['expires', 'expiry', 'expiration', 'λήξη'],
    },
    {
      key: 'notes',
      label: 'Notes',
      kind: 'longtext',
      aliases: ['notes', 'comments', 'σημειώσεις'],
    },
  ],
  references: [
    {
      name: 'member',
      targetEntity: 'member',
      byFields: ['memberNumber', 'memberEmail'],
      required: true,
    },
    { name: 'book', targetEntity: 'book', byFields: ['bookIsbn13', 'bookTitle'], required: true },
  ],
};

const RESERVATION_REF_FIELDS: ImportFieldDef[] = [
  {
    key: 'memberNumber',
    label: 'Member number',
    kind: 'text',
    aliases: ['member number', 'card number', 'patron id', 'αριθμός μέλους'],
  },
  { key: 'memberEmail', label: 'Member email', kind: 'email', aliases: ['email', 'patron email'] },
  { key: 'bookIsbn13', label: 'Book ISBN', kind: 'isbn13', aliases: ['isbn', 'isbn13', '020$a'] },
  {
    key: 'bookTitle',
    label: 'Book title',
    kind: 'text',
    aliases: ['title', 'book title', '245$a'],
  },
];

const FINE: EntitySpec = {
  kind: 'fine',
  label: 'Fines (charges)',
  fields: [
    {
      key: 'amountCents',
      label: 'Amount',
      kind: 'money',
      required: true,
      aliases: ['amount', 'fine', 'fine amount', 'charge', 'balance', 'ποσό', 'πρόστιμο'],
    },
    { key: 'currency', label: 'Currency', kind: 'text', aliases: ['currency', 'νόμισμα'] },
    {
      key: 'reason',
      label: 'Reason',
      kind: 'text',
      required: true,
      aliases: ['reason', 'description', 'type', 'fine reason', 'αιτία', 'περιγραφή'],
    },
    {
      key: 'status',
      label: 'Status',
      kind: 'enum',
      enumValues: ['outstanding', 'paid', 'waived'],
      aliases: ['status', 'fine status', 'κατάσταση'],
      note: 'Defaults to "outstanding".',
    },
    {
      key: 'chargedAt',
      label: 'Charge date',
      kind: 'datetime',
      aliases: [
        'charged',
        'charge date',
        'date charged',
        'created',
        'issued',
        'ημερομηνία χρέωσης',
      ],
      // 2.0 phase 20d. A 2.0 fee is ledger-backed, so the date a charge was
      // made is not decoration: the charge journal is posted at it, and without
      // a column the import stamps `now` and a library loading four years of
      // arrears sees its whole historical debt land in this month's revenue.
      // 1.0 had no such column and did not need one — its fines were bare rows.
      note: 'When the charge was made. Defaults to the settlement date, then to now.',
    },
    {
      key: 'paidAt',
      label: 'Paid date',
      kind: 'datetime',
      aliases: ['paid', 'paid date', 'date paid', 'ημερομηνία πληρωμής'],
    },
    {
      key: 'notes',
      label: 'Notes',
      kind: 'longtext',
      aliases: ['notes', 'comments', 'σημειώσεις'],
    },
  ],
  references: [
    {
      name: 'member',
      targetEntity: 'member',
      byFields: ['memberNumber', 'memberEmail'],
      required: true,
    },
  ],
};

const FINE_REF_FIELDS: ImportFieldDef[] = [
  {
    key: 'memberNumber',
    label: 'Member number',
    kind: 'text',
    aliases: ['member number', 'card number', 'patron id', 'αριθμός μέλους'],
  },
  { key: 'memberEmail', label: 'Member email', kind: 'email', aliases: ['email', 'patron email'] },
];

/** Reference/pseudo fields carried alongside an entity's own fields. */
const REFERENCE_FIELDS: Partial<Record<ImportEntityKind, ImportFieldDef[]>> = {
  book_copy: BOOK_COPY_REF_FIELDS,
  loan: LOAN_REF_FIELDS,
  reservation: RESERVATION_REF_FIELDS,
  fine: FINE_REF_FIELDS,
};

const SPECS: Record<ImportEntityKind, EntitySpec> = {
  author: AUTHOR,
  book: BOOK,
  book_copy: BOOK_COPY,
  member: MEMBER,
  loan: LOAN,
  reservation: RESERVATION,
  fine: FINE,
};

export function getEntitySpec(kind: ImportEntityKind): EntitySpec {
  return SPECS[kind];
}

/** Every mappable target field for an entity: own fields + reference fields. */
export function mappableFields(kind: ImportEntityKind): ImportFieldDef[] {
  return [...SPECS[kind].fields, ...(REFERENCE_FIELDS[kind] ?? [])];
}

export const IMPORT_ENTITY_KINDS: readonly ImportEntityKind[] = [
  'author',
  'book',
  'book_copy',
  'member',
  'loan',
  'reservation',
  'fine',
];
