import { stripNonfilingArticle } from '@libriant/shared/greek';

/**
 * The record shape, STRUCTURALLY, so this package needs no dependency on
 * `@libriant/marc` for a type.
 *
 * It is the same shape `MarcRecord` declares, and the orchestrator — which does
 * import the codec, because it calls `contentHash` and `projectBib` — passes
 * what this returns straight into it. TypeScript's structural typing makes the
 * two interchangeable, and `db-tenant` does not grow a package edge to name a
 * type it never constructs a value of at runtime.
 */
export type SynthesisedRecord = {
  readonly leader: string;
  readonly fields: readonly { t: string; v?: string; i?: string; s?: Record<string, string>[] }[];
};

/**
 * A 1.0 `books` row becomes a MARC 21 bibliographic record (2.0 phase 19b).
 *
 * ## Why this is TypeScript and not PL/pgSQL
 *
 * §6 specifies the copy-forward as PL/pgSQL and that is overridden here, for
 * three measured reasons rather than a preference:
 *
 *   1. `contentHash` is ASYNC and uses WebCrypto — `packages/marc` has no
 *      `node:` built-ins so it runs unchanged in a webview and in the Tauri
 *      core. It hashes CANONICAL NFC JSON, and Postgres has no NFC at all.
 *   2. `stripNonfilingArticle` decides 245 ind2, and it is 120 lines of Greek,
 *      English, French, German, Italian and Spanish article tables that measure
 *      the skip on the ORIGINAL string because folding collapses whitespace. A
 *      SQL twin would be a second implementation whose only job is to agree.
 *   3. `projectBib`'s anomaly WORDING is compared nightly by `catalog-verify`.
 *      A hand-built projection disagrees with whatever the real projector says,
 *      so every migrated record would report as drifted for ever, with
 *      `--repair` standing by to rewrite the catalogue.
 *
 * So the transformation runs through the REAL codec, on the same connection,
 * inside the same transaction. Atomicity is not lost: `pg` gives one BEGIN.
 *
 * ## The leader rules are the WRITE rules
 *
 * §5: on write, always emit /10='2', /11='2', /20-23='4500', recompute /00-04
 * and /12-16, and set /09 from the EXPORT encoding. A synthesised record is a
 * write, so it gets the write rules — not the permissive read ones. /09 is 'a'
 * because everything here is UTF-8; a record emitted with a blank /09 is
 * mojibake at the far end.
 *
 * ## 008/00-05 comes from `createdAt` and is never rewritten
 *
 * Every "titles added this year" statistic and the ISO 2789 return read it. A
 * migrated catalogue whose 008 all said the migration date would report a
 * library that acquired its entire collection on one afternoon.
 */

export type V1Book = {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly isbn13: string | null;
  readonly isbn10: string | null;
  readonly publisher: string | null;
  readonly publicationYear: number | null;
  readonly language: string | null;
  readonly edition: string | null;
  readonly numPages: number | null;
  readonly description: string | null;
  readonly classification: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt: Date | null;
};

export type V1Author = {
  readonly id: string;
  readonly fullName: string;
  readonly isOrganization: boolean;
  readonly birthYear: number | null;
  readonly deathYear: number | null;
  /** 0 is the main entry. */
  readonly order: number;
  readonly role: string | null;
};

export type SynthesisIssue = {
  readonly column: string;
  readonly kind: 'no_target' | 'invalid_source' | 'refused_by_target';
  readonly note: string;
  readonly value: unknown;
};

export type SynthesisResult = {
  readonly record: SynthesisedRecord;
  /** Recorded in `upgrade_exceptions`, never swallowed. */
  readonly issues: readonly SynthesisIssue[];
};

/**
 * MARC's own language codes are ISO 639-2/B.
 *
 * Greek is `gre` and NOT `ell` — §5 says so twice, and `ell` is the terminology
 * variant, which is wrong for MARC. A code this table does not know becomes an
 * `invalid_source` exception and a BLANK 008/35-37, which is MARC's own "not
 * coded"; inventing a code would be asserting something about the book.
 */
const ISO_639_2B: Readonly<Record<string, string>> = {
  el: 'gre',
  gr: 'gre',
  ell: 'gre',
  gre: 'gre',
  en: 'eng',
  eng: 'eng',
  fr: 'fre',
  fre: 'fre',
  fra: 'fre',
  de: 'ger',
  ger: 'ger',
  deu: 'ger',
  it: 'ita',
  ita: 'ita',
  es: 'spa',
  spa: 'spa',
};

/** `YYMMDD` in UTC. The 1.0 column is naive and is READ AS UTC — see the spec. */
function yymmdd(at: Date): string {
  const y = String(at.getUTCFullYear() % 100).padStart(2, '0');
  const m = String(at.getUTCMonth() + 1).padStart(2, '0');
  const d = String(at.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** `YYYYMMDDHHMMSS.F`, MARC 005. */
export function marc005(at: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}` +
    `${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}.0`
  );
}

/**
 * ISBN check digit. An ISBN that fails becomes `020 $z` and an exception.
 *
 * §5: check-digit validated, and NONE of them is a uniqueness constraint. A
 * library that has been typing an ISBN wrong for ten years still owns the book,
 * so a failure is recorded and the value is kept in the subfield MARC has for
 * exactly this — `$z`, cancelled or invalid.
 */
export function isbnIsValid(raw: string): boolean {
  const s = raw.replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 10; i += 1) {
      const c = s[i] as string;
      sum += (c === 'X' ? 10 : Number(c)) * (10 - i);
    }
    return sum % 11 === 0;
  }
  if (/^\d{13}$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 13; i += 1) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
    return sum % 10 === 0;
  }
  return false;
}

/** `$d` for a personal name: `1883-1957.`, `1883-`, or absent. */
function lifeDates(a: V1Author): string | null {
  if (a.birthYear === null && a.deathYear === null) return null;
  return `${a.birthYear ?? ''}-${a.deathYear ?? ''}`;
}

/**
 * Build the record.
 *
 * `008` is 40 characters, filled with the MARC fill character where 1.0 has
 * nothing to say. Blanks are not "unknown": a blank in 008/35-37 means "no
 * information", which is true, while a guessed `eng` would be a claim.
 */
export function marcFromBook(
  book: V1Book,
  authors: readonly V1Author[],
  orgCode: string,
): SynthesisResult {
  const issues: SynthesisIssue[] = [];
  const fields: { t: string; v?: string; i?: string; s?: Record<string, string>[] }[] = [];

  // -- 001 / 003 / 005 -------------------------------------------------------
  // THE CUID IS THE CONTROL NUMBER. Every permalink, every audit_log target and
  // every offline replica's reference survives the cutover because of this one
  // line; a fresh id would silently break all three.
  fields.push({ t: '001', v: book.id });
  fields.push({ t: '003', v: orgCode });
  fields.push({ t: '005', v: marc005(book.updatedAt) });

  // -- 008 -------------------------------------------------------------------
  const lang = book.language === null ? null : ISO_639_2B[book.language.toLowerCase().slice(0, 3)];
  if (book.language !== null && lang === undefined) {
    issues.push({
      column: 'language',
      kind: 'invalid_source',
      note:
        `The 1.0 language ${JSON.stringify(book.language)} is not an ISO 639-2/B code this ` +
        `migration knows. 008/35-37 is left blank, which is MARC's "no information" — a guessed ` +
        `code would be a claim about the book.`,
      value: book.language,
    });
  }
  const year = book.publicationYear;
  const yearStr =
    year !== null && year >= 0 && year <= 9999 ? String(year).padStart(4, '0') : '    ';
  const o = [
    yymmdd(book.createdAt), // 00-05 date entered, NEVER rewritten
    year === null ? 'n' : 's', // 06 date type: single date, or no date
    yearStr, // 07-10
    '    ', // 11-14
    '   ', // 15-17 place: not recorded by 1.0
    ' '.repeat(17), // 18-34
    (lang ?? '   ').padEnd(3, ' '), // 35-37
    ' ', // 38
    'd', // 39 cataloguing source: other
  ].join('');
  fields.push({ t: '008', v: o });

  // -- 020 -------------------------------------------------------------------
  // $a is the valid one; $z is "cancelled/invalid", which is where a 10-digit
  // form belongs on a record that also carries a 13, and where a failed check
  // digit belongs always.
  const isbnSubs: Record<string, string>[] = [];
  if (book.isbn13 !== null) {
    const ok = isbnIsValid(book.isbn13);
    isbnSubs.push(ok ? { a: book.isbn13 } : { z: book.isbn13 });
    if (!ok) {
      issues.push({
        column: 'isbn13',
        kind: 'invalid_source',
        note:
          `The 1.0 isbn13 fails its check digit. It is carried in 020 $z — MARC's subfield for ` +
          `a cancelled or invalid ISBN — rather than dropped: a library that has been typing it ` +
          `wrong for ten years still owns the book.`,
        value: book.isbn13,
      });
    }
  }
  if (book.isbn10 !== null) isbnSubs.push({ z: book.isbn10 });
  if (isbnSubs.length > 0) fields.push({ t: '020', i: '  ', s: isbnSubs });

  // -- 041 -------------------------------------------------------------------
  if (lang !== undefined && lang !== null) fields.push({ t: '041', i: '0 ', s: [{ a: lang }] });

  // -- 100 / 110 -------------------------------------------------------------
  const sorted = [...authors].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const main = sorted[0];
  if (main !== undefined) {
    const subs: Record<string, string>[] = [{ a: main.fullName }];
    const d = lifeDates(main);
    if (d !== null && !main.isOrganization) subs.push({ d });
    // $e ON THE MAIN ENTRY TOO. Every candidate design for this phase put $e on
    // 700/710 and omitted it here, which migrates a book whose first listed
    // creator is a TRANSLATOR as having written it.
    if (main.role !== null) subs.push({ e: main.role });
    subs.push({ 0: main.id });
    fields.push({
      t: main.isOrganization ? '110' : '100',
      i: main.isOrganization ? '2 ' : '1 ',
      s: subs,
    });
  }

  // -- 245 -------------------------------------------------------------------
  // ind1: 1 when there is a main entry (a title added entry is wanted), 0 when
  // the title IS the main entry. ind2: the non-filing skip, computed by the
  // shared function the projector and the sort key also use.
  const nonfiling = stripNonfilingArticle(book.title, lang ?? null);
  const skip = Math.min(9, Math.max(0, nonfiling.skip));
  const titleSubs: Record<string, string>[] = [
    { a: book.subtitle === null ? book.title : `${book.title} :` },
  ];
  if (book.subtitle !== null) titleSubs.push({ b: book.subtitle });
  if (main !== undefined) titleSubs.push({ c: main.fullName });
  fields.push({ t: '245', i: `${main === undefined ? '0' : '1'}${skip}`, s: titleSubs });

  // -- 250 / 264 / 300 / 520 -------------------------------------------------
  if (book.edition !== null) fields.push({ t: '250', i: '  ', s: [{ a: book.edition }] });
  const pubSubs: Record<string, string>[] = [];
  if (book.publisher !== null) pubSubs.push({ b: book.publisher });
  if (year !== null) pubSubs.push({ c: String(year) });
  // ind2 = 1: publication. RDA's 264 rather than AACR2's 260, because §5 has the
  // ISBD generator running for Leader/18 in (' ','c','n','u') and 'c' is growing.
  if (pubSubs.length > 0) fields.push({ t: '264', i: ' 1', s: pubSubs });
  if (book.numPages !== null) {
    fields.push({ t: '300', i: '  ', s: [{ a: `${book.numPages} pages` }] });
  }
  if (book.description !== null) fields.push({ t: '520', i: '  ', s: [{ a: book.description }] });

  // -- 082 / 084 -------------------------------------------------------------
  // 1.0's single free-text `classification` stands in for Dewey, LCC and a local
  // shelf code alike. A leading digit is the only evidence available for Dewey;
  // everything else goes to 084 with an explicit "other scheme" $2, which is
  // what 084 is FOR and is honest about not knowing.
  if (book.classification !== null) {
    const c = book.classification.trim();
    if (/^\d{3}(\.\d+)?/.test(c)) fields.push({ t: '082', i: '04', s: [{ a: c }] });
    else fields.push({ t: '084', i: '  ', s: [{ a: c }, { 2: 'local' }] });
  }

  // -- 700 / 710 -------------------------------------------------------------
  for (const a of sorted.slice(1)) {
    const subs: Record<string, string>[] = [{ a: a.fullName }];
    const d = lifeDates(a);
    if (d !== null && !a.isOrganization) subs.push({ d });
    if (a.role !== null) subs.push({ e: a.role });
    subs.push({ 0: a.id });
    fields.push({
      t: a.isOrganization ? '710' : '700',
      i: a.isOrganization ? '2 ' : '1 ',
      s: subs,
    });
  }

  // -- leader ----------------------------------------------------------------
  // /05 'd' for a deleted (archived) record, 'n' for new. /06 'a' language
  // material, /07 'm' monograph. /09 'a' = UCS/Unicode, from the EXPORT
  // encoding.
  //
  // /17 '7' MINIMAL LEVEL: these were not catalogued, they were migrated, and
  // claiming full level would be a claim about work nobody did. Encoding level
  // is not cosmetic — it is what a receiving system's overlay logic reads to
  // decide whether an incoming record should replace a held one.
  //
  // /18 'a' AACR2. The record below writes ISBD punctuation — 245 $a ends in
  // " :" when there is a subtitle — so 'c' (ISBD punctuation omitted) would be
  // a lie about the bytes. 'a' is also what `SHIPPED_TEMPLATES` starts a book
  // from, so a migrated record and a typed one describe themselves the same way.
  //
  // THIS LINE SHIPPED WRONG FROM PHASE 19b UNTIL 20l. It read
  // `a22000003M 4500`, which puts '3' (abbreviated) at /17 and 'M' at /18 — and
  // 'M' is not a defined value there, so `validate()` returned
  // `position-not-allowed` on EVERY migrated record. At warning severity, so
  // nothing ever stopped. The comment above it named /17 while the byte it
  // described sat at /18: a leader written as a literal is counted by eye, and
  // this is the second off-by-one of exactly this kind in the file's history.
  // Hence the assertions in the test beside it, which now pin both positions.
  const status = book.archivedAt === null ? 'n' : 'd';
  const leader = `00000${status}am a22000007a 4500`.slice(0, 24).padEnd(24, ' ');

  return { record: { leader, fields }, issues };
}
