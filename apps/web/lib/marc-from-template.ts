/**
 * Fill a catalogue template into the record `POST /catalog/bib` accepts
 * (2.0 phase 20l).
 *
 * ## The template is SERVED, not hand-rolled
 *
 * `POST /t/:slug/catalog/bib` takes a whole MARC record and there is no scalar
 * create route, so a create screen must know what a new book looks like. That
 * answer already exists as gate-checked data in `SHIPPED_TEMPLATES`
 * (`packages/marc/src/templates.ts`, enforced by `check:marc-schema`), and
 * phase 20l serves it at `GET /t/:slug/catalog/templates` rather than letting
 * the web app invent a second one.
 *
 * That is not fussiness. The bytes a create form has to get right are counted
 * by eye, and eyes miscount: `marc-from-book.ts` shipped a leader from phase
 * 19b to 20l whose comment named Leader/17 while the byte it described sat at
 * /18 — where its value is not defined at all — so every migrated record
 * carried a `position-not-allowed` warning that nothing ever stopped on. This
 * module never writes a leader. It copies the template's.
 *
 * ## What it decides, and what it refuses to
 *
 * It fills subfield VALUES into the shape the template lays out, and drops any
 * field the cataloguer left entirely empty — a template offers a 650 because a
 * book usually has a subject, not because an empty one should be written.
 *
 * The two values that are genuinely computed are the ones a form cannot get
 * right by typing: the 245 non-filing indicator, and the ISBN's validity. Both
 * come from `@libriant/shared`, which is already a web dependency and which
 * `bib-projection.ts` calls for the SAME two decisions — so the record this
 * builds and the projection the server derives from it cannot disagree about
 * how "Ο άνθρωπος" files or whether an ISBN's check digit is sound.
 */
import { stripNonfilingArticle } from '@libriant/shared/greek';
import { checkIsbn } from '@libriant/shared/identifiers';

/** One field of a served template — the wire shape of `TemplateField`. */
export type TemplateField = {
  readonly tag: string;
  readonly i?: string;
  readonly codes?: readonly string[];
  readonly v?: string;
  readonly hint?: string;
};

/** A served template — the wire shape of `CatalogTemplate`. */
export type CatalogTemplate = {
  readonly id: string;
  readonly label: string;
  readonly profile: string;
  readonly leader: string;
  readonly fields: readonly TemplateField[];
};

/** What the create form collects. Every value is optional except the title. */
export type BookFields = {
  title: string;
  subtitle: string;
  statementOfResponsibility: string;
  author: string;
  authorDates: string;
  isbn: string;
  edition: string;
  place: string;
  publisher: string;
  publicationYear: string;
  extent: string;
  note: string;
  subject: string;
  /** ISO 639-2/B, three letters — Greek is `gre`, never `ell`. */
  language: string;
};

export const EMPTY_BOOK: BookFields = {
  title: '',
  subtitle: '',
  statementOfResponsibility: '',
  author: '',
  authorDates: '',
  isbn: '',
  edition: '',
  place: '',
  publisher: '',
  publicationYear: '',
  extent: '',
  note: '',
  subject: '',
  language: '',
};

export type BuiltField = { t: string; v?: string; i?: string; s?: Record<string, string>[] };

export type BuiltRecord = { leader: string; fields: BuiltField[] };

/**
 * Overwrite a slice of a fixed field without changing its length.
 *
 * An 008 is forty bytes whose meaning is POSITIONAL, so the one thing that must
 * never happen is a write that shifts what follows it. Writing through a
 * character array and asserting the length is how this stays true when a value
 * arrives shorter or longer than the window it is going into.
 */
function poke(field: string, at: number, value: string, width: number): string {
  const chars = field.split('');
  const padded = value.padEnd(width, ' ').slice(0, width);
  for (let i = 0; i < width; i += 1) chars[at + i] = padded[i] as string;
  const out = chars.join('');
  if (out.length !== field.length) {
    throw new Error(
      `008 changed length writing ${width} at ${at}: ${field.length} -> ${out.length}`,
    );
  }
  return out;
}

/** `YYMMDD`, the form 008/00-05 takes. */
function yymmdd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * The 008 for a new record, written onto the template's own starting value.
 *
 * The template starts every constrained position at `|` ("no attempt to code"),
 * which is what an unfilled position honestly is — so this only writes the
 * positions the form actually collected and leaves the rest alone.
 *
 * ## 008/00-05 is written from the BROWSER's date, and that is a known seam
 *
 * `bib-write.service.ts` sets the `date_entered` COLUMN from the server's clock
 * and says it is never rewritten, because every "titles added this year" figure
 * and the ISO 2789 return read it. The record's own 008/00-05 is this value,
 * and nothing compares the two — so a cataloguer working at 01:30 in Athens can
 * produce a record whose 008 and whose column name different days. The fix
 * belongs on the server, beside `leaderForWrite`, which already overwrites five
 * leader positions on every write; it is recorded in the divergence log rather
 * than fixed from the client, because a client is exactly the wrong place to
 * decide what day the library catalogued something.
 */
function build008(template: string, fields: BookFields, now: Date): string {
  let o = template.length === 40 ? template : ''.padEnd(40, ' ');
  o = poke(o, 0, yymmdd(now), 6);
  const year = fields.publicationYear.trim();
  const isYear = /^\d{4}$/.test(year);
  // /06 date type: 's' a single known date, 'n' dates unknown. The template
  // starts it at '|', which would claim no attempt was made to code a fact the
  // form did ask for.
  o = poke(o, 6, isYear ? 's' : 'n', 1);
  o = poke(o, 7, isYear ? year : '    ', 4);
  const lang = fields.language.trim().toLowerCase();
  // Three letters or nothing. A guessed code is a claim about the book, and
  // blank is MARC's "no information" — which is true here.
  o = poke(o, 35, /^[a-z]{3}$/.test(lang) ? lang : '   ', 3);
  return o;
}

/** The subfields for one tag, in the order the template lays them out. */
function subfieldsFor(
  tag: string,
  codes: readonly string[],
  fields: BookFields,
): Record<string, string>[] {
  const value = (code: string): string => {
    if (tag === '020' && code === 'a') return fields.isbn.trim();
    if (tag === '100') return code === 'a' ? fields.author.trim() : fields.authorDates.trim();
    if (tag === '245') {
      if (code === 'a') return fields.title.trim();
      if (code === 'b') return fields.subtitle.trim();
      if (code === 'c') return fields.statementOfResponsibility.trim();
    }
    if (tag === '250' && code === 'a') return fields.edition.trim();
    if (tag === '264') {
      if (code === 'a') return fields.place.trim();
      if (code === 'b') return fields.publisher.trim();
      if (code === 'c') return fields.publicationYear.trim();
    }
    if (tag === '300' && code === 'a') return fields.extent.trim();
    if (tag === '500' && code === 'a') return fields.note.trim();
    if (tag === '650' && code === 'a') return fields.subject.trim();
    return '';
  };
  const out: Record<string, string>[] = [];
  for (const code of codes) {
    const v = value(code);
    // Dropped, not written empty. A present-but-blank $b is a different record
    // from one without a $b, and it is the wrong one.
    if (v !== '') out.push({ [code]: v });
  }
  return out;
}

/**
 * Build the record to POST.
 *
 * Returns the record plus the ISBN verdict, because a failed check digit is a
 * FACT the cataloguer should see rather than a refusal: §5 is explicit that no
 * identifier is a uniqueness constraint, and a set, a reprint and endemic
 * publisher reuse in small Greek presses all legitimately share an ISBN. The
 * caller shows the warning and lets the save proceed.
 */
export function recordFromBook(
  template: CatalogTemplate,
  fields: BookFields,
  now: Date,
): { record: BuiltRecord; isbn: { normalized: string; valid: boolean; reason: string } | null } {
  const isbnRaw = fields.isbn.trim();
  const isbn = isbnRaw === '' ? null : checkIsbn(isbnRaw);
  const filled: BookFields = { ...fields, isbn: isbn ? isbn.normalized : '' };

  // ind1 = 1 when a 1XX main entry exists (a title added entry is wanted),
  // 0 when the title IS the main entry. ind2 = the characters to skip when
  // filing, from the same function `bib-projection.ts` uses — so the record and
  // the projection cannot file the title two different ways.
  const hasMainEntry = filled.author.trim() !== '';
  const nonfiling = stripNonfilingArticle(filled.title.trim(), filled.language.trim() || null);
  const skip = Math.min(9, Math.max(0, nonfiling.skip));

  const out: BuiltField[] = [];
  for (const f of template.fields) {
    if (f.v !== undefined) {
      if (f.tag === '008') out.push({ t: '008', v: build008(f.v, filled, now) });
      else out.push({ t: f.tag, v: f.v });
      continue;
    }
    const s = subfieldsFor(f.tag, f.codes ?? [], filled);
    // A field with nothing in it is not written. The template offers 650
    // because a book usually has a subject, not because an empty one belongs in
    // the catalogue.
    if (s.length === 0) continue;
    let indicators = (f.i ?? '  ').padEnd(2, ' ').slice(0, 2);
    if (f.tag === '245') indicators = `${hasMainEntry ? '1' : '0'}${skip}`;
    out.push({ t: f.tag, i: indicators, s });
  }

  // THE TEMPLATE'S LEADER, copied. Not composed, not patched — the server
  // applies its own write rules to /05, /09, /10, /11 and /20-23 anyway, and
  // the positions it deliberately leaves alone (/06, /07, /17, /18) are exactly
  // the ones the template is the gate-checked answer for.
  return { record: { leader: template.leader, fields: out }, isbn };
}
