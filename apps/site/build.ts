/**
 * Static-site generator for the Libriant marketing site.
 *
 * Reads the app's OWN Greek marketing copy (`locales/el/landing.json`) and the
 * brand assets, so this site and the product's landing page cannot drift apart.
 * Emits plain HTML + one stylesheet into `dist/`, which the Worker serves.
 *
 *   pnpm build            strict — refuses to emit while site.config.json has
 *                         unfilled [PLACEHOLDERS]. This is what `deploy` runs.
 *   pnpm build -- --draft build anyway, stamping a loud red banner on every
 *                         page so a draft can never be mistaken for publishable.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

import { STYLESHEET, type SiteConfig } from './src/shell.js';
import { renderIndex, renderThanks, renderDoc, render404, type LandingCopy } from './src/pages.js';
import { renderContentPage, type PageContent } from './src/render.js';
import { renderPlanCards, renderComparisonTable } from './src/plans.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const DIST = join(HERE, 'dist');

const draft = process.argv.includes('--draft');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function readJson<T>(path: string): T {
  return JSON.parse(read(path)) as T;
}

/**
 * Walk every string in the config looking for `[SQUARE BRACKET]` placeholders.
 * This is the gate that makes it impossible to publish a page reading
 * "Υπεύθυνος επεξεργασίας: [ΤΟ ΠΛΗΡΕΣ ΟΝΟΜΑ ΣΑΣ]" — the same defensive spirit as
 * `scripts/check-assets.ts` and `scripts/check-translations.ts` in the repo root.
 */
function findPlaceholders(value: unknown, path: string[] = []): string[] {
  if (typeof value === 'string') {
    return /\[[^\]]{2,}\]/.test(value) ? [`${path.join('.')} = ${value}`] : [];
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !k.startsWith('_'))
      .flatMap(([k, v]) => findPlaceholders(v, [...path, k]));
  }
  return [];
}

function renderMarkdown(md: string, tokens: Record<string, string>): string {
  const substituted = md.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => {
    const value = tokens[key];
    if (value === undefined) throw new Error(`Unknown template token {{${key}}} in content.`);
    return value;
  });
  const html = marked.parse(substituted, { async: false, gfm: true });
  // Wide tables must scroll inside their own container rather than forcing the
  // page body to scroll horizontally on a phone.
  return html
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>');
}

/** Copy `public/` verbatim into `dist/` (favicon, og image, anything static). */
function copyPublic(from: string, to: string): number {
  let n = 0;
  for (const entry of readdirSync(from)) {
    const src = join(from, entry);
    const dst = join(to, entry);
    if (statSync(src).isDirectory()) {
      mkdirSync(dst, { recursive: true });
      n += copyPublic(src, dst);
    } else {
      writeFileSync(dst, readFileSync(src));
      n += 1;
    }
  }
  return n;
}

/**
 * Greek months in the genitive, because a date in prose is «21 Αυγούστου 2026»
 * and not «21 Αύγουστος 2026». Everything machine-readable keeps ISO.
 */
const GR_MONTHS_GEN = [
  'Ιανουαρίου',
  'Φεβρουαρίου',
  'Μαρτίου',
  'Απριλίου',
  'Μαΐου',
  'Ιουνίου',
  'Ιουλίου',
  'Αυγούστου',
  'Σεπτεμβρίου',
  'Οκτωβρίου',
  'Νοεμβρίου',
  'Δεκεμβρίου',
];

function greekDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${GR_MONTHS_GEN[Number(m[2]) - 1]} ${m[1]}`;
}

type LintRule = {
  name: string;
  re: RegExp;
  level: 'error' | 'warn';
  why: string;
  /** Strip regions where a match is legitimate before testing. */
  scrub?: (html: string) => string;
};

/**
 * Copy rules the build enforces, so a claim or a formatting slip cannot reach
 * production because someone was tired. Each one exists because the alternative
 * is discovering it in a library director's inbox.
 */
const LINT_RULES: LintRule[] = [
  {
    name: 'tonos-in-caps',
    level: 'error',
    re: /[Α-ΩΪΫ]{2,}[ΆΈΉΊΌΎΏ]|[ΆΈΉΊΌΎΏ][Α-ΩΪΫ]{2,}/,
    why: 'Greek all-caps drops the tonos: ΠΡΟΣΦΟΡΑ, not ΠΡΟΣΦΟΡΆ.',
  },
  {
    name: 'brand-gender',
    level: 'error',
    re: /\b[ΗηΤτ]α? Libriant\b|Λίμπριαντ/,
    why: 'Libriant is neuter and indeclinable — «το Libriant». «Η Libriant» implies a company that does not exist.',
  },
  {
    name: 'plan-word',
    level: 'error',
    re: /πλάν(ο|ου|α|ων)/i,
    why: 'A tier is a «πακέτο», never a «πλάνο».',
    // One exception, and it is not a loophole: «Πλάνο & χρεώσεις» is the real
    // label of a screen in the app (locales/el/billing.json). Telling a
    // librarian to click something we have renamed for them would be worse
    // than the inconsistency. Only the exact quoted title is allowed through.
    scrub: (h) => h.replace(/«Πλάνο &(amp;)? χρεώσεις»/g, '«…»'),
  },
  {
    name: 'loan-word',
    level: 'error',
    re: /\bδάνει(ο|ου|α|ων)\b/i,
    why: '«δάνειο» reads as financial debt. Use «δανεισμός».',
  },
  {
    name: 'company-language',
    level: 'error',
    re: /εταιρ[εί]α|ΓΕΜΗ|ΑΦΜ|ΦΠΑ|™|®|\(TM\)|σήμα κατατεθέν|τιμολόγιο|τιμολογ(ούμε|είται)/i,
    why: 'The business is not registered and nothing is trademarked.',
  },
  {
    name: 'currency-format',
    level: 'error',
    re: /€\s*\d|\d€|\b0\s*€/,
    why: 'Currency is «19 €» with a non-breaking space. Zero is «Δωρεάν», never «0 €».',
  },
  {
    name: 'terminology-drift',
    level: 'error',
    re: /ιστορικό ενεργειών|προκράτηση|σε καθυστέρηση|κωδικός ραφιού|πρόσβαση API/,
    why: 'Glossary violation, or a claim the code does not support.',
  },
  {
    name: 'iso-date-in-prose',
    level: 'error',
    re: /\d{4}-\d{2}-\d{2}/,
    why: 'Dates in prose are «21 Αυγούστου 2026». ISO belongs in datetime, loc and lastmod only.',
    scrub: (h) =>
      h
        .replace(/datetime="[^"]*"/g, '')
        .replace(/<loc>[^<]*<\/loc>/g, '')
        .replace(/<lastmod>[^<]*<\/lastmod>/g, ''),
  },
  {
    name: 'straight-quotes',
    level: 'error',
    re: /["'][\u0370-\u03FF]|[\u0370-\u03FF]["']/,
    why: 'Greek text uses « » and the typographic apostrophe ’.',
    scrub: (h) => h.replace(/<[^>]+>/g, ' '),
  },
  {
    name: 'capitalised-language-name',
    level: 'warn',
    re: /(?<![.!?·]\s)(?<!^)\b(Ελληνικά|Αγγλικά)\b/m,
    why: 'Greek writes language names lowercase mid-sentence.',
    scrub: (h) => h.replace(/<[^>]+>/g, ' '),
  },
  {
    name: 'gendered-participle',
    level: 'warn',
    re: /\b(συνδεδεμένος|μόνος σας|έτοιμος|βέβαιος|ενδιαφερόμενος)\b/,
    why: 'Rewrite to avoid gender agreement rather than picking one.',
    scrub: (h) => h.replace(/<[^>]+>/g, ' '),
  },
  {
    name: 'minimising-adverb',
    level: 'warn',
    re: /\bΑπλά (ανεβ|κάν|πατ|συμπλ)|\bαπλά (ανεβ|κάν|πατ|συμπλ)/,
    why: 'Telling someone their work is simple blames them when it is not.',
    scrub: (h) => h.replace(/<[^>]+>/g, ' '),
  },
];

function lint(files: Array<[string, string]>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [name, html] of files) {
    if (!/\.(html|xml)$/.test(name)) continue;
    for (const rule of LINT_RULES) {
      const subject = rule.scrub ? rule.scrub(html) : html;
      const m = rule.re.exec(subject);
      if (!m) continue;
      const at = Math.max(0, m.index - 45);
      const ctx = subject
        .slice(at, m.index + m[0].length + 45)
        .replace(/\s+/g, ' ')
        .trim();
      const line = `${name} · ${rule.name}: ${rule.why}\n      …${ctx}…`;
      (rule.level === 'error' ? errors : warnings).push(line);
    }
  }
  return { errors, warnings };
}

function main(): void {
  const config = readJson<SiteConfig>(join(HERE, 'site.config.json'));

  const placeholders = findPlaceholders(config);
  if (placeholders.length > 0) {
    const list = placeholders.map((p) => `    • ${p}`).join('\n');
    if (!draft) {
      console.error(
        `\n✗ site.config.json still has ${placeholders.length} unfilled placeholder(s):\n\n${list}\n\n` +
          `  Fill them in before building for production — these values are printed\n` +
          `  in the page footer and the privacy notice, where GDPR Art. 13 requires\n` +
          `  the controller to be identifiable.\n\n` +
          `  To preview locally anyway:  pnpm build -- --draft\n`,
      );
      process.exit(1);
    }
    console.warn(`\n⚠  DRAFT BUILD — ${placeholders.length} unfilled placeholder(s):\n${list}\n`);
  }

  const landing = readJson<LandingCopy>(join(REPO, 'locales/el/landing.json'));

  // NOT the build clock: auto-dating a legal page on every rebuild claims a
  // revision that never happened, and drifts from the version stored with each
  // recorded consent. Bump `legal.lastUpdated` in site.config.json instead.
  const lastUpdated = config.legal.lastUpdated;
  const tokens: Record<string, string> = {
    LAST_UPDATED: greekDate(lastUpdated),
    CONTROLLER_NAME: config.identity.controllerName,
    CONTACT_EMAIL: config.identity.contactEmail,
    PRIVACY_EMAIL: config.identity.privacyEmail,
    CITY: config.identity.city,
    COUNTRY: config.identity.country,
    PARENT_BRAND: config.identity.parentBrand,
    SPOTS_TOTAL: String(config.offer.spotsTotal),
    MONTHS: String(config.offer.months),
    PLAN_NAME: config.offer.planName,
    PLANNED_PRICE: String(config.offer.plannedMonthlyPriceEur),
  };

  // Page copy is authored as data in content/pages.json. The pricing page's
  // plan cards and comparison grid are generated from the product's own plan
  // definitions instead, so the caps advertised are the caps enforced.
  const contentPages = readJson<PageContent[]>(join(HERE, 'content/pages.json')).map((page) => {
    if (page.slug !== '/times') return page;
    return {
      ...page,
      sections: [
        {
          type: 'cards' as const,
          heading: 'Τα πακέτα',
          intro:
            'Οι τιμές είναι γραμμένες εδώ. Δεν χρειάζεται να ζητήσετε προσφορά για να μάθετε τι κοστίζει.',
          html: `<section class="section">
    <div class="wrap">
      <div class="section-head">
        <h2 id="a-ta-paketa">Τα πακέτα</h2>
        <p>Οι τιμές είναι γραμμένες εδώ. Δεν χρειάζεται να ζητήσετε προσφορά για να μάθετε τι κοστίζει.</p>
      </div>
      ${renderPlanCards(config.offer.planName.toLowerCase())}
    </div>
  </section>`,
        },
        ...page.sections,
        {
          type: 'table' as const,
          heading: 'Αναλυτική σύγκριση',
          html: `<section class="section alt">
    <div class="wrap">
      <div class="section-head">
        <h2 id="a-analytiki-sygkrisi">Αναλυτική σύγκριση</h2>
        <p>Κάθε γραμμή είναι όριο που εφαρμόζει το ίδιο το λογισμικό — δεν είναι εμπορική περιγραφή.</p>
      </div>
      ${renderComparisonTable()}
    </div>
  </section>`,
        },
      ],
    };
  });

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const pages: Array<[string, string]> = [
    ['index.html', renderIndex(config, landing, { draft })],
    ['efcharistoume.html', renderThanks(config, draft)],
    [
      'aporrito.html',
      renderDoc(config, {
        title: 'Πολιτική Απορρήτου',
        path: '/aporrito',
        description:
          'Πώς χειριζόμαστε τα στοιχεία που στέλνετε μέσω της φόρμας αίτησης. Χωρίς cookies παρακολούθησης, χωρίς αναλυτικά στοιχεία.',
        html: renderMarkdown(read(join(HERE, 'content/privacy.el.md')), tokens),
        draft,
      }),
    ],
    [
      'oroi-programmatos.html',
      renderDoc(config, {
        title: 'Όροι προσφοράς',
        path: '/oroi-programmatos',
        description: `Τι ακριβώς περιλαμβάνει ο δωρεάν πρώτος χρόνος για τις ${config.offer.spotsTotal} πρώτες βιβλιοθήκες, και τι ισχύει μετά.`,
        html: renderMarkdown(read(join(HERE, 'content/programme-terms.el.md')), tokens),
        draft,
      }),
    ],
    ...contentPages.map((page): [string, string] => [
      `${page.slug.replace(/^\//, '')}.html`,
      renderContentPage(config, page, draft),
    ]),
    ['404.html', render404(config, draft)],
    ['styles.css', STYLESHEET],
    [
      'robots.txt',
      `User-agent: *\nAllow: /\nDisallow: /apply\n\nSitemap: ${config.site.origin.replace(/\/$/, '')}/sitemap.xml\n`,
    ],
  ];

  const origin = config.site.origin.replace(/\/$/, '');
  const urls = ['/', ...contentPages.map((p) => p.slug), '/oroi-programmatos', '/aporrito']
    .map((p) => `  <url><loc>${origin}${p}</loc><lastmod>${lastUpdated}</lastmod></url>`)
    .join('\n');
  pages.push([
    'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  ]);

  const { errors, warnings } = lint(pages);
  if (warnings.length > 0) {
    console.warn(
      `\n⚠  ${warnings.length} copy warning(s):\n` +
        warnings.map((w) => `    • ${w}`).join('\n') +
        '\n',
    );
  }
  if (errors.length > 0) {
    console.error(
      `\n✗ ${errors.length} copy error(s) — nothing was written:\n\n` +
        errors.map((e) => `    • ${e}`).join('\n') +
        `\n\n  These are claims or conventions the site must not break. Fix the copy;\n` +
        `  do not relax the rule unless the underlying fact has changed.\n`,
    );
    process.exit(1);
  }

  for (const [name, contents] of pages) {
    writeFileSync(join(DIST, name), contents, 'utf8');
  }

  const copied = copyPublic(join(HERE, 'public'), DIST);
  // The icons live in the repo-wide asset folder so the site and the app cannot
  // drift apart visually. Copy only what the pages actually reference.
  mkdirSync(join(DIST, 'icons'), { recursive: true });
  const icons = copyPublic(join(REPO, 'assets/icons'), join(DIST, 'icons'));

  console.log(
    `✓ built ${pages.length} files + ${copied + icons} static asset(s) → apps/site/dist${draft ? '  (DRAFT)' : ''}`,
  );
}

main();
