import { describe, expect, it } from 'vitest';
import { parseMarc } from './marc-parser.js';
import { ParseError } from './types.js';

const FT = '\x1e';
const SF = '\x1f';
const RT = '\x1d';

/**
 * Assemble a valid ISO 2709 record from fields. Control fields carry raw
 * data; data fields carry `indicators + \x1f<code>value…`. Lengths +
 * offsets are computed in BYTES so multibyte content stays correct.
 */
function buildBinaryMarc(fields: Array<{ tag: string; data: string }>): Buffer {
  let dir = '';
  let body = '';
  let pos = 0;
  for (const f of fields) {
    const fd = f.data + FT;
    const len = Buffer.byteLength(fd, 'utf8');
    dir += f.tag + String(len).padStart(4, '0') + String(pos).padStart(5, '0');
    body += fd;
    pos += len;
  }
  dir += FT;
  const base = 24 + Buffer.byteLength(dir, 'utf8');
  const tail = dir + body + RT;
  const total = 24 + Buffer.byteLength(tail, 'utf8');
  // 24-char leader: len(5) + "nam a22" (pos5-11; pos9='a' = UTF-8) + base(5)
  // + "   4500" (pos17-23; the 4500 entry-map at positions 20-23).
  const leader =
    String(total).padStart(5, '0') + 'nam a22' + String(base).padStart(5, '0') + '   4500';
  return Buffer.from(leader + tail, 'utf8');
}

describe('parseMarc (binary ISO 2709)', () => {
  it('extracts control + data subfields into tag$code columns', () => {
    const rec = buildBinaryMarc([
      { tag: '001', data: 'ocn123' },
      { tag: '020', data: `  ${SF}a9780441013593` },
      { tag: '100', data: `1 ${SF}aHerbert, Frank` },
      { tag: '245', data: `10${SF}aDune${SF}bthe novel` },
    ]);
    const t = parseMarc(rec);
    expect(t.meta.format).toBe('marc');
    expect(t.rows).toHaveLength(1);
    const cells = t.rows[0]!.cells;
    expect(cells['001']).toBe('ocn123');
    expect(cells['020$a']).toBe('9780441013593');
    expect(cells['100$a']).toBe('Herbert, Frank');
    expect(cells['245$a']).toBe('Dune');
    expect(cells['245$b']).toBe('the novel');
  });

  it('keeps multibyte Greek subfield content intact', () => {
    const rec = buildBinaryMarc([{ tag: '245', data: `10${SF}aΟι Δαιμονισμένοι` }]);
    const t = parseMarc(rec);
    expect(t.rows[0]!.cells['245$a']).toBe('Οι Δαιμονισμένοι');
  });

  it('joins repeated subfields with a separator', () => {
    const rec = buildBinaryMarc([{ tag: '650', data: ` 0${SF}aScience fiction${SF}aSpace` }]);
    const t = parseMarc(rec);
    expect(t.rows[0]!.cells['650$a']).toBe('Science fiction | Space');
  });

  it('parses multiple records into multiple rows', () => {
    const a = buildBinaryMarc([{ tag: '245', data: `10${SF}aBook A` }]);
    const b = buildBinaryMarc([{ tag: '245', data: `10${SF}aBook B` }]);
    const t = parseMarc(Buffer.concat([a, b]));
    expect(t.rows.map((r) => r.cells['245$a'])).toEqual(['Book A', 'Book B']);
  });
});

describe('parseMarc (MARCXML)', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<collection xmlns="http://www.loc.gov/MARC21/slim">
  <record>
    <leader>00000nam a2200000 c 4500</leader>
    <controlfield tag="001">rec-1</controlfield>
    <datafield tag="020" ind1=" " ind2=" "><subfield code="a">9781501142970</subfield></datafield>
    <datafield tag="100" ind1="1" ind2=" "><subfield code="a">King, Stephen</subfield></datafield>
    <datafield tag="245" ind1="1" ind2="0"><subfield code="a">It</subfield></datafield>
  </record>
  <record>
    <datafield tag="245" ind1="1" ind2="0"><subfield code="a">Carrie</subfield></datafield>
  </record>
</collection>`;

  it('parses namespaced MARCXML into rows', () => {
    const t = parseMarc(Buffer.from(xml, 'utf-8'));
    expect(t.meta.format).toBe('marcxml');
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]!.cells['001']).toBe('rec-1');
    expect(t.rows[0]!.cells['020$a']).toBe('9781501142970');
    expect(t.rows[0]!.cells['100$a']).toBe('King, Stephen');
    expect(t.rows[0]!.cells['245$a']).toBe('It');
    expect(t.rows[1]!.cells['245$a']).toBe('Carrie');
  });

  it('auto-detects XML vs binary regardless of declared format', () => {
    const t = parseMarc(Buffer.from(xml, 'utf-8'));
    expect(t.meta.format).toBe('marcxml');
  });

  it('throws ParseError when there are no records', () => {
    expect(() => parseMarc(Buffer.from('<collection></collection>', 'utf-8'))).toThrow(ParseError);
  });
});
