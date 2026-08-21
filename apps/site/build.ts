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

  const lastUpdated = new Date().toISOString().slice(0, 10);
  const tokens: Record<string, string> = {
    LAST_UPDATED: lastUpdated,
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
    ['404.html', render404(config, draft)],
    ['styles.css', STYLESHEET],
    [
      'robots.txt',
      `User-agent: *\nAllow: /\nDisallow: /apply\n\nSitemap: ${config.site.origin.replace(/\/$/, '')}/sitemap.xml\n`,
    ],
  ];

  const origin = config.site.origin.replace(/\/$/, '');
  const urls = ['/', '/oroi-programmatos', '/aporrito']
    .map((p) => `  <url><loc>${origin}${p}</loc><lastmod>${lastUpdated}</lastmod></url>`)
    .join('\n');
  pages.push([
    'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  ]);

  for (const [name, contents] of pages) {
    writeFileSync(join(DIST, name), contents, 'utf8');
  }

  const copied = copyPublic(join(HERE, 'public'), DIST);

  console.log(
    `✓ built ${pages.length} files + ${copied} static asset(s) → apps/site/dist${draft ? '  (DRAFT)' : ''}`,
  );
}

main();
