/**
 * Page bodies for the Libriant marketing site.
 *
 * Shared by `build.ts` (writes the static pages) and `src/worker.ts` (re-renders
 * the home page with validation errors and the visitor's own answers preserved).
 * That sharing is the point: a visitor with JavaScript disabled who submits an
 * incomplete form gets the real page back with inline errors, not a bare
 * browser error — and there is only one copy of the form markup to maintain.
 */

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

function applicationForm(c: SiteConfig, o: RenderOptions, lang: Lang): string {
  const f = FORM[lang];
  const errors = o.errors ?? {};
  const values = o.values ?? {};
  const turnstile = c.site.turnstileSiteKey
    ? `<div class="cf-turnstile" data-sitekey="${esc(c.site.turnstileSiteKey)}" data-language="${lang}"></div>`
    : '';

  const typeOptions = LIBRARY_TYPE_OPTIONS[lang]
    .map(
      (t) =>
        `<option value="${esc(t.value)}"${values.libraryType === t.value ? ' selected' : ''}>${esc(t.label)}</option>`,
    )
    .join('\n      ');

  const summary = o.formError
    ? `<div class="form-error" role="alert" tabindex="-1" id="form-error">
    <strong>${esc(f.errorTitle)}</strong>
    <ul><li>${esc(o.formError)}</li></ul>
  </div>`
    : '';

  return `<form class="form-card" method="post" action="${localePath(lang, '/apply')}" novalidate id="application-form">
  ${summary}
  <div class="grid2">
    ${field({ name: 'libraryName', label: f.libraryName, required: true, values, errors, autocomplete: 'organization' })}
    <div class="field">
      <label for="f-libraryType">${esc(f.libraryType)}<span class="req" aria-hidden="true">*</span></label>
      <select id="f-libraryType" name="libraryType" required${errors.libraryType ? ' aria-invalid="true"' : ''}>
        <option value="">${esc(f.choose)}</option>
        ${typeOptions}
      </select>
      ${errors.libraryType ? `<p class="field-error">${esc(errors.libraryType)}</p>` : ''}
    </div>
  </div>
  <div class="grid2">
    ${field({ name: 'city', label: f.city, required: true, values, errors, autocomplete: 'address-level2' })}
    ${field({ name: 'collectionSize', label: f.collectionSize, values, errors, hint: f.collectionSizeHint, inputmode: 'numeric' })}
  </div>
  <div class="grid2">
    ${field({ name: 'contactName', label: f.contactName, required: true, values, errors, autocomplete: 'name' })}
    ${field({ name: 'contactEmail', label: f.contactEmail, type: 'email', required: true, values, errors, autocomplete: 'email' })}
  </div>
  <div class="grid2">
    ${field({ name: 'phone', label: f.phone, type: 'tel', values, errors, autocomplete: 'tel', hint: f.optional })}
    ${field({ name: 'currentSystem', label: f.currentSystem, values, errors, hint: f.currentSystemHint })}
  </div>
  ${textarea({ name: 'message', label: f.message, values, errors, hint: f.messageHint })}

  <div class="hp" aria-hidden="true">
    <label for="f-website">${esc(f.honeypot)}</label>
    <input id="f-website" name="website" type="text" tabindex="-1" autocomplete="off">
  </div>

  ${turnstile}

  <div class="consent">
    <input type="checkbox" id="f-consent" name="consent" value="yes" required${values.consent === 'yes' ? ' checked' : ''}${errors.consent ? ' aria-invalid="true"' : ''}>
    <label for="f-consent">${esc(f.consentBefore)}<a href="${localePath(lang, '/privacy')}">${esc(f.consentLink)}</a>${f.consentAfter}<span class="req" aria-hidden="true">*</span></label>
  </div>
  ${errors.consent ? `<p class="field-error" style="margin-top:-16px;margin-bottom:20px">${esc(errors.consent)}</p>` : ''}

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
  const open = c.offer.spotsRemaining > 0;
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
        <div class="stat"><span class="stat__num">${esc(c.offer.spotsRemaining)}</span><span class="stat__label">${esc(h.statSpots(c.offer.spotsRemaining, c.offer.spotsTotal))}</span></div>
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
