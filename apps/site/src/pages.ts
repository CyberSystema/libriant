/**
 * Page bodies for the Libriant marketing site.
 *
 * Shared by `build.ts` (writes the static pages) and `src/worker.ts` (re-renders
 * the home page with validation errors and the visitor's own answers preserved).
 * That sharing is the point: a visitor with JavaScript disabled who submits an
 * incomplete form gets the real page back with inline errors, not a bare
 * browser error — and there is only one copy of the form markup to maintain.
 */

import { countriesFor, DEFAULT_COUNTRY_CODE } from '@libriant/shared/countries';
import {
  esc,
  renderShell,
  localePath,
  NAV as NAV_FOR_404,
  type Lang,
  type SiteConfig,
} from './shell.js';
import { HOME, FORM, THANKS, NOT_FOUND, LIBRARY_TYPE_OPTIONS } from './copy.js';
import { publicPlans, num, storageLabel, priceLabel } from './plans.js';

export { LIBRARY_TYPE_OPTIONS };

/** The six capability blurbs, read from `locales/el/landing.json` at build time. */
export type LandingCopy = Record<string, string>;

export type FieldErrors = Partial<Record<string, string>>;
export type FieldValues = Partial<Record<string, string>>;

export type RenderOptions = {
  draft?: boolean;
  errors?: FieldErrors;
  values?: FieldValues;
  /** Summary shown above the form when a submission was rejected. */
  formError?: string;
  /** Defaults to Greek — the site's primary language. */
  lang?: Lang;
  /**
   * Replace the form with the waiting-list notice.
   *
   * Only the API passes this, and only because it has just counted the
   * accepted applications (launch-readiness-11). The static build never does:
   * a file written at deploy time cannot know whether the fifth place went
   * this morning, and the version of this switch that read
   * `offer.spotsRemaining` pretended otherwise.
   */
  offerClosed?: boolean;
};

/**
 * Line icons for the six feature cards, reusing the exact path geometry from the
 * app's own landing page (`apps/web/app/[locale]/page.tsx`) so the two pages
 * stay visually identical. `currentColor` + no fill; the stroke is set in CSS.
 */
const ICONS: Record<string, string> = {
  catalog: `<path d="M12 6.5C10.5 5 7.5 5 4 5.5v13c3.5-.5 6.5-.5 8 1 1.5-1.5 4.5-1.5 8-1v-13c-3.5-.5-6.5-.5-8 1Z"/><path d="M12 6.5v13"/>`,
  circulation: `<path d="M4 9h12"/><path d="M13 6l3 3-3 3"/><path d="M20 15H8"/><path d="M11 18l-3-3 3-3"/>`,
  members: `<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6"/><path d="M20.5 19a5.5 5.5 0 0 0-4-5.3"/>`,
  reservations: `<path d="M6.5 4h11a1 1 0 0 1 1 1v15l-6.5-4-6.5 4V5a1 1 0 0 1 1-1Z"/>`,
  import: `<path d="M12 3v10"/><path d="M8 9l4 4 4-4"/><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"/>`,
  bilingual: `<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.4 4 5.6 4 9s-1.5 6.6-4 9c-2.5-2.4-4-5.6-4-9 0-3.4 1.5-6.6 4-9Z"/>`,
};

const FEATURE_KEYS = [
  'catalog',
  'circulation',
  'members',
  'reservations',
  'import',
  'bilingual',
] as const;

function icon(key: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[key] ?? ''}</svg>`;
}

/** A labelled input with optional inline error, preserving a prior value. */
function field(opts: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  hint?: string;
  autocomplete?: string;
  values: FieldValues;
  errors: FieldErrors;
  inputmode?: string;
}): string {
  const err = opts.errors[opts.name];
  const val = opts.values[opts.name] ?? '';
  const id = `f-${opts.name}`;
  const describedBy = [err ? `${id}-err` : '', opts.hint ? `${id}-hint` : ''].filter(Boolean);
  return `<div class="field">
  <label for="${id}">${esc(opts.label)}${opts.required ? '<span class="req" aria-hidden="true">*</span>' : ''}</label>
  <input id="${id}" name="${esc(opts.name)}" type="${esc(opts.type ?? 'text')}"
    value="${esc(val)}"${opts.required ? ' required' : ''}
    ${opts.autocomplete ? `autocomplete="${esc(opts.autocomplete)}"` : ''}
    ${opts.inputmode ? `inputmode="${esc(opts.inputmode)}"` : ''}
    ${err ? ` aria-invalid="true"` : ''}
    ${describedBy.length ? ` aria-describedby="${describedBy.join(' ')}"` : ''}>
  ${opts.hint ? `<p class="hint" id="${id}-hint">${esc(opts.hint)}</p>` : ''}
  ${err ? `<p class="field-error" id="${id}-err">${esc(err)}</p>` : ''}
</div>`;
}

type Choice = { value: string; label: string };

/** `<option>` rows, with the visitor's own answer marked selected. */
function options(list: ReadonlyArray<Choice>, selected: string): string {
  return list
    .map(
      (o) =>
        `<option value="${esc(o.value)}"${o.value === selected ? ' selected' : ''}>${esc(o.label)}</option>`,
    )
    .join('\n        ');
}

/**
 * A labelled select, in the shape `field()` gives an input.
 *
 * Written the day the form went from one select to three. The hand-rolled
 * `libraryType` block this replaces had already drifted from `field()` — its
 * error paragraph had no id and the control never pointed at it — so a screen
 * reader announced the field as invalid without reading why. Two more
 * hand-rolled copies would have been two more places to fix that.
 */
function select(opts: {
  name: string;
  label: string;
  choices: ReadonlyArray<Choice>;
  /** Leading empty option, for a question the visitor must answer deliberately. */
  placeholder?: string;
  required?: boolean;
  autocomplete?: string;
  values: FieldValues;
  errors: FieldErrors;
}): string {
  const err = opts.errors[opts.name];
  const id = `f-${opts.name}`;
  return `<div class="field">
  <label for="${id}">${esc(opts.label)}${opts.required ? '<span class="req" aria-hidden="true">*</span>' : ''}</label>
  <select id="${id}" name="${esc(opts.name)}"${opts.required ? ' required' : ''}
    ${opts.autocomplete ? `autocomplete="${esc(opts.autocomplete)}"` : ''}
    ${err ? ` aria-invalid="true" aria-describedby="${id}-err"` : ''}>
    ${opts.placeholder ? `<option value="">${esc(opts.placeholder)}</option>` : ''}
    ${options(opts.choices, opts.values[opts.name] ?? '')}
  </select>
  ${err ? `<p class="field-error" id="${id}-err">${esc(err)}</p>` : ''}
</div>`;
}

/**
 * Phone: one field wearing two controls.
 *
 * The dial code cannot follow the country select — that needs JavaScript, and
 * this site ships none — so it is a second, separate question and the markup
 * says so instead of pretending otherwise. What holds the pair together is the
 * labelling: the visible label names the pair and is attached to the number,
 * the hint under it says the code is chosen separately, and the select carries
 * its own name for a screen reader, which would otherwise reach an unnamed list
 * of 243 options. That name is a real `<label>`, clipped by `.visually-hidden`
 * rather than an `aria-label`, so every control in this form is labelled the
 * same way.
 *
 * The dial select opens on Greece. The country select above deliberately does
 * not: a country is a claim about the applicant that we should not make for
 * them, and a wrong one ends up on a Data Processing Agreement. A dial code is
 * different — it sits in plain sight beside the number being typed, this
 * campaign is addressed to 277 Greek libraries, and an empty option here would
 * be a third «Επιλέξτε…» to clear before the form will send.
 *
 * Its value is the ISO country code and NOT the digits, because 25 countries
 * share +1: a select whose options do not distinguish the answers cannot give
 * the applicant back the one they picked when the form comes round again. The
 * API turns the code into digits with `findCountry()`.
 */
function phoneField(opts: {
  label: string;
  hint: string;
  dialLabel: string;
  dialChoices: ReadonlyArray<Choice>;
  values: FieldValues;
  errors: FieldErrors;
}): string {
  const err = opts.errors.phone;
  const dialErr = opts.errors.phoneDialCode;
  const describedBy = [err ? 'f-phone-err' : '', 'f-phone-hint'].filter(Boolean);
  // The hint — "the country code is chosen separately, in the field before the
  // number" — is described by BOTH controls. It was attached only to the number
  // input, which follows the select in DOM and tab order, so the sentence
  // explaining why there are two controls arrived after the control it
  // explains. No `required` on the select: it carries no empty option and a
  // native select cannot be cleared, so the attribute can never fire and only
  // announces a constraint the visitor cannot violate. The server still refuses
  // an empty one — it just calls it a malformed submission, not a mistake.
  const dialDescribedBy = [dialErr ? 'f-phoneDialCode-err' : '', 'f-phone-hint'].filter(Boolean);
  return `<div class="field">
  <label for="f-phone">${esc(opts.label)}<span class="req" aria-hidden="true">*</span></label>
  <div class="field-pair">
    <label class="visually-hidden" for="f-phoneDialCode">${esc(opts.dialLabel)}</label>
    <select id="f-phoneDialCode" name="phoneDialCode" autocomplete="tel-country-code"
      ${dialErr ? ` aria-invalid="true"` : ''} aria-describedby="${dialDescribedBy.join(' ')}">
      ${options(opts.dialChoices, opts.values.phoneDialCode || DEFAULT_COUNTRY_CODE)}
    </select>
    <input id="f-phone" name="phone" type="tel" value="${esc(opts.values.phone ?? '')}" required
      autocomplete="tel-national"${err ? ' aria-invalid="true"' : ''}
      aria-describedby="${describedBy.join(' ')}">
  </div>
  <p class="hint" id="f-phone-hint">${esc(opts.hint)}</p>
  ${dialErr ? `<p class="field-error" id="f-phoneDialCode-err">${esc(dialErr)}</p>` : ''}
  ${err ? `<p class="field-error" id="f-phone-err">${esc(err)}</p>` : ''}
</div>`;
}

function textarea(opts: {
  name: string;
  label: string;
  hint?: string;
  values: FieldValues;
  errors: FieldErrors;
}): string {
  const err = opts.errors[opts.name];
  const id = `f-${opts.name}`;
  return `<div class="field">
  <label for="${id}">${esc(opts.label)}</label>
  <textarea id="${id}" name="${esc(opts.name)}"${err ? ' aria-invalid="true"' : ''}
    ${opts.hint ? `aria-describedby="${id}-hint"` : ''}>${esc(opts.values[opts.name] ?? '')}</textarea>
  ${opts.hint ? `<p class="hint" id="${id}-hint">${esc(opts.hint)}</p>` : ''}
  ${err ? `<p class="field-error">${esc(err)}</p>` : ''}
</div>`;
}

/**
 * The order the error summary lists failures in — the order the fields are laid
 * out below, so the summary reads down the form rather than in whatever order
 * the API's validation happened to set them. Every name here is also the `id`
 * suffix of a real control, which is what makes each entry a working link.
 */
const ERROR_FIELD_ORDER = [
  'libraryName',
  'libraryType',
  'city',
  'country',
  'collectionSize',
  'currentSystem',
  'contactName',
  'contactEmail',
  'phoneDialCode',
  'phone',
  'message',
  'consent',
] as const;

function applicationForm(c: SiteConfig, o: RenderOptions, lang: Lang): string {
  const f = FORM[lang];
  const errors = o.errors ?? {};
  const values = o.values ?? {};

  // Every country, twice: once to be answered and once to be dialled. Both
  // lists are `countriesFor(lang)`, so the two selects run in the same order
  // and a visitor who scrolled to Κύπρος in one finds it in the same place in
  // the other.
  //
  // The dial label leads with the NAME, not the code. It led with the code
  // first, on the argument that the code is the part worth keeping when a
  // narrow control clips the text — but both lists are ordered by country name,
  // and a native select's type-ahead matches the option's text PREFIX. With
  // every label starting with '+', pressing Ι did not jump to Ιταλία; nothing
  // matched, and the only way through 243 options was to arrow down all of
  // them. That is the whole control gone for a keyboard or screen-reader user,
  // to save a sighted one a few clipped letters of a country they just chose in
  // the field above. Name-first also makes the two selects behave identically,
  // which is the point of their being the same list in the same order.
  const countries = countriesFor(lang);
  const countryChoices = countries.map((c) => ({ value: c.code, label: c[lang] }));
  const dialChoices = countries.map((c) => ({ value: c.code, label: `${c[lang]} (+${c.dial})` }));

  // The error summary, and the reason the form's action carries `#form-error`.
  //
  // A rejected submission comes back as the whole home page, and a browser
  // renders it from the top — so the visitor landed on the hero with the reason
  // they were bounced six screens below, looking at what appeared to be the
  // page they had already filled in. `role="alert"` did not save it either:
  // live regions announce on DOM mutation, and this markup is present at
  // document load, so no screen reader ever spoke it. The `tabindex="-1"` here
  // had never once been used.
  //
  // The fix is the fragment on the action below: the 400 is a response to a URL
  // ending `#form-error`, so the browser scrolls here AND — because of that
  // tabindex — puts focus on this div. A screen reader reads the heading, and
  // the next Tab walks into the form. No JavaScript, which is the only kind of
  // fix available here. The 303s in applications.controller.ts name their own
  // fragment for the same reason: a redirect inherits the request URL's.
  //
  // Each failing field gets its own link. One generic sentence was tolerable at
  // five required fields; a blank submission can now raise eight errors, and a
  // list of links is the standard no-JS way to get a keyboard user to each one
  // in a single hop. The generic sentence stays as the fallback for the errors
  // that belong to no field — a rate-limit refusal, a failed save.
  const listed = ERROR_FIELD_ORDER.filter((name) => errors[name]);
  const summary = o.formError
    ? `<div class="form-error" role="alert" tabindex="-1" id="form-error">
    <strong>${esc(f.errorTitle)}</strong>
    <ul>${
      listed.length
        ? listed
            .map((name) => `<li><a href="#f-${name}">${esc(errors[name] ?? '')}</a></li>`)
            .join('')
        : `<li>${esc(o.formError)}</li>`
    }</ul>
  </div>`
    : '';

  return `<form class="form-card" method="post" action="${localePath(lang, '/apply')}#form-error" novalidate id="application-form">
  ${summary}
  <p class="hint required-note">${esc(f.requiredNote)}</p>
  <div class="grid2">
    ${field({ name: 'libraryName', label: f.libraryName, required: true, values, errors, autocomplete: 'organization' })}
    ${select({ name: 'libraryType', label: f.libraryType, choices: LIBRARY_TYPE_OPTIONS[lang], placeholder: f.choose, required: true, values, errors })}
  </div>
  <div class="grid2">
    ${field({ name: 'city', label: f.city, required: true, values, errors, autocomplete: 'address-level2' })}
    ${select({ name: 'country', label: f.country, choices: countryChoices, placeholder: f.choose, required: true, autocomplete: 'country', values, errors })}
  </div>
  <div class="grid2">
    ${field({ name: 'collectionSize', label: f.collectionSize, values, errors, hint: f.collectionSizeHint, inputmode: 'numeric' })}
    ${field({ name: 'currentSystem', label: f.currentSystem, values, errors, hint: f.currentSystemHint })}
  </div>
  <div class="grid2">
    ${field({ name: 'contactName', label: f.contactName, required: true, values, errors, autocomplete: 'name' })}
    ${field({ name: 'contactEmail', label: f.contactEmail, type: 'email', required: true, values, errors, autocomplete: 'email' })}
  </div>
  ${phoneField({ label: f.phone, hint: f.phoneHint, dialLabel: f.phoneDialCode, dialChoices, values, errors })}
  ${textarea({ name: 'message', label: f.message, values, errors, hint: f.messageHint })}

  <div class="hp" aria-hidden="true">
    <label for="f-website">${esc(f.honeypot)}</label>
    <input id="f-website" name="website" type="text" tabindex="-1" autocomplete="off">
  </div>


  <div class="consent">
    <input type="checkbox" id="f-consent" name="consent" value="yes" required${values.consent === 'yes' ? ' checked' : ''}${errors.consent ? ' aria-invalid="true" aria-describedby="f-consent-err"' : ''}>
    <label for="f-consent">${esc(f.consentBefore)}<a href="${localePath(lang, '/privacy')}">${esc(f.consentLink)}</a>${f.consentAfter}<span class="req" aria-hidden="true">*</span></label>
  </div>
  ${errors.consent ? `<p class="field-error consent-error" id="f-consent-err">${esc(errors.consent)}</p>` : ''}

  <div class="form-actions">
    <button type="submit" class="btn btn--primary btn--lg">${esc(f.submit)}</button>
    <span class="hint" style="margin:0">${esc(f.replyPromise)}</span>
  </div>
</form>`;
}

function closedNotice(c: SiteConfig, lang: Lang): string {
  const f = FORM[lang];
  return `<div class="closed">
  <h2>${esc(f.closedTitle(c.offer.spotsTotal))}</h2>
  <p>${esc(f.closedBody)}</p>
  <p>${f.closedContact(esc(c.identity.contactEmail))}</p>
</div>`;
}

export function renderIndex(c: SiteConfig, copy: LandingCopy, o: RenderOptions = {}): string {
  const lang: Lang = o.lang ?? 'el';
  const h = HOME[lang];
  const open = !o.offerClosed;
  const entry = priceLabel(c.offer.entryMonthlyPriceEur, lang);
  const planned = priceLabel(c.offer.plannedMonthlyPriceEur, lang);

  // The offer panel used to hardcode «30.000 τίτλοι · 7.500 μέλη · …». Those are
  // the Municipal caps, so read them from the plan the offer actually grants —
  // a cap change in seed-data.ts can no longer leave this paragraph behind.
  const offerPlan = publicPlans(lang).find(
    (p) => p.name.toLowerCase() === c.offer.planName.toLowerCase(),
  );
  const caps = offerPlan
    ? [
        `${num(Number(offerPlan.features.max_books), lang)} ${lang === 'el' ? 'τίτλοι' : 'titles'}`,
        `${num(Number(offerPlan.features.max_members), lang)} ${lang === 'el' ? 'μέλη' : 'members'}`,
        `${num(Number(offerPlan.features.staff_seats), lang)} ${lang === 'el' ? 'λογαριασμοί προσωπικού' : 'staff seats'}`,
        `${storageLabel(Number(offerPlan.features.max_storage_mb), lang)} ${lang === 'el' ? 'για αρχεία' : 'for files'}`,
        lang === 'el' ? 'κρατήσεις και ουρά κρατήσεων' : 'holds and hold queue',
        lang === 'el'
          ? 'μαζική εισαγωγή από CSV, Excel ή MARC'
          : 'bulk import from CSV, Excel or MARC',
        lang === 'el' ? 'ειδοποιήσεις email' : 'email notifications',
        lang === 'el' ? 'συμπλήρωση στοιχείων με ISBN' : 'fill in details by ISBN',
        lang === 'el'
          ? 'δικά σας πεδία σε κάθε είδος εγγραφής'
          : 'custom fields on every record kind',
      ].join(' · ')
    : '';

  const features = FEATURE_KEYS.map(
    (k) => `<article class="feature">
    <div class="feature__icon">${icon(k)}</div>
    <h3>${esc(copy[`features.${k}.title`] ?? '')}</h3>
    <p>${esc(copy[`features.${k}.body`] ?? '')}</p>
  </article>`,
  ).join('\n  ');

  // The first offer tile used to read «N θέσεις διαθέσιμες» over a number fed by
  // a literal in site.config.json that nothing ever decremented, so the sixth
  // applicant was told five places remained (launch-readiness-11). It states the
  // SIZE of the offer now — a claim no application can falsify, and the only
  // kind a file written at deploy time is in a position to make. Built here
  // rather than inline below so this explanation does not ship to visitors as an
  // HTML comment.
  const spotsTile = `<div class="stat"><span class="stat__num">${esc(c.offer.spotsTotal)}</span><span class="stat__label">${esc(h.statSpots)}</span></div>`;

  const body = `<section class="hero">
  <div class="wrap"><div class="hero__inner">
    <p class="eyebrow">${esc(copy['hero.eyebrow'] ?? h.heroEyebrow)}</p>
    <h1>${esc(copy['hero.title'] ?? '')}</h1>
    <p class="hero__sub">${esc(copy['hero.subtitle'] ?? '')}</p>
    <div class="hero__actions">
      <a href="#apply" class="btn btn--primary btn--lg">${esc(open ? h.heroCtaOpen(c.offer.spotsTotal) : h.heroCtaClosed)}</a>
      <a href="#what-it-does" class="btn btn--ghost btn--lg">${esc(h.heroSecondary)}</a>
    </div>
    <p class="hero__note">${esc(open ? h.heroNoteOpen(c.offer.spotsTotal) : h.heroNoteClosed)}</p>
  </div></div>
</section>

<section class="offer" id="prosfora" aria-labelledby="offer-title">
  <div class="wrap">
    <div class="offer__card">
      <span class="offer__badge">${esc(h.offerBadge)}</span>
      <h2 id="offer-title">${esc(h.offerTitle(c.offer.spotsTotal))}</h2>
      <p class="offer__lede">${esc(h.offerLede(c.offer.spotsTotal, c.offer.planName, c.offer.months))}</p>
      <div class="offer__grid">
        ${spotsTile}
        <div class="stat"><span class="stat__num">${esc(h.statMonths(c.offer.months))}</span><span class="stat__label">${esc(h.statMonthsLabel)}</span></div>
        <div class="stat"><span class="stat__num">${esc(h.statFree)}</span><span class="stat__label">${esc(h.statFreeLabel)}</span></div>
        <div class="stat"><span class="stat__num">${esc(h.statFrom(entry))}</span><span class="stat__label">${esc(h.statFromLabel)}</span></div>
      </div>
      <div class="offer__caps">
        <strong>${esc(h.capsIntro(c.offer.planName))}</strong>
        ${esc(caps)}.
      </div>
      <p class="offer__fine" style="margin-top:18px">
        ${h.offerFine(c.offer.months, esc(entry), esc(c.offer.planName), esc(planned))}
      </p>
    </div>
  </div>
</section>

<section class="alt" id="what-it-does" aria-labelledby="features-title">
  <div class="wrap">
    <div class="section-head">
      <h2 id="features-title">${esc(copy['features.title'] ?? h.featuresFallback)}</h2>
      <p>${esc(copy['features.subtitle'] ?? '')}</p>
    </div>
    <div class="features">
  ${features}
    </div>
  </div>
</section>

<section id="how-it-works" aria-labelledby="how-title">
  <div class="wrap">
    <div class="section-head">
      <h2 id="how-title">${esc(h.howTitle)}</h2>
      <p>${esc(h.howSubtitle)}</p>
    </div>
    <div class="steps">
      ${h.steps
        .map(
          (st) => `<div class="step">
        <h3>${esc(st.title)}</h3>
        <p>${esc(st.body)}</p>
      </div>`,
        )
        .join('\n      ')}
    </div>
  </div>
</section>

<section class="alt" aria-labelledby="trust-title">
  <div class="wrap">
    <div class="section-head">
      <h2 id="trust-title">${esc(h.trustTitle)}</h2>
      <p>${esc(h.trustSubtitle)}</p>
    </div>
    <ul class="trust">
      ${h.trust.map((it) => `<li><strong>${esc(it.title)}</strong> ${esc(it.body)}</li>`).join('\n      ')}
    </ul>
  </div>
</section>

<section class="form-section" id="apply" aria-labelledby="apply-title">
  <div class="wrap">
    <div class="section-head">
      <h2 id="apply-title">${esc(open ? h.applyTitle : h.waitlistTitle)}</h2>
      <p>${esc(open ? h.applySubtitle : h.waitlistSubtitle)}</p>
    </div>
    ${open ? applicationForm(c, o, lang) : closedNotice(c, lang)}
  </div>
</section>`;

  return renderShell({
    title: h.metaTitle,
    description: h.metaDescription(c.offer.spotsTotal),
    path: localePath(lang, '/'),
    lang,
    body,
    config: c,
    draft: o.draft,
  });
}

export function renderThanks(c: SiteConfig, draft?: boolean, lang: Lang = 'el'): string {
  const k = THANKS[lang];
  const contact = esc(c.identity.contactEmail);
  const privacy = esc(c.identity.privacyEmail);
  const body = `<div class="page-head"><div class="wrap"><h1>${esc(k.h1)}</h1></div></div>
<div class="page-body"><div class="wrap"><div class="prose">
  <p>${esc(k.received)}</p>
  <h2>${esc(k.nextTitle)}</h2>
  <ol>
    ${k.steps.map((st) => `<li>${st}</li>`).join('\n    ')}
  </ol>
  <p>${k.spam(contact)}</p>
  <h2>${esc(k.meanwhileTitle)}</h2>
  <p>${k.meanwhile}</p>
  <h2>${esc(k.changedTitle)}</h2>
  <p>${k.changed(privacy)}</p>
  <p><a href="${localePath(lang, '/')}">${esc(k.back)}</a></p>
</div></div></div>`;
  return renderShell({
    title: k.title,
    description: k.metaDescription,
    path: localePath(lang, '/thank-you'),
    lang,
    body,
    config: c,
    draft,
  });
}

export function renderDoc(
  c: SiteConfig,
  o: {
    title: string;
    path: string;
    description: string;
    html: string;
    draft?: boolean;
    lang?: Lang;
  },
): string {
  const lang: Lang = o.lang ?? 'el';
  const body = `<div class="page-head"><div class="wrap"><h1>${esc(o.title)}</h1></div></div>
<div class="page-body"><div class="wrap"><div class="prose">
${o.html}
</div></div></div>`;
  return renderShell({
    title: `${o.title} — Libriant`,
    description: o.description,
    path: o.path,
    lang,
    body,
    config: c,
    draft: o.draft,
  });
}

export function render404(c: SiteConfig, draft?: boolean, lang: Lang = 'el'): string {
  const nf = NOT_FOUND[lang];
  const links = [...NAV_FOR_404[lang], { path: '/#apply', label: nf.apply }];
  const body = `<div class="page-head"><div class="wrap"><h1>${esc(nf.h1)}</h1></div></div>
<div class="page-body"><div class="wrap"><div class="prose">
  <p>${nf.lede}</p>
  <ul>
    ${links.map((l) => `<li><a href="${localePath(lang, l.path)}">${esc(l.label)}</a></li>`).join('\n    ')}
  </ul>
</div></div></div>`;
  return renderShell({
    title: nf.title,
    description: nf.h1,
    path: localePath(lang, '/404'),
    lang,
    body,
    config: c,
    draft,
  });
}
