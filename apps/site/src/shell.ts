/**
 * Shared page chrome for the Libriant marketing site.
 *
 * Imported by BOTH `build.ts` (which writes the static pages into `dist/`) and
 * `src/worker.ts` (which renders no-JavaScript error pages for form submissions
 * that fail validation). Keeping the shell here means the error page a visitor
 * without JavaScript sees is visually identical to the rest of the site — there
 * is exactly one masthead, one footer and one stylesheet in the project.
 *
 * The palette is lifted from the brand mark itself
 * (`assets/brand/libriant-logo-shelf.svg`): deep teal-navy ink, the two teal
 * spines, the two gold spines, and the cream `#F4ECD6` of the page edges.
 */

export type SiteConfig = {
  identity: {
    controllerName: string;
    brand: string;
    parentBrand: string;
    contactEmail: string;
    privacyEmail: string;
    city: string;
    country: string;
  };
  offer: {
    spotsTotal: number;
    spotsRemaining: number;
    months: number;
    planName: string;
    plannedMonthlyPriceEur: number;
    /** Cheapest PAID tier — the honest "from" price for a real library. The
     *  free Starter tier caps at 500 titles, which almost no recipient fits. */
    entryMonthlyPriceEur: number;
  };
  site: {
    origin: string;
    notifyTo: string;
    notifyFrom: string;
    turnstileSiteKey: string;
  };
  legal: {
    /** Date the legal text last actually changed. Displayed on the policy pages
     *  and recorded with every consent — never derived from the build clock. */
    lastUpdated: string;
  };
};

/** Escape text for interpolation into HTML element content or an attribute. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The bookshelf mark, redrawn as a compact inline SVG.
 *
 * The full logo in `assets/brand/` is a 770×220 lockup carrying its own
 * wordmark; here we want just the shelf glyph next to live HTML text, so the
 * spines are reproduced at 48×48 with the same gradient stops. Gradient ids are
 * prefixed per-instance because a page may embed the mark more than once and
 * duplicate SVG ids resolve to whichever came first.
 */
export function brandMark(id = 'm', size = 40): string {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 220 220" role="img" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="${id}-t1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#13B0A0"/><stop offset="1" stop-color="#0C8C81"/></linearGradient>
    <linearGradient id="${id}-t2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22C9B8"/><stop offset="1" stop-color="#14A99A"/></linearGradient>
    <linearGradient id="${id}-g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F8CE63"/><stop offset="1" stop-color="#E9A93C"/></linearGradient>
    <linearGradient id="${id}-g2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F2A741"/><stop offset="1" stop-color="#E08A2A"/></linearGradient>
  </defs>
  <g fill="currentColor">
    <rect x="30" y="30" width="34" height="160" rx="11"/>
    <rect x="30" y="156" width="160" height="34" rx="11"/>
  </g>
  <g transform="rotate(-7 96 156)"><rect x="82" y="66" width="22" height="90" rx="4.5" fill="url(#${id}-t1)"/><rect x="83.4" y="66" width="19.2" height="5" rx="2.5" fill="#F4ECD6" fill-opacity="0.92"/></g>
  <rect x="110" y="48" width="23" height="108" rx="4.5" fill="url(#${id}-t2)"/><rect x="111.4" y="48" width="20.2" height="5" rx="2.5" fill="#F4ECD6" fill-opacity="0.92"/>
  <rect x="139" y="78" width="22" height="78" rx="4.5" fill="url(#${id}-g1)"/><rect x="140.4" y="78" width="19.2" height="5" rx="2.5" fill="#F4ECD6" fill-opacity="0.92"/>
  <g transform="rotate(9 178 156)"><rect x="166" y="90" width="23" height="66" rx="4.5" fill="url(#${id}-g2)"/><rect x="167.4" y="90" width="20.2" height="5" rx="2.5" fill="#F4ECD6" fill-opacity="0.92"/></g>
</svg>`;
}

/** The site's pages, in nav order. One list feeds the masthead, the footer and
 *  the sitemap, so a page can never exist without being reachable. */
export const NAV = [
  { path: '/dynatotites', label: 'Δυνατότητες' },
  { path: '/times', label: 'Πακέτα' },
  { path: '/metaptosi', label: 'Μετάπτωση' },
  { path: '/asfaleia-dedomenon', label: 'Ασφάλεια' },
  { path: '/syhnes-erotiseis', label: 'Συχνές ερωτήσεις' },
] as const;

export const FOOTER_LEGAL = [
  { path: '/epikoinonia', label: 'Επικοινωνία' },
  { path: '/oroi-programmatos', label: 'Όροι προσφοράς' },
  { path: '/aporrito', label: 'Πολιτική Απορρήτου' },
] as const;

/** Wordmark + mark, as used in the masthead and the footer. */
export function brandLockup(id: string, size = 38): string {
  return `<span class="lockup">${brandMark(id, size)}<span class="lockup__word">Libriant</span></span>`;
}

export const STYLESHEET = `
/* Libriant marketing site — hand-written, no framework, no external requests.
   Light palette is defined on bare :root so nothing depends on a media query
   resolving; the dark block only redefines tokens. */
:root {
  color-scheme: light dark;
  --ink: #0A222C;
  --ink-2: #123A47;
  --teal: #0C8C81;
  --teal-bright: #13B0A0;
  --teal-lift: #22C9B8;
  --teal-deep: #076B62;
  --gold: #E9A93C;
  --gold-light: #F8CE63;
  --paper: #F4ECD6;
  --paper-2: #FBF5E6;
  --bg: #FFFFFF;
  --surface: #FAF9F6;
  --surface-2: #F2F1EC;
  --text: #17272E;
  --muted: #55666E;
  --border: #E4E1D8;
  --border-strong: #CFCABC;
  --on-ink: #EAF3F2;
  --on-ink-muted: #9FBDC0;
  --shadow: 0 1px 2px rgba(10,34,44,.06), 0 8px 24px -12px rgba(10,34,44,.18);
  --shadow-lg: 0 2px 4px rgba(10,34,44,.06), 0 24px 56px -20px rgba(10,34,44,.28);
  --radius: 12px;
  --radius-lg: 18px;
  --serif: Georgia, 'Palatino Linotype', 'Book Antiqua', Palatino, 'Times New Roman', serif;
  --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --measure: 66ch;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #071519;
    --surface: #0D2027;
    --surface-2: #122B33;
    --text: #E7EFF0;
    --muted: #9CB3BA;
    --border: #1A3742;
    --border-strong: #24505E;
    --paper: #16302C;
    --paper-2: #12272577;
    --teal: #22C9B8;
    --teal-bright: #34DCC9;
    --teal-lift: #5BE9D8;
    --teal-deep: #13B0A0;
    --on-ink: #EAF3F2;
    --on-ink-muted: #9FBDC0;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px -12px rgba(0,0,0,.6);
    --shadow-lg: 0 2px 4px rgba(0,0,0,.4), 0 24px 56px -20px rgba(0,0,0,.7);
  }
}

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 17px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
  overflow-wrap: break-word;
}
h1, h2, h3, h4 { font-family: var(--serif); font-weight: 700; line-height: 1.2; letter-spacing: -0.01em; margin: 0 0 .5em; }
h1 { font-size: clamp(2.1rem, 1.4rem + 3vw, 3.5rem); letter-spacing: -0.025em; }
h2 { font-size: clamp(1.6rem, 1.2rem + 1.6vw, 2.3rem); }
h3 { font-size: 1.2rem; }
p { margin: 0 0 1.1em; }
a { color: var(--teal-deep); text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { color: var(--teal); }
:focus-visible { outline: 3px solid var(--teal-bright); outline-offset: 3px; border-radius: 4px; }
img, svg { max-width: 100%; }
hr { border: 0; border-top: 1px solid var(--border); margin: 2.5rem 0; }

.wrap { width: 100%; max-width: 1080px; margin: 0 auto; padding: 0 24px; }
.skip {
  position: absolute; left: -9999px; top: 0; z-index: 100;
  background: var(--teal-deep); color: #fff; padding: 12px 20px; border-radius: 0 0 8px 0;
}
.skip:focus { left: 0; }

/* ---------- brand lockup ---------- */
.lockup { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; }
.lockup__word { font-family: var(--serif); font-size: 1.45rem; font-weight: 700; letter-spacing: -0.015em; }
.mark { flex: none; display: block; }

/* ---------- masthead ---------- */
.masthead { background: var(--ink); color: var(--on-ink); }
.masthead .wrap { display: flex; align-items: center; justify-content: space-between; gap: 20px; min-height: 74px; flex-wrap: wrap; }
.masthead a { color: var(--on-ink); text-decoration: none; }
.masthead .lockup { color: var(--on-ink); padding: 12px 0; }
.masthead nav { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.masthead nav a { padding: 10px 14px; border-radius: 8px; font-size: .95rem; color: var(--on-ink-muted); }
.masthead nav a:hover { color: var(--on-ink); background: rgba(255,255,255,.07); }
.masthead nav a[aria-current="page"] { color: var(--on-ink); background: rgba(255,255,255,.10); }
.masthead nav a.cta {
  background: var(--teal-bright); color: #052925; font-weight: 600;
  padding: 11px 18px; border-radius: 999px;
}
.masthead nav a.cta:hover { background: var(--teal-lift); color: #052925; }

/* ---------- draft banner ---------- */
.draft {
  background: #7A1B1B; color: #FFF3F3; padding: 12px 24px; text-align: center;
  font-size: .9rem; font-weight: 600; line-height: 1.5;
}
.draft code { background: rgba(0,0,0,.25); padding: 1px 6px; border-radius: 4px; }

/* ---------- hero ---------- */
.hero { background-color: var(--ink); background-image: linear-gradient(178deg, var(--ink) 0%, var(--ink-2) 100%); color: var(--on-ink); padding: clamp(56px, 8vw, 104px) 0 clamp(64px, 9vw, 120px); position: relative; overflow: hidden; }
.hero::after {
  content: ''; position: absolute; inset: auto 0 0 0; height: 5px;
  background: linear-gradient(90deg, var(--teal-bright) 0%, var(--teal) 38%, var(--gold-light) 62%, var(--gold) 100%);
}
.hero__inner { max-width: 46rem; }
/* Greek orthography drops the tonos in all-caps: ΠΡΟΣΦΟΡΑ, never ΠΡΟΣΦΟΡΆ.
   text-transform:uppercase gets this right because the document carries
   lang="el" and the CSS Text spec mandates language-aware casing (verified in
   the browser). Keep the source text mixed-case so screen readers read the word
   instead of spelling out capitals. NOTE: mail clients do NOT apply the rule,
   so the email hardcodes its capitals rather than using this property. */
.eyebrow {
  display: inline-block; font-size: .78rem; font-weight: 700; letter-spacing: .13em;
  text-transform: uppercase; color: var(--gold-light); margin: 0 0 18px;
}
.hero h1 { color: #fff; margin-bottom: .35em; }
.hero__sub { font-size: clamp(1.06rem, 1rem + .5vw, 1.3rem); color: #C7DBDC; max-width: 40rem; margin-bottom: 2rem; }
.hero__actions { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; }
.hero__note { margin: 22px 0 0; font-size: .92rem; color: var(--on-ink-muted); }

/* ---------- buttons ---------- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 9px;
  min-height: 50px; padding: 13px 28px; border-radius: 999px;
  font-family: var(--sans); font-size: 1.02rem; font-weight: 600; line-height: 1.2;
  text-decoration: none; cursor: pointer; border: 2px solid transparent;
  transition: background-color .15s ease, border-color .15s ease, transform .1s ease;
}
.btn:active { transform: translateY(1px); }
.btn--primary { background: var(--teal-bright); color: #042522; border-color: var(--teal-bright); }
.btn--primary:hover { background: var(--teal-lift); border-color: var(--teal-lift); color: #042522; }
.btn--ghost { background: transparent; color: #DCEBEA; border-color: rgba(255,255,255,.34); }
.btn--ghost:hover { background: rgba(255,255,255,.09); color: #fff; border-color: rgba(255,255,255,.55); }
.btn--lg { min-height: 58px; font-size: 1.08rem; padding: 16px 36px; }
.btn[disabled] { opacity: .55; cursor: not-allowed; }

/* ---------- sections ---------- */
section { padding: clamp(52px, 7vw, 92px) 0; }
.section-head { max-width: 40rem; margin-bottom: clamp(32px, 4vw, 52px); }
.section-head h2 { margin-bottom: .35em; }
.section-head p { color: var(--muted); font-size: 1.08rem; margin: 0; }
.alt { background: var(--surface); border-block: 1px solid var(--border); }

/* ---------- offer panel ---------- */
.offer { padding-top: clamp(44px, 6vw, 76px); }
.offer__card {
  background: var(--paper); border-radius: var(--radius-lg);
  border: 1px solid rgba(233,169,60,.42); border-left: 6px solid var(--gold);
  padding: clamp(28px, 4vw, 46px); box-shadow: var(--shadow);
}
.offer__badge {
  display: inline-flex; align-items: center; gap: 8px; background: var(--ink); color: var(--gold-light);
  font-size: .76rem; font-weight: 700; letter-spacing: .11em; text-transform: uppercase;
  padding: 7px 15px; border-radius: 999px; margin-bottom: 20px;
}
.offer__card h2 { margin-bottom: .3em; color: var(--ink); }
.offer__lede { font-size: 1.14rem; color: #43413A; max-width: 44rem; }
.offer__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 20px; margin: 30px 0 26px; }
.stat__num { font-family: var(--serif); font-size: clamp(1.9rem, 1.4rem + 2vw, 2.6rem); font-weight: 700; color: var(--teal-deep); line-height: 1.05; display: block; }
.stat__label { font-size: .9rem; color: #5C574B; line-height: 1.4; display: block; margin-top: 4px; }
.offer__fine { font-size: .93rem; color: #6A6455; margin: 0; }
.offer__caps { margin: 22px 0 0; padding: 18px 20px; background: rgba(255,255,255,.5); border-radius: var(--radius); font-size: .95rem; color: #4A463C; }
.offer__caps strong { color: var(--ink); }
@media (prefers-color-scheme: dark) {
  .offer__card { border-color: rgba(233,169,60,.3); }
  .offer__card h2 { color: var(--on-ink); }
  .offer__lede, .stat__label, .offer__fine, .offer__caps { color: #C6D6D2; }
  .offer__caps { background: rgba(0,0,0,.22); }
  .offer__caps strong { color: var(--on-ink); }
  .stat__num { color: var(--teal-bright); }
}

/* ---------- feature grid ---------- */
.features { display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); gap: 22px; }
.feature { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 26px 24px; }
.alt .feature { background: var(--bg); }
.feature__icon {
  width: 44px; height: 44px; border-radius: 11px; display: grid; place-items: center;
  background: var(--surface-2); color: var(--teal-deep); margin-bottom: 16px;
}
.feature__icon svg { width: 23px; height: 23px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.feature h3 { margin-bottom: .35em; }
.feature p { color: var(--muted); font-size: .97rem; margin: 0; }

/* ---------- steps ---------- */
.steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 26px; counter-reset: step; }
.step { counter-increment: step; position: relative; padding-top: 54px; }
.step::before {
  content: counter(step); position: absolute; top: 0; inset-inline-start: 0;
  width: 40px; height: 40px; border-radius: 999px; display: grid; place-items: center;
  background: var(--teal-bright); color: #042522; font-family: var(--serif); font-weight: 700; font-size: 1.15rem;
}
.step h3 { margin-bottom: .3em; }
.step p { color: var(--muted); font-size: .97rem; margin: 0; }

/* ---------- trust list ---------- */
.trust { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px 32px; list-style: none; margin: 0; padding: 0; }
.trust li { position: relative; padding-inline-start: 32px; padding-block: 9px; color: var(--muted); }
.trust li strong { color: var(--text); font-weight: 600; }
.trust li::before {
  content: ''; position: absolute; inset-inline-start: 0; top: 16px;
  width: 17px; height: 10px; border-inline-start: 2.5px solid var(--teal); border-bottom: 2.5px solid var(--teal);
  transform: rotate(-45deg);
}

/* ---------- form ---------- */
.form-section { scroll-margin-top: 24px; }
.form-card {
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-lg);
  padding: clamp(26px, 3.5vw, 44px); box-shadow: var(--shadow-lg); max-width: 780px;
}
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 4px 20px; }
.field { margin-bottom: 20px; display: flex; flex-direction: column; }
.field > label { font-weight: 600; font-size: .95rem; margin-bottom: 7px; }
.field .hint { font-size: .86rem; color: var(--muted); margin: 6px 0 0; }
.req { color: #C2410C; margin-inline-start: 3px; }
@media (prefers-color-scheme: dark) { .req { color: #FDA47A; } }
input[type=text], input[type=email], input[type=tel], select, textarea {
  width: 100%; font: inherit; font-size: 1rem; color: var(--text); background: var(--bg);
  border: 1.5px solid var(--border-strong); border-radius: 10px; padding: 12px 14px; min-height: 48px;
  transition: border-color .15s ease, box-shadow .15s ease;
}
textarea { min-height: 108px; resize: vertical; line-height: 1.55; }
select { appearance: none; background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%); background-position: calc(100% - 20px) 21px, calc(100% - 14px) 21px; background-size: 6px 6px, 6px 6px; background-repeat: no-repeat; padding-inline-end: 40px; }
input:focus, select:focus, textarea:focus { border-color: var(--teal); box-shadow: 0 0 0 3px rgba(12,140,129,.16); outline: none; }
input[aria-invalid=true], textarea[aria-invalid=true], select[aria-invalid=true] { border-color: #C2410C; }
.consent { display: flex; gap: 13px; align-items: flex-start; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; margin-bottom: 24px; }
.consent input { width: 24px; height: 24px; margin: 2px 0 0; flex: none; accent-color: var(--teal-deep); }
.consent label { font-size: .95rem; line-height: 1.55; }
.hp { position: absolute !important; left: -9999px !important; width: 1px; height: 1px; overflow: hidden; }
.form-error {
  background: #FEF2F2; border: 1px solid #FCA5A5; border-inline-start: 5px solid #DC2626;
  color: #7F1D1D; border-radius: var(--radius); padding: 15px 18px; margin-bottom: 24px; font-size: .96rem;
}
.form-error ul { margin: 8px 0 0; padding-inline-start: 20px; }
.form-error a { color: #7F1D1D; }
@media (prefers-color-scheme: dark) {
  .form-error { background: #2A1213; border-color: #7F1D1D; color: #FCA5A5; }
  .form-error a { color: #FCA5A5; }
}
.field-error { color: #C2410C; font-size: .88rem; margin: 6px 0 0; font-weight: 600; }
@media (prefers-color-scheme: dark) { .field-error { color: #FDA47A; } }
.form-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
.form-actions .btn--primary { color: #042522; }

/* ---------- closed state ---------- */
.closed { background: var(--surface); border: 1px solid var(--border); border-inline-start: 5px solid var(--gold); border-radius: var(--radius-lg); padding: clamp(26px, 3.5vw, 40px); max-width: 780px; }

/* ---------- prose (legal pages, thank-you) ---------- */
.prose { max-width: var(--measure); }
.prose h1 { margin-bottom: .6em; }
.prose h2 { font-size: 1.4rem; margin-top: 2.2em; }
.prose h3 { font-size: 1.1rem; margin-top: 1.8em; }
.prose ul, .prose ol { padding-inline-start: 1.4em; margin: 0 0 1.2em; }
.prose li { margin-bottom: .5em; }
.prose strong { font-weight: 700; }
.prose table { width: 100%; border-collapse: collapse; margin: 0 0 1.6em; font-size: .93rem; }
.prose th, .prose td { text-align: start; padding: 11px 13px; border: 1px solid var(--border); vertical-align: top; }
.prose th { background: var(--surface-2); font-weight: 700; }
.prose blockquote { margin: 0 0 1.4em; padding: 4px 0 4px 18px; border-inline-start: 4px solid var(--gold); color: var(--muted); }
.table-wrap { overflow-x: auto; margin-bottom: 1.6em; }
.table-wrap table { margin-bottom: 0; }
.page-head { background: var(--surface); border-bottom: 1px solid var(--border); padding: clamp(38px, 5vw, 64px) 0 clamp(30px, 4vw, 48px); }
.page-head h1 { margin: 0; }
.page-body { padding: clamp(40px, 5vw, 64px) 0 clamp(56px, 7vw, 88px); }

/* ---------- footer ---------- */
.footer { background: var(--ink); color: var(--on-ink-muted); padding: clamp(44px, 6vw, 68px) 0 36px; font-size: .93rem; }
.footer a { color: #BBD4D3; }
.footer a:hover { color: #fff; }
.footer__top { display: flex; flex-wrap: wrap; gap: 34px; justify-content: space-between; margin-bottom: 34px; }
.footer .lockup { color: var(--on-ink); margin-bottom: 12px; }
.footer__tag { max-width: 22rem; margin: 0; }
.footer__links { display: flex; flex-direction: column; gap: 10px; }
.footer__h { font-size: .78rem; letter-spacing: .08em; text-transform: uppercase; color: var(--on-ink-muted); opacity: .75; }
.footer__bottom { border-top: 1px solid rgba(255,255,255,.13); padding-top: 26px; display: flex; flex-wrap: wrap; gap: 12px 28px; justify-content: space-between; align-items: center; }
.footer__id { margin: 0; max-width: 46rem; line-height: 1.7; }
.powered { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }

/* ---------- content pages ---------- */
.section { padding: clamp(52px, 6vw, 88px) 0; }
.section.alt { background: var(--surface); border-block: 1px solid var(--border); }
.lede { font-size: 1.22rem; line-height: 1.65; color: var(--muted); max-width: 44rem; margin: 0; }
.footnote { margin: 22px 0 0; font-size: .92rem; color: var(--muted); max-width: var(--measure); }

/* tick list — a claim and its qualification, so neither reads alone */
.ticks { list-style: none; padding: 0; margin: 0; display: grid; gap: 14px; max-width: 54rem; }
.ticks li { position: relative; padding-left: 34px; line-height: 1.65; }
.ticks li::before {
  content: ""; position: absolute; left: 0; top: .42em; width: 20px; height: 20px;
  border-radius: 50%; background: var(--teal); opacity: .16;
}
.ticks li::after {
  content: ""; position: absolute; left: 6px; top: .72em; width: 8px; height: 4px;
  border-left: 2px solid var(--teal-deep); border-bottom: 2px solid var(--teal-deep);
  transform: rotate(-45deg);
}
.ticks li strong { display: block; }
.ticks li span { color: var(--muted); }

/* steps */
.steps { counter-reset: none; list-style: none; padding: 0; }
.step__n {
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; border-radius: 50%; margin-bottom: 12px;
  background: var(--ink); color: var(--on-ink); font-weight: 700; font-size: .95rem;
}

/* FAQ — open, linkable, printable */
.faq { display: grid; gap: 30px; max-width: 52rem; }
.faq__item h3 { margin: 0 0 .4em; font-size: 1.12rem; }
.faq__item p { margin: 0; color: var(--muted); line-height: 1.72; }

/* callout — the paragraph a reader must not skim past */
.callout {
  border-left: 3px solid var(--gold); background: var(--paper-2);
  padding: 22px 26px; border-radius: 0 var(--radius) var(--radius) 0;
  max-width: var(--measure);
}
.callout p { margin: 0 0 .8em; }
.callout p:last-child { margin-bottom: 0; }

/* comparison + ladder tables */
.cmp { width: 100%; border-collapse: collapse; font-size: .97rem; }
.cmp th, .cmp td { padding: 13px 16px; text-align: left; border-bottom: 1px solid var(--border); }
.cmp thead th { font-size: .82rem; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); border-bottom-color: var(--border-strong); }
.cmp tbody th { font-weight: 600; }
.cmp td { font-variant-numeric: tabular-nums; }
.cmp tbody tr:last-child th, .cmp tbody tr:last-child td { border-bottom: none; }

/* closing band */
.cta-band { background: var(--ink); color: var(--on-ink); text-align: center; }
.cta-band h2 { color: #fff; }
.cta-band p { color: var(--on-ink-muted); max-width: 40rem; margin-inline: auto; }
.cta-band .hero__actions { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; margin-top: 26px; }

@media (prefers-color-scheme: dark) {
  .callout { background: rgba(233,169,60,.08); }
}

@media (max-width: 860px) {
  body { font-size: 16px; }
  .masthead .wrap { min-height: 64px; flex-wrap: nowrap; gap: 12px; }
  /* Previously display:none on every non-CTA link. That was survivable with
     three anchors; with a real page set it takes the whole site away from every
     phone. A horizontally scrollable strip keeps all of it, with no JS. */
  .masthead nav {
    flex-wrap: nowrap;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    -ms-overflow-style: none;
    margin-inline: -4px;
    padding-inline: 4px;
    mask-image: linear-gradient(to right, transparent, #000 12px, #000 calc(100% - 12px), transparent);
  }
  .masthead nav::-webkit-scrollbar { display: none; }
  .masthead nav a { white-space: nowrap; padding: 10px 11px; font-size: .9rem; }
  .hero__actions .btn { width: 100%; }
}
@media print {
  /* The pricing and security pages get forwarded to a δήμος finance office and
     printed. Keep the content, drop only what cannot survive paper. */
  .masthead nav, .hero__actions, .form-section, .draft, .skip { display: none; }
  .masthead { background: #fff; color: #000; }
  .masthead a, .masthead .lockup { color: #000; }
  body { color: #000; background: #fff; font-size: 11pt; }
  a { color: #000; text-decoration: underline; }
  a[href^="/"]::after { content: " (libriant.com" attr(href) ")"; font-size: 9pt; color: #444; }
  .card, .plan, table { break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; }
}
`;

type ShellOptions = {
  title: string;
  description: string;
  path: string;
  body: string;
  config: SiteConfig;
  /** Set when the build ran with `--draft`; stamps a loud unmissable banner. */
  draft?: boolean;
  bodyClass?: string;
};

/** Masthead used on every page. `home` drops the "back to site" nav links. */
function masthead(path: string): string {
  const links = NAV.map(
    (n) => `<a href="${n.path}"${path === n.path ? ' aria-current="page"' : ''}>${n.label}</a>`,
  ).join('\n      ');
  return `<header class="masthead">
  <div class="wrap">
    <a href="/" class="lockup" aria-label="Libriant — αρχική">${brandMark('mh', 34)}<span class="lockup__word">Libriant</span></a>
    <nav aria-label="Κύρια πλοήγηση">
      ${links}
      <a href="/#aitisi" class="cta">Κάντε αίτηση</a>
    </nav>
  </div>
</header>`;
}

function footer(c: SiteConfig): string {
  const year = 2026;
  return `<footer class="footer">
  <div class="wrap">
    <div class="footer__top">
      <div>
        <span class="lockup">${brandMark('ft', 32)}<span class="lockup__word">Libriant</span></span>
        <p class="footer__tag">Διαχείριση βιβλιοθήκης, απλά. Φτιαγμένο στην Ελλάδα, στα ελληνικά και στα αγγλικά.</p>
      </div>
      <nav class="footer__links" aria-label="Σελίδες">
        <span class="footer__h">Το Libriant</span>
        ${NAV.map((n) => `<a href="${n.path}">${n.label}</a>`).join('\n        ')}
      </nav>
      <nav class="footer__links" aria-label="Πληροφορίες">
        <span class="footer__h">Πληροφορίες</span>
        <a href="/#aitisi">Κάντε αίτηση</a>
        ${FOOTER_LEGAL.map((n) => `<a href="${n.path}">${n.label}</a>`).join('\n        ')}
        <a href="mailto:${esc(c.identity.contactEmail)}">${esc(c.identity.contactEmail)}</a>
      </nav>
    </div>
    <div class="footer__bottom">
      <p class="footer__id">
        Υπεύθυνος επεξεργασίας δεδομένων: <strong>${esc(c.identity.controllerName)}</strong>,
        ${esc(c.identity.city)}, ${esc(c.identity.country)} ·
        <a href="mailto:${esc(c.identity.privacyEmail)}">${esc(c.identity.privacyEmail)}</a>
      </p>
      <span class="powered">© ${year} · powered by ${esc(c.identity.parentBrand)}</span>
    </div>
  </div>
</footer>`;
}

export function renderShell(o: ShellOptions): string {
  const canonical = o.config.site.origin.replace(/\/$/, '') + o.path;
  const draftBanner = o.draft
    ? `<div class="draft">ΠΡΟΧΕΙΡΗ ΕΚΔΟΣΗ — το <code>site.config.json</code> έχει ακόμη κενά πεδία. Μη δημοσιεύσετε αυτή τη σελίδα.</div>`
    : '';
  return `<!doctype html>
<html lang="el">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:locale" content="el_GR">
<meta property="og:site_name" content="Libriant">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#0A222C">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">${
    o.config.site.turnstileSiteKey
      ? `\n<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
      : ''
  }
</head>
<body${o.bodyClass ? ` class="${esc(o.bodyClass)}"` : ''}>
${draftBanner}
<a class="skip" href="#main">Μετάβαση στο περιεχόμενο</a>
${masthead(o.path)}
<main id="main">
${o.body}
</main>
${footer(o.config)}
</body>
</html>
`;
}
