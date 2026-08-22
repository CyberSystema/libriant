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

import { STYLESHEET, LANGS, localePath, type Lang, type SiteConfig } from './src/shell.js';
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

const EN_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function humanDate(iso: string, lang: Lang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const day = Number(m[3]);
  const month = Number(m[2]) - 1;
  return lang === 'el'
    ? `${day} ${GR_MONTHS_GEN[month]} ${m[1]}`
    : `${day} ${EN_MONTHS[month]} ${m[1]}`;
}

type LintRule = {
  name: string;
  re: RegExp;
  level: 'error' | 'warn';
  why: string;
  /** Which language trees this rule applies to. Defaults to Greek only. */
  langs?: readonly Lang[];
  /** Strip regions where a match is legitimate before testing. */
  scrub?: (html: string, lintCtx: { controllerName: string }) => string;
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
    langs: ['el'],
    re: /€\s*\d|\d€|\b0\s*€/,
    why: 'Greek currency is «19 €» with a non-breaking space. Zero is «Δωρεάν», never «0 €».',
  },
  {
    // English inverts the convention, so the Greek rule would fail every page.
    name: 'currency-format-en',
    level: 'error',
    langs: ['en'],
    re: /\d\s*€|€\s+\d|\b€0\b/,
    why: 'English currency is «€19» — symbol first, no space. Zero is "Free", never "€0".',
  },
  {
    name: 'greek-in-english-page',
    level: 'error',
    langs: ['en'],
    re: /[\u0370-\u03FF]{4,}/,
    why: 'Untranslated Greek left on an English page.',
    // Three kinds of Greek are legitimate here and must not trip the rule:
    // the language switcher, which says «Ελληνικά» on purpose; the controller's
    // own name, which is a person's name and is not translated; and Greek
    // quoted as an EXAMPLE, which is the whole point of sentences like
    // «“καβαφης” finds “Καβάφη”» on a page about Greek-aware search.
    scrub: (h, lintCtx) =>
      h
        // The controller's own name is a person's name. It appears in the
        // footer and in the privacy notice because GDPR Art. 13 requires them
        // to be identifiable, and translating it would defeat that.
        .split(lintCtx.controllerName)
        .join('')
        .replace(/<a[^>]*class="lang"[^>]*>[^<]*<\/a>/g, '')
        .replace(/aria-label="[^"]*"/g, '')
        .replace(/<p class="footer__id">[\s\S]*?<\/p>/g, '')
        .replace(/[«“"'][^«»“”"']{0,80}[»”"']/g, ''),
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
    re: /\bαπλ(ά|ώς) (ανεβ|κάν|πατ|συμπλ|μας|στ[εέ]λ)/i,
    why: 'Telling someone their work is simple blames them when it is not.',
    scrub: (h) => h.replace(/<[^>]+>/g, ' '),
  },
];

function lint(
  files: Array<[string, string, Lang?]>,
  lintCtx: { controllerName: string },
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [name, html, fileLang] of files) {
    if (!/\.(html|xml)$/.test(name)) continue;
    const lang: Lang = fileLang ?? 'el';
    for (const rule of LINT_RULES) {
      if (!(rule.langs ?? ['el']).includes(lang)) continue;
      const subject = rule.scrub ? rule.scrub(html, lintCtx) : html;
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

  // NOT the build clock: auto-dating a legal page on every rebuild claims a
  // revision that never happened, and drifts from the version stored with each
  // recorded consent. Bump `legal.lastUpdated` in site.config.json instead.
  const lastUpdated = config.legal.lastUpdated;
  const tokens: Record<string, string> = {
    LAST_UPDATED: humanDate(lastUpdated, 'el'),
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
  const PRICING_INTRO: Record<
    Lang,
    { cards: string; cardsIntro: string; table: string; tableIntro: string; tableNote: string }
  > = {
    el: {
      cards: 'Τα πακέτα',
      cardsIntro:
        'Κάθε πακέτο περιλαμβάνει ολόκληρη την εφαρμογή. Αυτό που αλλάζει είναι τα όρια — πόσους τίτλους, πόσα μέλη και πόσους λογαριασμούς προσωπικού χωράει.',
      table: 'Τι αλλάζει από πακέτο σε πακέτο',
      tableIntro:
        'Τα όρια και οι τέσσερις δυνατότητες που δεν υπάρχουν σε κάθε πακέτο. Ό,τι άλλο περιγράφουμε σε αυτή τη σελίδα υπάρχει σε κάθε πακέτο, και στο δωρεάν.',
      tableNote:
        'Η παύλα σημαίνει ότι δεν περιλαμβάνεται στο πακέτο. Η εφαρμογή για υπολογιστή δίνεται σε κάθε πακέτο με τιμή, όχι στο δωρεάν Starter. Τις τιμές θα τις βρείτε στον πρώτο πίνακα.',
    },
    en: {
      cards: 'The plans',
      cardsIntro:
        'Every plan includes the whole application. What changes are the limits — how many titles, members and staff seats it holds.',
      table: 'What changes from plan to plan',
      tableIntro:
        'The limits, and the four things that are not in every plan. Everything else described on this page is in every plan, including the free one.',
      tableNote:
        'A dash means it is not included in that plan. The desktop app comes with every plan that has a price, not with the free Starter. The prices are in the first table.',
    },
  };

  /** Page copy for one language, with the generated pricing sections spliced in. */
  function loadContent(lang: Lang): PageContent[] {
    const t = PRICING_INTRO[lang];
    return readJson<PageContent[]>(join(HERE, `content/pages.${lang}.json`)).map((page) => {
      if (page.slug !== localePath(lang, '/pricing')) return page;
      return {
        ...page,
        sections: [
          {
            type: 'cards' as const,
            id: 'the-plans',
            heading: t.cards,
            html: `<section class="section">
    <div class="wrap">
      <div class="section-head">
        <h2 id="the-plans">${t.cards}</h2>
        <p>${t.cardsIntro}</p>
      </div>
      ${renderPlanCards(config.offer.planName.toLowerCase(), lang)}
    </div>
  </section>`,
          },
          ...page.sections,
          {
            type: 'table' as const,
            id: 'full-comparison',
            heading: t.table,
            html: `<section class="section alt">
    <div class="wrap">
      <div class="section-head">
        <h2 id="full-comparison">${t.table}</h2>
        <p>${t.tableIntro}</p>
      </div>
      ${renderComparisonTable(lang)}
      <p class="footnote">${t.tableNote}</p>
    </div>
  </section>`,
          },
        ],
      };
    });
  }

  const DOC_COPY: Record<
    Lang,
    { privacy: [string, string]; terms: (s: number) => [string, string] }
  > = {
    el: {
      privacy: [
        'Πολιτική Απορρήτου',
        'Πώς χειριζόμαστε τα στοιχεία που στέλνετε μέσω της φόρμας αίτησης. Χωρίς cookies παρακολούθησης, χωρίς αναλυτικά στοιχεία.',
      ],
      terms: (n) => [
        'Όροι προσφοράς',
        `Τι ακριβώς περιλαμβάνει ο δωρεάν πρώτος χρόνος για τις ${n} πρώτες βιβλιοθήκες, και τι ισχύει μετά.`,
      ],
    },
    en: {
      privacy: [
        'Privacy Policy',
        'How we handle the details you send through the application form. No tracking cookies, no analytics.',
      ],
      terms: (n) => [
        'Offer terms',
        `Exactly what the free first year covers for the first ${n} libraries, and what applies afterwards.`,
      ],
    },
  };

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const pages: Array<[string, string, Lang?]> = [];
  const sitemapPaths: string[] = [];

  for (const lang of LANGS) {
    const dir = lang === 'el' ? '' : 'en/';
    if (dir) mkdirSync(join(DIST, 'en'), { recursive: true });
    const content = loadContent(lang);
    const landing = readJson<LandingCopy>(join(REPO, `locales/${lang}/landing.json`));
    const d = DOC_COPY[lang];
    const langTokens = {
      ...tokens,
      LAST_UPDATED: humanDate(lastUpdated, lang),
      CITY: lang === 'en' ? (config.identity.cityEn ?? config.identity.city) : config.identity.city,
      COUNTRY:
        lang === 'en'
          ? (config.identity.countryEn ?? config.identity.country)
          : config.identity.country,
    };
    const [privacyTitle, privacyDesc] = d.privacy;
    const [termsTitle, termsDesc] = d.terms(config.offer.spotsTotal);

    pages.push(
      [`${dir}index.html`, renderIndex(config, landing, { draft, lang }), lang],
      [`${dir}thank-you.html`, renderThanks(config, draft, lang), lang],
      [
        `${dir}privacy.html`,
        renderDoc(config, {
          title: privacyTitle,
          path: localePath(lang, '/privacy'),
          description: privacyDesc,
          html: renderMarkdown(read(join(HERE, `content/privacy.${lang}.md`)), langTokens),
          draft,
          lang,
        }),
        lang,
      ],
      [
        `${dir}offer-terms.html`,
        renderDoc(config, {
          title: termsTitle,
          path: localePath(lang, '/offer-terms'),
          description: termsDesc,
          html: renderMarkdown(read(join(HERE, `content/programme-terms.${lang}.md`)), langTokens),
          draft,
          lang,
        }),
        lang,
      ],
      ...content.map((page): [string, string, Lang] => [
        `${page.slug.replace(/^\//, '')}.html`,
        renderContentPage(config, page, draft, lang),
        lang,
      ]),
      [`${dir}404.html`, render404(config, draft, lang), lang],
    );

    sitemapPaths.push(
      localePath(lang, '/'),
      ...content.map((p) => p.slug),
      localePath(lang, '/offer-terms'),
      localePath(lang, '/privacy'),
    );
  }

  const origin = config.site.origin.replace(/\/$/, '');
  pages.push(
    ['styles.css', STYLESHEET],
    [
      'robots.txt',
      `User-agent: *\nAllow: /\nDisallow: /apply\nDisallow: /en/apply\n\nSitemap: ${origin}/sitemap.xml\n`,
    ],
  );

  // Each entry declares its counterpart, so a crawler pairs the two trees
  // instead of treating the English pages as duplicates of the Greek ones.
  const urls = sitemapPaths
    .map((p) => {
      const base = p.startsWith('/en/') ? p.slice(3) : p === '/en/' ? '/' : p;
      return (
        `  <url><loc>${origin}${p}</loc><lastmod>${lastUpdated}</lastmod>\n` +
        `    <xhtml:link rel="alternate" hreflang="el" href="${origin}${localePath('el', base)}"/>\n` +
        `    <xhtml:link rel="alternate" hreflang="en" href="${origin}${localePath('en', base)}"/>\n` +
        `  </url>`
      );
    })
    .join('\n');
  pages.push([
    'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`,
  ]);

  const { errors, warnings } = lint(pages, { controllerName: config.identity.controllerName });
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
