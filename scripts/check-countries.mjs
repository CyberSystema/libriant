#!/usr/bin/env node
// The country list was written from knowledge, so it gets checked by machine.
//
// `packages/shared/src/countries.ts` was written from memory. A wrong digit in
// it is not a rendering bug: the marketing form is the commercial funnel, phone
// is a required field, and a library that picks its country and leaves a number
// that cannot be dialled is a lead lost in silence, with nothing anywhere that
// would ever report it. Two other surfaces (the country `<select>` and the
// dial-code `<select>`) are built on this list, and neither can notice.
//
// This file first claimed there was no dataset to check the list against. That
// was wrong, and a review proved it by finding VA at +379 with the metadata in
// node_modules: ICU has the names, and libphonenumber-js has the dial codes.
// Both are consulted here, so "written from memory" now describes only how the
// list was drafted, not what is trusted about it.
//
// So everything mechanically checkable is checked:
//   - every code is a well-formed alpha-2 that ICU resolves to a real name in
//     BOTH Greek and English, and the committed name is still that name;
//   - every dial code is 1–4 digits opening on a valid E.164 zone, AND matches
//     Google's libphonenumber metadata, in both directions;
//   - the duplicate dial codes are exactly the twelve groups spelled out below,
//     each one a real shared numbering plan rather than a typo;
//   - every region ICU knows is either in the list, in the six deliberately
//     omitted, or in the codes ISO does not assign — which pins the count to
//     the 249 assigned alpha-2 codes instead of a range anyone can argue with;
//   - GR and CY, the two this business depends on, plus the EU27, the UK, the
//     US, Canada, Australia and Türkiye, are asserted digit by digit.
//
// This imports the module rather than parsing it, so it checks the values the
// form will actually render — including the sort orders, which are data too.
// Node runs the TypeScript directly (type stripping, node >= 26 per the root
// engines field); no build step, no install, same as the other check scripts.
import {
  COUNTRIES,
  PRIORITY_COUNTRY_CODES,
  DEFAULT_COUNTRY_CODE,
  countriesFor,
  findCountry,
  isCountryCode,
} from '../packages/shared/src/countries.ts';

const problems = [];
const fail = (msg) => problems.push(msg);

// --- the deliberate omissions ----------------------------------------------
//
// Officially assigned by ISO, but no telephone administration of their own:
// there is no number that reaches them, so a form that requires a phone number
// cannot honestly offer them. Antarctica is the arguable one — some stations
// answer on +672 via Norfolk Island's plan — but it has no libraries and no
// postal country to put on an invoice.
const NO_PHONE = {
  AQ: 'Antarctica — research stations only, no national numbering plan',
  BV: 'Bouvet Island — uninhabited Norwegian dependency',
  GS: 'South Georgia & the South Sandwich Islands — no resident population',
  HM: 'Heard & McDonald Islands — uninhabited Australian territory',
  TF: 'French Southern Territories — research stations only',
  UM: 'U.S. Outlying Islands — no resident civilian population',
};

// Regions ICU knows that ISO 3166-1 does not currently assign: exceptionally
// reserved codes, formerly assigned codes ICU keeps for old data, ICU's own
// macro-regions, and CLDR's pseudo-locale placeholders. XK is here because
// Kosovo's code is user-assigned — real enough that ICU carries a name for it,
// not an assigned alpha-2 — and the country list is defined by ISO's, not by
// ICU's, which is the whole reason this file exists.
const NOT_ASSIGNED = new Set(
  `AC AN BU CP CQ CS DD DG DY EA EU EZ FX HV IC NH QO RH SU TA TP UK UN VD XA XB
   XK YD YU ZR ZZ`
    .trim()
    .split(/\s+/),
);

/** ISO 3166-1 currently assigns this many alpha-2 codes. */
const ASSIGNED_ALPHA2 = 249;

// --- the shared dial codes --------------------------------------------------
//
// Every duplicate has to be a numbering plan two or more countries genuinely
// share. Listing them by hand is the point: an undeclared duplicate is far more
// likely to be a mistyped digit than a discovery, and a mistyped digit is
// exactly the defect that never gets reported.
const SHARED_DIAL = {
  // The North American Numbering Plan. `dial` is the E.164 country code, so all
  // 25 members are '1' — the 268/246/876 an applicant needs belongs to the
  // number they type, the same way a US area code does.
  1: 'AG AI AS BB BM BS CA DM DO GD GU JM KN KY LC MP MS PR SX TC TT US VC VG VI',
  // Kazakhstan kept the Soviet code; its numbers are +7 6xx and +7 7xx.
  7: 'KZ RU',
  // Vatican City is inside Italy's plan (+39 06 698). ITU did assign it +379,
  // and this list said '379' until a cross-check against the libphonenumber
  // metadata in the store disagreed: +379 was never brought into service, and
  // libphonenumber calls it INVALID_COUNTRY while resolving +39 06 6988 xxxx
  // back to VA. An applicant from the Vatican Apostolic Library picking a code
  // no carrier routes is precisely the lead that is lost in silence, which is
  // the failure this whole file exists to prevent.
  39: 'IT VA',
  // The Crown Dependencies are outside the UK but inside its numbering plan.
  44: 'GB GG IM JE',
  // Svalbard is dialled as Norway (+47 79).
  47: 'NO SJ',
  // Australia's external territories sit in its plan (+61 89162 / 89164).
  61: 'AU CC CX',
  // Pitcairn's landline numbers are New Zealand-assigned.
  64: 'NZ PN',
  // Western Sahara is dialled through Morocco's plan (+212 5288).
  212: 'EH MA',
  // Mayotte moved from +269 to Réunion's +262 in 2007.
  262: 'RE YT',
  // Åland is dialled as Finland (+358 18).
  358: 'AX FI',
  // Guadeloupe, Saint Barthélemy and Saint Martin share one French plan.
  590: 'BL GP MF',
  // Curaçao and the Caribbean Netherlands kept +599 when Sint Maarten left it
  // for +1 721 in 2011 — which is why SX is in the NANP group above.
  599: 'BQ CW',
};

// --- the ones a reader will notice ------------------------------------------
//
// The EU27 plus the five most-recognised others. These are asserted by hand
// because they are the numbers a reviewer already knows: if this table and the
// list ever disagree, the list is what a person would have caught by eye.
//
// VA is here for the opposite reason — nobody knows it by eye, and it is the
// one entry a review actually caught wrong (+379, assigned but never in
// service; see SHARED_DIAL[39]). Pinned so it cannot drift back.
const KNOWN = {
  VA: '39',
  AT: '43',
  BE: '32',
  BG: '359',
  CY: '357',
  CZ: '420',
  DE: '49',
  DK: '45',
  EE: '372',
  ES: '34',
  FI: '358',
  FR: '33',
  GR: '30',
  HR: '385',
  HU: '36',
  IE: '353',
  IT: '39',
  LT: '370',
  LU: '352',
  LV: '371',
  MT: '356',
  NL: '31',
  PL: '48',
  PT: '351',
  RO: '40',
  SE: '46',
  SI: '386',
  SK: '421',
  GB: '44',
  US: '1',
  CA: '1',
  AU: '61',
  TR: '90',
};

const NAMES = {
  el: new Intl.DisplayNames(['el'], { type: 'region', fallback: 'none' }),
  en: new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }),
};

// --- 1. every entry is well-formed -----------------------------------------
const seen = new Set();
for (const c of COUNTRIES) {
  if (!/^[A-Z]{2}$/.test(c.code)) fail(`'${c.code}' is not a well-formed ISO 3166-1 alpha-2 code.`);
  if (seen.has(c.code)) fail(`${c.code} appears twice in COUNTRIES.`);
  seen.add(c.code);

  // 1–4 digits opening on 1–9: E.164 assigns country codes out of zones 1..9,
  // and a leading 0 is a trunk prefix, never part of one.
  if (!/^[1-9][0-9]{0,3}$/.test(c.dial)) {
    fail(`${c.code}: dial '${c.dial}' is not 1–4 digits starting with an E.164 zone digit 1–9.`);
  }

  for (const lang of ['el', 'en']) {
    const icu = NAMES[lang].of(c.code);
    if (!icu) {
      fail(`${c.code}: ICU has no ${lang} name — it is not a region ICU knows.`);
    } else if (icu === c.code) {
      fail(`${c.code}: ICU echoed the code back as its ${lang} name instead of translating it.`);
    } else if (icu !== c[lang]) {
      // CLDR renames countries. Committed names are what the static site and
      // the API's re-rendered form both show, so drift is caught here rather
      // than shipping two labels for one country.
      fail(`${c.code}: committed ${lang} name '${c[lang]}' but this ICU says '${icu}'.`);
    }
  }
}

const sorted = [...COUNTRIES].map((c) => c.code).sort();
if (COUNTRIES.map((c) => c.code).join() !== sorted.join()) {
  fail('COUNTRIES is not in ISO-code order — the order that keeps a diff on it reviewable.');
}

// --- 2. duplicates are exactly the declared shared plans --------------------
const byDial = new Map();
for (const c of COUNTRIES) {
  if (!byDial.has(c.dial)) byDial.set(c.dial, []);
  byDial.get(c.dial).push(c.code);
}
for (const [dial, group] of byDial) {
  if (group.length === 1) continue;
  const declared = SHARED_DIAL[dial];
  if (!declared) {
    fail(
      `+${dial} is shared by ${group.join(', ')} but is not a declared shared plan. ` +
        'Either one of those digits is a typo, or the group belongs in SHARED_DIAL with ' +
        'a comment saying which numbering plan they share.',
    );
  } else if (declared.split(' ').sort().join(' ') !== [...group].sort().join(' ')) {
    fail(`+${dial}: declared '${declared}' but the list has '${[...group].sort().join(' ')}'.`);
  }
}
for (const [dial, declared] of Object.entries(SHARED_DIAL)) {
  if (!byDial.has(dial))
    fail(`SHARED_DIAL declares +${dial} (${declared}) but no country uses it.`);
}

// --- 2b. every dial code, against Google's metadata --------------------------
//
// The checks above prove the list is internally consistent and that the 33
// codes a reviewer knows by eye are right. They cannot prove the other 210,
// which were written from memory — and the review that found +379 found it by
// reaching for this package, not by reading the table.
//
// libphonenumber-js carries Google's libphonenumber metadata, is already in the
// production closure (class-validator depends on it), and needs no network. It
// is the authority the header of this file said did not exist, so every dial
// code is now compared against it rather than trusted.
//
// Where it disagrees, it wins on the question this list actually asks — "what
// do you dial to reach this country" — because its answer is the one carriers
// route. That is not the same question ITU assignment answers: +379 IS assigned
// to Vatican City and has never been brought into service, and a form that
// offers it produces a number nobody can ring.
const lpn = await import('libphonenumber-js').catch(() => null);
if (!lpn) {
  fail(
    'libphonenumber-js did not resolve, so 243 dial codes went unchecked against ' +
      'Google’s metadata. It is a root devDependency — run `pnpm install`. Do not ' +
      'delete this check to make the message go away; it is the only independent ' +
      'authority this list has.',
  );
} else {
  const known = new Set(lpn.getCountries());
  for (const c of COUNTRIES) {
    // PN (Pitcairn) has no libphonenumber metadata of its own — it is dialled
    // on New Zealand's plan, which SHARED_DIAL[64] already states.
    if (!known.has(c.code)) continue;
    const theirs = String(lpn.getCountryCallingCode(c.code));
    if (theirs !== c.dial) {
      fail(
        `${c.code} (${c.en}): this list says +${c.dial}, libphonenumber says +${theirs}. ` +
          'Assume the list is wrong — a code no carrier routes is a lead lost in silence.',
      );
    }
  }
  // The reverse direction: a country Google can dial and this list does not
  // offer is a country a library cannot apply from.
  for (const code of known) {
    if (seen.has(code) || code in NO_PHONE || NOT_ASSIGNED.has(code)) continue;
    fail(`libphonenumber can dial ${code} but this list does not offer it.`);
  }
}

// --- 3. nothing was forgotten ----------------------------------------------
//
// Enumerating ICU is not how the list is built — ICU knows 280 regions, most of
// the extras not countries at all — but it is how the list is audited. Every
// region ICU knows must be accounted for by name, so a country left out of the
// dial map cannot pass unnoticed.
const unclassified = [];
for (let a = 65; a <= 90; a++) {
  for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    if (!NAMES.en.of(code)) continue;
    if (seen.has(code) || code in NO_PHONE || NOT_ASSIGNED.has(code)) continue;
    unclassified.push(`${code} (${NAMES.en.of(code)})`);
  }
}
if (unclassified.length) {
  fail(
    `${unclassified.length} region(s) ICU knows are in neither the list nor either exclusion:\n` +
      unclassified.map((u) => `      ${u}`).join('\n') +
      '\n    Add each to countries.ts with its dial code, or to NO_PHONE / NOT_ASSIGNED here ' +
      'with the reason.',
  );
}

const accounted = COUNTRIES.length + Object.keys(NO_PHONE).length;
if (accounted !== ASSIGNED_ALPHA2) {
  fail(
    `${COUNTRIES.length} countries + ${Object.keys(NO_PHONE).length} deliberately omitted = ` +
      `${accounted}, but ISO assigns ${ASSIGNED_ALPHA2} alpha-2 codes. One side has drifted.`,
  );
}

// --- 4. the codes a reader would catch by eye -------------------------------
for (const [code, dial] of Object.entries(KNOWN)) {
  const found = findCountry(code);
  if (!found) fail(`${code} is missing from the list entirely.`);
  else if (found.dial !== dial) fail(`${code}: expected +${dial}, list says +${found.dial}.`);
}
if (findCountry('GR')?.dial !== '30') fail('Greece must be +30 — it is the whole customer base.');
if (findCountry('CY')?.dial !== '357') fail('Cyprus must be +357 — it is the second market.');

// --- 5. the rendered order --------------------------------------------------
const wrapped = (list) => {
  const lines = [];
  for (let i = 0; i < list.length; i += 24) lines.push('  ' + list.slice(i, i + 24).join(' '));
  return lines.join('\n');
};

for (const lang of ['el', 'en']) {
  const ordered = countriesFor(lang);

  if (ordered.length !== COUNTRIES.length) {
    fail(`countriesFor('${lang}') returns ${ordered.length} of ${COUNTRIES.length} countries.`);
  }
  if (new Set(ordered.map((c) => c.code)).size !== ordered.length) {
    fail(`countriesFor('${lang}') lists a country twice — a <select> with two options per value.`);
  }
  const head = ordered.slice(0, PRIORITY_COUNTRY_CODES.length).map((c) => c.code);
  if (head.join(' ') !== [...PRIORITY_COUNTRY_CODES].join(' ')) {
    fail(
      `countriesFor('${lang}') opens with ${head.join(' ')}, not ${PRIORITY_COUNTRY_CODES.join(' ')}.`,
    );
  }

  // The committed order must still be this locale's collation. Names and order
  // are frozen together; a CLDR rename moves a country in the list as well.
  const collator = new Intl.Collator(lang, { usage: 'sort' });
  const expected = COUNTRIES.filter((c) => !PRIORITY_COUNTRY_CODES.includes(c.code))
    .sort((x, y) => collator.compare(x[lang], y[lang]) || x.code.localeCompare(y.code))
    .map((c) => c.code);
  const actual = ordered.slice(PRIORITY_COUNTRY_CODES.length).map((c) => c.code);
  if (actual.join(' ') !== expected.join(' ')) {
    const all = COUNTRIES.map((c) => c.code).sort((x, y) => {
      const cx = findCountry(x)[lang];
      const cy = findCountry(y)[lang];
      return collator.compare(cx, cy) || x.localeCompare(y);
    });
    fail(
      `the committed ${lang} order is not this ICU's collation. Replace ORDER.${lang} in ` +
        `packages/shared/src/countries.ts with:\n${wrapped(all)}`,
    );
  }
}

// --- 6. the accessors the form depends on -----------------------------------
if (!findCountry(DEFAULT_COUNTRY_CODE))
  fail(`DEFAULT_COUNTRY_CODE '${DEFAULT_COUNTRY_CODE}' is not in the list.`);
for (const code of PRIORITY_COUNTRY_CODES) {
  if (!findCountry(code)) fail(`PRIORITY_COUNTRY_CODES pins '${code}', which is not in the list.`);
}
// The API validates an untrusted string with this before storing it.
for (const junk of ['', 'gr', 'GRC', 'XX', '30', ' GR']) {
  if (isCountryCode(junk)) fail(`isCountryCode() accepted ${JSON.stringify(junk)}.`);
}
if (!isCountryCode('GR')) fail("isCountryCode() rejected 'GR'.");

if (problems.length) {
  console.error(`✗ packages/shared/src/countries.ts: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`    ${p}`);
  console.error(
    '\nThis list is written from knowledge and cannot be re-fetched. A wrong digit ships a\n' +
      'country whose applicants leave a phone number nobody can dial.',
  );
  process.exit(1);
}

const shared = Object.keys(SHARED_DIAL).length;
console.log(
  `country check passed: ${COUNTRIES.length} countries + ${Object.keys(NO_PHONE).length} ` +
    `deliberately omitted = ${ASSIGNED_ALPHA2} assigned alpha-2 codes; ` +
    `${byDial.size} distinct dial codes with ${shared} declared shared plans, ` +
    `every one of them agreeing with libphonenumber; ` +
    `every name matches ICU in el and en; both display orders match ICU collation.`,
);
