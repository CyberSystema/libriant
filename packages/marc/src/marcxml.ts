import { XMLParser } from 'fast-xml-parser';
import {
  ANOMALY,
  MarcError,
  isControlTag,
  isDataField,
  subfieldCode,
  subfieldValue,
  type MarcAnomaly,
  type MarcField,
  type MarcRecord,
  type ParsedRecord,
  type Subfield,
} from './types.js';

/**
 * MARCXML — LC's "slim" schema. Read with a parser, written by hand.
 *
 * ## Why the writer is hand-rolled and the reader is not
 *
 * The reader has to cope with whatever a hundred systems emit: namespaces or
 * none, CDATA, comments, entity references, attribute quoting either way. That
 * is a real XML problem and `fast-xml-parser` already solves it, is already a
 * dependency of `apps/api`, and is pure JavaScript, so it runs in the webview
 * this package must run in.
 *
 * The writer has to guarantee two things no generic builder will:
 *
 *   1. **Subfield ORDER and REPEATS.** `245 $a $b $a` is ordinary and it is not
 *      recoverable from any map-shaped intermediate. A builder handed an object
 *      keeps one `$a`.
 *   2. **Escaping is the injection surface.** Subfield values come from
 *      cataloguers, from imports, and from AI suggestions. This is the one place
 *      in the codec where getting it wrong produces not a corrupt record but an
 *      XML document that means something else.
 *
 * `preserveOrder: true` is what makes the READER safe on point 1 — it returns
 * ordered arrays rather than collapsing siblings into an object — and
 * `trimValues: false` is what makes it safe generally: MARC fixed fields are
 * position-significant, so `<controlfield tag="008">  12345 </controlfield>`
 * loses its meaning the moment something trims it. The 1.0 reader
 * (`apps/api/src/import/parsers/marc-parser.ts`) sets `trimValues: true`.
 */

export const MARCXML_NAMESPACE = 'http://www.loc.gov/MARC21/slim';

const PARSER = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Records arrive with and without the namespace prefix; strip it so both read.
  removeNSPrefix: true,
  // Never coerce: a control number of `007` must not become the number 7, and
  // an indicator of `0` must not become a falsy number.
  parseTagValue: false,
  parseAttributeValue: false,
  // Fixed fields are position-significant. Trimming is what the 1.0 reader did.
  trimValues: false,
  // Expand `&amp;` and friends…
  processEntities: true,
  // …and `&#x0391;` / `&#913;`, which `processEntities` alone does NOT cover.
  // Without this a record written by a system that escapes non-ASCII — which is
  // how a great many exporters emit Greek — imports with the literal text
  // `&#x0391;` in the title, silently, because it is well-formed XML either way.
  htmlEntities: true,
});

type Node = Record<string, unknown> & { ':@'?: Record<string, string> };

function childrenOf(node: Node, name: string): Node[] {
  const value = node[name];
  return Array.isArray(value) ? (value as Node[]) : [];
}

function textOf(node: Node, name: string): string {
  const parts = childrenOf(node, name);
  let out = '';
  for (const p of parts) {
    const t = p['#text'];
    if (typeof t === 'string') out += t;
    else if (typeof t === 'number') out += String(t);
  }
  return out;
}

/** Read every `<record>` in a MARCXML document. */
export function readMarcXml(text: string): ParsedRecord[] {
  let tree: Node[];
  try {
    tree = PARSER.parse(text) as Node[];
  } catch (err) {
    throw new MarcError(
      'marcxml-invalid',
      `That is not well-formed XML: ${(err as Error).message}`,
      {
        cause: err,
      },
    );
  }

  const records: Node[] = [];
  const walk = (nodes: Node[]): void => {
    for (const node of nodes) {
      for (const [key, value] of Object.entries(node)) {
        if (key === ':@' || key === '#text') continue;
        if (key === 'record') {
          records.push({ record: value } as Node);
          continue;
        }
        if (Array.isArray(value)) walk(value as Node[]);
      }
    }
  };
  walk(tree);

  if (!records.length) {
    throw new MarcError(
      'marcxml-no-records',
      'No <record> elements were found. A MARCXML file holds one <record>, or a <collection> of them.',
    );
  }
  return records.map((r) => readOneRecord(childrenOf(r, 'record')));
}

/** Read a single `<record>`'s children. */
function readOneRecord(children: Node[]): ParsedRecord {
  const anomalies: MarcAnomaly[] = [];
  let leader = '';
  const fields: MarcField[] = [];
  const seen = new Map<string, number>();

  for (const child of children) {
    if ('leader' in child) {
      leader = textOf(child, 'leader');
      continue;
    }
    if ('controlfield' in child) {
      const tag = child[':@']?.['@_tag'] ?? '';
      const occurrence = bump(seen, tag);
      if (!/^[!-~]{3}$/.test(tag)) {
        anomalies.push({ code: ANOMALY.tagMalformed, tag, occurrence, saw: tag });
      }
      fields.push({ t: tag, v: textOf(child, 'controlfield') });
      continue;
    }
    if ('datafield' in child) {
      const attrs = child[':@'] ?? {};
      const tag = attrs['@_tag'] ?? '';
      const occurrence = bump(seen, tag);
      if (!/^[!-~]{3}$/.test(tag)) {
        anomalies.push({ code: ANOMALY.tagMalformed, tag, occurrence, saw: tag });
      }
      // A missing or empty indicator attribute means a blank, which is a SPACE.
      // Every exporter that writes `ind1=""` means one.
      const ind = (v: string | undefined): string => (v && v.length ? (v[0] as string) : ' ');
      const s: Subfield[] = [];
      for (const sub of childrenOf(child, 'datafield')) {
        if (!('subfield' in sub)) continue;
        const code = sub[':@']?.['@_code'] ?? '';
        // An empty `<subfield code="a"/>` yields no `#text` child at all; it is a
        // real, legal, empty subfield and must not vanish.
        s.push({ [code]: textOf(sub, 'subfield') });
      }
      if (!s.length) {
        anomalies.push({ code: ANOMALY.dataFieldHasNoSubfields, tag, occurrence });
      }
      if (isControlTag(tag)) {
        anomalies.push({ code: ANOMALY.controlFieldHasSubfields, tag, occurrence });
      }
      fields.push({ t: tag, i: `${ind(attrs['@_ind1'])}${ind(attrs['@_ind2'])}`, s });
      continue;
    }
  }

  if (leader.length !== 24) {
    anomalies.push({ code: ANOMALY.leaderLengthWrong, saw: leader });
    leader = leader.padEnd(24, ' ').slice(0, 24);
  }
  return { record: { leader, fields }, anomalies };
}

function bump(seen: Map<string, number>, tag: string): number {
  const n = (seen.get(tag) ?? 0) + 1;
  seen.set(tag, n);
  return n;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * XML 1.0 forbids most C0 controls outright — they cannot be written literally
 * and cannot be written as a numeric character reference either. MARC data can
 * legally contain them (a stray 0x1F that survived an earlier bad import), so a
 * writer has to choose, and every MARCXML writer in the profession chooses to
 * drop them. They are dropped here too, and the choice is stated rather than
 * discovered: the alternative is emitting a document no XML parser will read.
 */
function stripXmlIllegal(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    // Tab, newline and carriage return are the only C0 characters XML 1.0
    // allows. Everything else below 0x20 is forbidden outright and cannot even
    // be written as a numeric character reference.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    out += ch;
  }
  return out;
}

/**
 * Escape text for an element body.
 *
 * `&`, `<` and `>` — the last is not strictly required outside `]]>`, but
 * escaping it unconditionally means no reader has to reason about context, and
 * it is what LC's own output does.
 */
function escapeText(value: string): string {
  return (
    stripXmlIllegal(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // A carriage return in element content is normalised to a line feed by
      // every conforming XML parser, so a value holding one comes back changed —
      // silently, and in a 505 contents note, which is exactly where multi-line
      // values live. A numeric reference is the only spelling that survives, and
      // it is what LC's own MARCXML output uses.
      .replace(/\r/g, '&#13;')
  );
}

/** Escape for a double-quoted attribute value. */
function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

export type MarcXmlWriteOptions = {
  /** Wrap in `<collection>`. Default true for a list, false for a single record. */
  readonly collection?: boolean;
  /** Emit the XML declaration. Default true. */
  readonly declaration?: boolean;
  /** Indent for readability. Default true; false for a stream. */
  readonly pretty?: boolean;
};

/**
 * Write one record as a `<record>` element.
 *
 * `depth` shifts the whole record right, and it exists so that
 * {@link writeMarcXml} never has to re-indent by splitting the result on
 * newlines. It used to, and a subfield value containing a newline — a long 505
 * contents note, which is where they live — had the collection's indent injected
 * into the middle of the librarian's data.
 */
export function writeMarcXmlRecord(record: MarcRecord, indent = '', depth = 0): string {
  const nl = indent ? '\n' : '';
  const pad = (n: number) => (indent ? indent.repeat(n + depth) : '');
  const out: string[] = [`${pad(0)}<record>`];
  out.push(`${pad(1)}<leader>${escapeText(record.leader)}</leader>`);
  for (const f of record.fields) {
    if (!isDataField(f)) {
      out.push(
        `${pad(1)}<controlfield tag="${escapeAttribute(f.t)}">${escapeText(f.v)}</controlfield>`,
      );
      continue;
    }
    const i = f.i.padEnd(2, ' ');
    out.push(
      `${pad(1)}<datafield tag="${escapeAttribute(f.t)}" ` +
        `ind1="${escapeAttribute(i[0] as string)}" ind2="${escapeAttribute(i[1] as string)}">`,
    );
    for (const s of f.s) {
      out.push(
        `${pad(2)}<subfield code="${escapeAttribute(subfieldCode(s))}">` +
          `${escapeText(subfieldValue(s))}</subfield>`,
      );
    }
    out.push(`${pad(1)}</datafield>`);
  }
  out.push(`${pad(0)}</record>`);
  return out.join(nl || '');
}

/** Write one or more records as a MARCXML document. */
export function writeMarcXml(
  records: MarcRecord | readonly MarcRecord[],
  opts: MarcXmlWriteOptions = {},
): string {
  const list = Array.isArray(records)
    ? (records as readonly MarcRecord[])
    : [records as MarcRecord];
  const pretty = opts.pretty !== false;
  const indent = pretty ? '  ' : '';
  const nl = pretty ? '\n' : '';
  const wrap = opts.collection ?? list.length !== 1;

  const parts: string[] = [];
  if (opts.declaration !== false) parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  if (wrap) parts.push(`<collection xmlns="${MARCXML_NAMESPACE}">`);
  for (const r of list) {
    parts.push(
      wrap
        ? writeMarcXmlRecord(r, indent, 1)
        : writeMarcXmlRecord(r, indent).replace(
            '<record>',
            `<record xmlns="${MARCXML_NAMESPACE}">`,
          ),
    );
  }
  if (wrap) parts.push('</collection>');
  return parts.join(nl) + nl;
}
