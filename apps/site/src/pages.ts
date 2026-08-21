/**
 * Page bodies for the Libriant marketing site.
 *
 * Shared by `build.ts` (writes the static pages) and `src/worker.ts` (re-renders
 * the home page with validation errors and the visitor's own answers preserved).
 * That sharing is the point: a visitor with JavaScript disabled who submits an
 * incomplete form gets the real page back with inline errors, not a bare
 * browser error — and there is only one copy of the form markup to maintain.
 */

import { esc, renderShell, type SiteConfig } from './shell.js';

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
};

/** Library types, mirrored from `packages/shared/src/library.ts` + `locales/el/library.json`. */
export const LIBRARY_TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'public', label: 'Δημόσια ή δημοτική βιβλιοθήκη' },
  { value: 'academic', label: 'Ακαδημαϊκή βιβλιοθήκη (ΑΕΙ ή ερευνητικού φορέα)' },
  { value: 'school', label: 'Σχολική βιβλιοθήκη' },
  { value: 'special', label: 'Ειδική βιβλιοθήκη (φορέα, ιδρύματος, συλλόγου)' },
  { value: 'community', label: 'Κοινοτική ή λαϊκή βιβλιοθήκη' },
  { value: 'other', label: 'Άλλο' },
];

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

function applicationForm(c: SiteConfig, o: RenderOptions): string {
  const errors = o.errors ?? {};
  const values = o.values ?? {};
  const turnstile = c.site.turnstileSiteKey
    ? `<div class="cf-turnstile" data-sitekey="${esc(c.site.turnstileSiteKey)}" data-language="el"></div>`
    : '';

  const typeOptions = LIBRARY_TYPE_OPTIONS.map(
    (t) =>
      `<option value="${esc(t.value)}"${values.libraryType === t.value ? ' selected' : ''}>${esc(t.label)}</option>`,
  ).join('\n      ');

  const summary = o.formError
    ? `<div class="form-error" role="alert" tabindex="-1" id="form-error">
    <strong>Η αίτηση δεν στάλθηκε.</strong>
    <ul><li>${esc(o.formError)}</li></ul>
  </div>`
    : '';

  return `<form class="form-card" method="post" action="/apply" novalidate id="application-form">
  ${summary}
  <div class="grid2">
    ${field({ name: 'libraryName', label: 'Όνομα βιβλιοθήκης', required: true, values, errors, autocomplete: 'organization' })}
    <div class="field">
      <label for="f-libraryType">Τύπος βιβλιοθήκης<span class="req" aria-hidden="true">*</span></label>
      <select id="f-libraryType" name="libraryType" required${errors.libraryType ? ' aria-invalid="true"' : ''}>
        <option value="">Επιλέξτε…</option>
        ${typeOptions}
      </select>
      ${errors.libraryType ? `<p class="field-error">${esc(errors.libraryType)}</p>` : ''}
    </div>
  </div>
  <div class="grid2">
    ${field({ name: 'city', label: 'Πόλη / δήμος', required: true, values, errors, autocomplete: 'address-level2' })}
    ${field({ name: 'collectionSize', label: 'Περίπου πόσοι τίτλοι;', values, errors, hint: 'Μια χονδρική εκτίμηση αρκεί.', inputmode: 'numeric' })}
  </div>
  <div class="grid2">
    ${field({ name: 'contactName', label: 'Το όνομά σας', required: true, values, errors, autocomplete: 'name' })}
    ${field({ name: 'contactEmail', label: 'Email επικοινωνίας', type: 'email', required: true, values, errors, autocomplete: 'email' })}
  </div>
  <div class="grid2">
    ${field({ name: 'phone', label: 'Τηλέφωνο', type: 'tel', values, errors, autocomplete: 'tel', hint: 'Προαιρετικό.' })}
    ${field({ name: 'currentSystem', label: 'Τι χρησιμοποιείτε σήμερα;', values, errors, hint: 'π.χ. ΑΒΕΚΤ, Koha, φύλλο Excel, χειρόγραφο αρχείο — ή τίποτα ακόμη.' })}
  </div>
  ${textarea({ name: 'message', label: 'Θέλετε να μας πείτε κάτι άλλο;', values, errors, hint: 'Προαιρετικό — τι σας δυσκολεύει σήμερα, τι θα θέλατε να λύσει το Libriant.' })}

  <div class="hp" aria-hidden="true">
    <label for="f-website">Μη συμπληρώσετε αυτό το πεδίο</label>
    <input id="f-website" name="website" type="text" tabindex="-1" autocomplete="off">
  </div>

  ${turnstile}

  <div class="consent">
    <input type="checkbox" id="f-consent" name="consent" value="yes" required${values.consent === 'yes' ? ' checked' : ''}${errors.consent ? ' aria-invalid="true"' : ''}>
    <label for="f-consent">Διάβασα την <a href="/privacy">Πολιτική Απορρήτου</a> και κατανοώ ότι θα χρησιμοποιήσετε τα παραπάνω στοιχεία <strong>μόνο</strong> για να απαντήσετε στην αίτησή μου.<span class="req" aria-hidden="true">*</span></label>
  </div>
  ${errors.consent ? `<p class="field-error" style="margin-top:-16px;margin-bottom:20px">${esc(errors.consent)}</p>` : ''}

  <div class="form-actions">
    <button type="submit" class="btn btn--primary btn--lg">Στείλτε την αίτηση</button>
    <span class="hint" style="margin:0">Απαντάμε σε κάθε αίτηση εντός δύο εργάσιμων ημερών.</span>
  </div>
</form>`;
}

function closedNotice(c: SiteConfig): string {
  return `<div class="closed">
  <h2>Οι ${esc(c.offer.spotsTotal)} θέσεις συμπληρώθηκαν</h2>
  <p>Η προσφορά έναρξης ολοκληρώθηκε. Το Libriant παραμένει διαθέσιμο — επικοινωνήστε μαζί μας για τα τρέχοντα πακέτα.</p>
  <p>Για την επόμενη προσφορά ή για μια προσφορά στα μέτρα σας, στείλτε μας ένα email στο <a href="mailto:${esc(c.identity.contactEmail)}">${esc(c.identity.contactEmail)}</a> με το όνομα και την πόλη της βιβλιοθήκης σας. Θα σας ειδοποιήσουμε πρώτους.</p>
</div>`;
}

export function renderIndex(c: SiteConfig, copy: LandingCopy, o: RenderOptions = {}): string {
  const open = c.offer.spotsRemaining > 0;
  const price = c.offer.plannedMonthlyPriceEur;

  const features = FEATURE_KEYS.map(
    (k) => `<article class="feature">
    <div class="feature__icon">${icon(k)}</div>
    <h3>${esc(copy[`features.${k}.title`] ?? '')}</h3>
    <p>${esc(copy[`features.${k}.body`] ?? '')}</p>
  </article>`,
  ).join('\n  ');

  const body = `<section class="hero">
  <div class="wrap"><div class="hero__inner">
    <p class="eyebrow">${esc(copy['hero.eyebrow'] ?? 'Διαχείριση βιβλιοθήκης, απλά')}</p>
    <h1>${esc(copy['hero.title'] ?? '')}</h1>
    <p class="hero__sub">${esc(copy['hero.subtitle'] ?? '')}</p>
    <div class="hero__actions">
      <a href="#apply" class="btn btn--primary btn--lg">${open ? `Κρατήστε μία από τις ${esc(c.offer.spotsTotal)} θέσεις` : 'Λίστα αναμονής'}</a>
      <a href="#what-it-does" class="btn btn--ghost btn--lg">Δείτε τι κάνει</a>
    </div>
    <p class="hero__note">${open ? `Ο πρώτος χρόνος δωρεάν για τις ${esc(c.offer.spotsTotal)} πρώτες βιβλιοθήκες. Χωρίς κάρτα, χωρίς δέσμευση.` : 'Οι θέσεις του πρώτου κύκλου συμπληρώθηκαν.'}</p>
  </div></div>
</section>

<section class="offer" id="prosfora" aria-labelledby="offer-title">
  <div class="wrap">
    <div class="offer__card">
      <span class="offer__badge">Προσφορά έναρξης</span>
      <h2 id="offer-title">Ο πρώτος χρόνος δωρεάν για τις ${esc(c.offer.spotsTotal)} πρώτες βιβλιοθήκες</h2>
      <p class="offer__lede">Το Libriant είναι ολοκληρωμένο και έτοιμο. Για την έναρξή του, οι ${esc(c.offer.spotsTotal)} πρώτες βιβλιοθήκες παίρνουν ολόκληρο το πακέτο ${esc(c.offer.planName)} για ${esc(c.offer.months)} μήνες, χωρίς χρέωση.</p>
      <div class="offer__grid">
        <div class="stat"><span class="stat__num">${esc(c.offer.spotsRemaining)}</span><span class="stat__label">θέσεις διαθέσιμες${c.offer.spotsRemaining !== c.offer.spotsTotal ? ` από ${esc(c.offer.spotsTotal)}` : ''}</span></div>
        <div class="stat"><span class="stat__num">${esc(c.offer.months)} μήνες</span><span class="stat__label">πλήρους πρόσβασης</span></div>
        <div class="stat"><span class="stat__num">Δωρεάν</span><span class="stat__label">για ολόκληρο τον πρώτο χρόνο</span></div>
        <div class="stat"><span class="stat__num">από ${esc(c.offer.entryMonthlyPriceEur)} €</span><span class="stat__label">τον μήνα, μετά τον πρώτο χρόνο</span></div>
      </div>
      <div class="offer__caps">
        <strong>Τι περιλαμβάνει το πακέτο ${esc(c.offer.planName)}:</strong>
        30.000 τίτλοι · 7.500 μέλη · 10 λογαριασμοί προσωπικού · 10 GB για αρχεία ·
        κρατήσεις και ουρά κρατήσεων · μαζική εισαγωγή από CSV, Excel ή MARC ·
        ειδοποιήσεις email · συμπλήρωση στοιχείων με ISBN · δικά σας πεδία σε κάθε είδος εγγραφής.
      </div>
      <p class="offer__fine" style="margin-top:18px">
        Χωρίς πιστωτική κάρτα και χωρίς αυτόματη ανανέωση. Μετά τους ${esc(c.offer.months)} μήνες επιλέγετε το πακέτο που ταιριάζει στο μέγεθός σας — τα πακέτα ξεκινούν από <strong>${esc(c.offer.entryMonthlyPriceEur)} € τον μήνα</strong>, ενώ το ${esc(c.offer.planName)}, που παίρνετε δωρεάν τώρα, κοστίζει ${esc(price)} €. Οι ιδρυτικές βιβλιοθήκες κρατούν μόνιμη έκπτωση — και για πολύ μικρές συλλογές (έως 500 τίτλους) υπάρχει δωρεάν πακέτο.
      </p>
    </div>
  </div>
</section>

<section class="alt" id="what-it-does" aria-labelledby="features-title">
  <div class="wrap">
    <div class="section-head">
      <h2 id="features-title">${esc(copy['features.title'] ?? 'Ό,τι χρειάζεται η βιβλιοθήκη σας')}</h2>
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
      <h2 id="how-title">Πώς δουλεύει</h2>
      <p>Τρία βήματα, και το βαρύ κομμάτι το αναλαμβάνουμε εμείς.</p>
    </div>
    <div class="steps">
      <div class="step">
        <h3>Στέλνετε την αίτηση</h3>
        <p>Δύο λεπτά, χωρίς δεσμεύσεις. Απαντάμε σε κάθε αίτηση εντός δύο εργάσιμων ημερών.</p>
      </div>
      <div class="step">
        <h3>Μεταφέρουμε τον κατάλογό σας</h3>
        <p>Μας στέλνετε ό,τι έχετε — CSV, Excel, MARC, ακόμη και ένα ακατάστατο υπολογιστικό φύλλο. Την εισαγωγή την αναλαμβάνουμε εμείς.</p>
      </div>
      <div class="step">
        <h3>Δουλεύετε κανονικά</h3>
        <p>Η βιβλιοθήκη σας είναι έτοιμη από την πρώτη μέρα, με το προσωπικό σας εκπαιδευμένο και τον κατάλογο στη θέση του.</p>
      </div>
    </div>
  </div>
</section>

<section class="alt" aria-labelledby="trust-title">
  <div class="wrap">
    <div class="section-head">
      <h2 id="trust-title">Τι μπορείτε να επαληθεύσετε πριν αποφασίσετε</h2>
      <p>Ό,τι λέμε εδώ μπορείτε να το ελέγξετε.</p>
    </div>
    <ul class="trust">
      <li><strong>Τα δεδομένα σας είναι δικά σας.</strong> Εξαγωγή ολόκληρου του καταλόγου με ένα κλικ, όποτε θέλετε, χωρίς να μας ρωτήσετε.</li>
      <li><strong>Καμία αυτόματη χρέωση.</strong> Δεν καταχωρίζετε κάρτα, άρα δεν υπάρχει τίποτα να χρεωθεί στο τέλος του χρόνου.</li>
      <li><strong>Ελληνικά και αγγλικά εξαρχής.</strong> Όχι μετάφραση που προστέθηκε μετά — και οι δύο γλώσσες είναι ισότιμες σε κάθε οθόνη.</li>
      <li><strong>Δεδομένα στην Ευρωπαϊκή Ένωση.</strong> Καθημερινά αντίγραφα ασφαλείας και σχεδιασμός σύμφωνος με τον ΓΚΠΔ, με Σύμβαση Επεξεργασίας Δεδομένων πριν καταχωρίσετε το πρώτο μέλος.</li>
      <li><strong>Χωρίς παρακολούθηση.</strong> Ούτε αναλυτικά στοιχεία ούτε cookies παρακολούθησης — γι’ αυτό δεν είδατε παράθυρο συγκατάθεσης.</li>
      <li><strong>Ελεγμένο πριν διατεθεί.</strong> Πλήρης έλεγχος ασφαλείας πριν από τη διάθεση, και αυτοματοποιημένες δοκιμές σε κάθε αλλαγή του κώδικα.</li>
    </ul>
  </div>
</section>

<section class="form-section" id="apply" aria-labelledby="apply-title">
  <div class="wrap">
    <div class="section-head">
      <h2 id="apply-title">${open ? 'Κάντε αίτηση' : 'Λίστα αναμονής'}</h2>
      <p>${open ? `Συμπληρώστε τα στοιχεία της βιβλιοθήκης σας και επικοινωνούμε μαζί σας μέσα σε δύο εργάσιμες ημέρες.` : 'Ο πρώτος κύκλος έκλεισε.'}</p>
    </div>
    ${open ? applicationForm(c, o) : closedNotice(c)}
  </div>
</section>`;

  return renderShell({
    title: 'Libriant — Διαχείριση βιβλιοθήκης, απλά',
    description: `Πλήρες σύστημα διαχείρισης βιβλιοθήκης στα ελληνικά — κατάλογος, μέλη, δανεισμοί, κρατήσεις. Ο πρώτος χρόνος δωρεάν για τις ${c.offer.spotsTotal} πρώτες βιβλιοθήκες.`,
    path: '/',
    body,
    config: c,
    draft: o.draft,
  });
}

export function renderThanks(c: SiteConfig, draft?: boolean): string {
  const body = `<div class="page-head"><div class="wrap"><h1>Η αίτησή σας στάλθηκε</h1></div></div>
<div class="page-body"><div class="wrap"><div class="prose">
  <p>Ευχαριστούμε — τη λάβαμε.</p>
  <h2>Τι γίνεται τώρα</h2>
  <ol>
    <li><strong>Μέσα σε δύο εργάσιμες ημέρες</strong> θα λάβετε απάντηση από το ${esc(c.identity.contactEmail)}, θετική ή αρνητική. Δεν αφήνουμε καμία αίτηση αναπάντητη.</li>
    <li><strong>Αν υπάρχει διαθέσιμη θέση</strong>, θα κανονίσουμε μια σύντομη συζήτηση για να δούμε τι έχετε σήμερα και πώς θα το μεταφέρουμε.</li>
    <li><strong>Τη μεταφορά του καταλόγου την κάνουμε εμείς.</strong> Εσείς μας στέλνετε το αρχείο σας όπως το έχετε.</li>
  </ol>
  <p>Αν δεν λάβετε τίποτα μέσα σε τρεις ημέρες, ελέγξτε τον φάκελο ανεπιθύμητης αλληλογραφίας και μετά γράψτε μας απευθείας στο <a href="mailto:${esc(c.identity.contactEmail)}">${esc(c.identity.contactEmail)}</a>.</p>
  <h2>Αλλάξατε γνώμη;</h2>
  <p>Στείλτε ένα email στο <a href="mailto:${esc(c.identity.privacyEmail)}">${esc(c.identity.privacyEmail)}</a> και διαγράφουμε την αίτησή σας. Δεν χρειάζεται να εξηγήσετε τίποτα, και δεν θα σας ξαναγράψουμε.</p>
  <h2>Στο μεταξύ</h2>
  <p>Όσο περιμένετε, δείτε <a href="/features">τι κάνει το Libriant</a> — και, αν έχετε ήδη κατάλογο σε αρχείο, <a href="/migration">πώς γίνεται η μετάπτωση</a>. Αν προκύψει ερώτηση, <a href="/contact">γράψτε μας</a>.</p>
  <p><a href="/">← Επιστροφή στην αρχική</a></p>
</div></div></div>`;
  return renderShell({
    title: 'Η αίτησή σας στάλθηκε — Libriant',
    description: 'Λάβαμε το αίτημά σας. Επικοινωνούμε μαζί σας μέσα σε δύο εργάσιμες ημέρες.',
    path: '/thank-you',
    body,
    config: c,
    draft,
  });
}

export function renderDoc(
  c: SiteConfig,
  o: { title: string; html: string; path: string; description: string; draft?: boolean },
): string {
  const body = `<div class="page-body"><div class="wrap"><div class="prose">
${o.html}
<hr>
<p><a href="/">← Επιστροφή στην αρχική</a></p>
</div></div></div>`;
  return renderShell({
    title: `${o.title} — Libriant`,
    description: o.description,
    path: o.path,
    body,
    config: c,
    draft: o.draft,
  });
}

export function render404(c: SiteConfig, draft?: boolean): string {
  const body = `<div class="page-body"><div class="wrap"><div class="prose">
  <h1>Η σελίδα δεν βρέθηκε</h1>
  <p>Ο σύνδεσμος που ακολουθήσατε δεν οδηγεί πουθενά. Δοκιμάστε από την <a href="/">αρχική σελίδα</a>, ή πηγαίνετε κατευθείαν σε ό,τι ψάχνατε:</p>
  <ul>
    <li><a href="/features">Δυνατότητες</a> — τι κάνει το Libriant σήμερα</li>
    <li><a href="/pricing">Πακέτα και τιμές</a></li>
    <li><a href="/migration">Μετάπτωση</a> — πώς έρχεται ο κατάλογός σας</li>
    <li><a href="/security">Ασφάλεια και προστασία δεδομένων</a></li>
    <li><a href="/faq">Συχνές ερωτήσεις</a></li>
    <li><a href="/contact">Επικοινωνία</a></li>
    <li><a href="/#apply">Φόρμα αίτησης</a></li>
  </ul>
</div></div></div>`;
  return renderShell({
    title: 'Η σελίδα δεν βρέθηκε — Libriant',
    description: 'Η σελίδα που ζητήσατε δεν υπάρχει.',
    path: '/404',
    body,
    config: c,
    draft,
  });
}
