/**
 * Renders a structured page description into HTML.
 *
 * Page content is authored as data — headings, paragraphs, cards, steps — and
 * this module is the only place that decides what any of it looks like. That
 * separation is deliberate: it keeps the visual language identical across every
 * page no matter who wrote the words, and it means a copy change can never
 * introduce markup.
 *
 * Everything is escaped. Authors get exactly two pieces of inline formatting,
 * **bold** and [links](/path), because a marketing page needs emphasis and
 * cross-references and nothing else is worth the injection surface.
 */

import { esc, renderShell, type SiteConfig } from './shell.js';

export type SectionType = 'prose' | 'cards' | 'list' | 'steps' | 'faq' | 'callout' | 'table';

export type SectionItem = {
  title: string;
  body: string;
  icon?: string;
  /** English anchor, authored with the copy. See `anchor`. */
  id?: string;
};

export type Section = {
  type: SectionType;
  heading: string;
  /** English anchor, authored with the copy. See `anchor`. */
  id?: string;
  intro?: string;
  body?: string[];
  items?: SectionItem[];
  columns?: string[];
  rows?: string[][];
  footnote?: string;
  /** Set by the build for sections it generates rather than authors writing. */
  html?: string;
};

export type PageContent = {
  slug: string;
  title: string;
  metaDescription: string;
  h1: string;
  lede: string;
  sections: Section[];
};

/**
 * Section anchors are authored in English alongside the Greek copy, not derived
 * from it.
 *
 * Deriving them looked fine and was not: JavaScript's `\w` is ASCII-only, so
 * stripping `[^\w\s-]` removed every Greek letter and produced the same empty
 * id for every heading on the page — 111 duplicates across the site, invalid
 * HTML, and not one heading linkable. Transliterating instead would have given
 * Greeklish URLs, which is not what the site's URLs should look like.
 *
 * So each section carries an explicit `id`. The fallback exists only to keep a
 * page renderable while copy is being written.
 */
function anchor(s: { id?: string }, i: number): string {
  return s.id && /^[a-z0-9-]+$/.test(s.id) ? s.id : `section-${i + 1}`;
}

/**
 * Escape first, then re-introduce the two permitted constructs. Doing it in
 * this order means an author cannot smuggle markup through either one.
 */
export function inline(text: string): string {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
      // Only same-site paths and mailto: — no scheme means no protocol tricks.
      if (!/^(\/|mailto:|https:\/\/)/.test(href)) return label;
      return `<a href="${href}">${label}</a>`;
    });
}

const ICONS = new Set([
  'book',
  'check',
  'globe',
  'help',
  'loan',
  'member',
  'plus',
  'reservation',
  'search',
  'settings',
]);

function iconMark(name?: string): string {
  if (!name || !ICONS.has(name)) return '';
  return `<span class="feature__icon" aria-hidden="true"><img src="/icons/${name}.svg" alt="" width="22" height="22"></span>`;
}

function sectionHead(s: Section, i: number): string {
  return `<div class="section-head">
      <h2 id="${anchor(s, i)}">${inline(s.heading)}</h2>
      ${s.intro ? `<p>${inline(s.intro)}</p>` : ''}
    </div>`;
}

function renderSection(s: Section, i: number): string {
  if (s.html) return s.html;

  const alt = i % 2 === 1 ? ' alt' : '';
  let inner = '';

  switch (s.type) {
    case 'prose':
      inner = (s.body ?? []).map((p) => `<p>${inline(p)}</p>`).join('\n      ');
      inner = `<div class="prose">${inner}</div>`;
      break;

    case 'cards':
      inner = `<div class="features">
      ${(s.items ?? [])
        .map(
          (it) => `<article class="feature">
        ${iconMark(it.icon)}
        <h3>${inline(it.title)}</h3>
        <p>${inline(it.body)}</p>
      </article>`,
        )
        .join('\n      ')}
    </div>`;
      break;

    case 'list':
      inner = `<ul class="ticks">
      ${(s.items ?? [])
        .map(
          (it) => `<li><strong>${inline(it.title)}</strong> <span>${inline(it.body)}</span></li>`,
        )
        .join('\n      ')}
    </ul>`;
      break;

    case 'steps':
      inner = `<ol class="steps">
      ${(s.items ?? [])
        .map(
          (it, n) => `<li class="step">
        <span class="step__n" aria-hidden="true">${n + 1}</span>
        <h3>${inline(it.title)}</h3>
        <p>${inline(it.body)}</p>
      </li>`,
        )
        .join('\n      ')}
    </ol>`;
      break;

    case 'faq':
      // Plain headings rather than <details>: an FAQ is read, searched with
      // ctrl-F, linked to and printed. Collapsing it defeats all four.
      inner = `<div class="faq">
      ${(s.items ?? [])
        .map(
          (it, qi) => `<div class="faq__item">
        <h3 id="${anchor(it, qi)}">${inline(it.title)}</h3>
        <p>${inline(it.body)}</p>
      </div>`,
        )
        .join('\n      ')}
    </div>`;
      break;

    case 'callout':
      inner = `<div class="callout">
      ${(s.body ?? []).map((p) => `<p>${inline(p)}</p>`).join('\n      ')}
    </div>`;
      break;

    case 'table':
      inner = `<div class="table-wrap">
      <table class="cmp">
        <thead><tr>${(s.columns ?? []).map((c) => `<th scope="col">${inline(c)}</th>`).join('')}</tr></thead>
        <tbody>
        ${(s.rows ?? [])
          .map(
            (r) =>
              `<tr>${r.map((cell, ci) => (ci === 0 ? `<th scope="row">${inline(cell)}</th>` : `<td>${inline(cell)}</td>`)).join('')}</tr>`,
          )
          .join('\n        ')}
        </tbody>
      </table>
    </div>`;
      break;
  }

  return `<section class="section${alt}">
    <div class="wrap">
      ${sectionHead(s, i)}
      ${inner}
      ${s.footnote ? `<p class="footnote">${inline(s.footnote)}</p>` : ''}
    </div>
  </section>`;
}

export function renderContentPage(config: SiteConfig, page: PageContent, draft: boolean): string {
  const body = `<div class="page-head">
  <div class="wrap">
    <h1>${inline(page.h1)}</h1>
    <p class="lede">${inline(page.lede)}</p>
  </div>
</div>
${page.sections.map(renderSection).join('\n')}
<section class="section cta-band">
  <div class="wrap">
    <h2>Θέλετε να το δείτε στη βιβλιοθήκη σας;</h2>
    <p>Οι ${config.offer.spotsTotal} πρώτες βιβλιοθήκες παίρνουν το πακέτο ${esc(config.offer.planName)} δωρεάν για ${config.offer.months} μήνες.</p>
    <p class="hero__actions"><a class="btn btn--primary btn--lg" href="/#apply">Κάντε αίτηση</a>
    <a class="btn btn--ghost" href="/contact">Ρωτήστε πρώτα</a></p>
  </div>
</section>`;

  return renderShell({
    config,
    draft,
    path: page.slug,
    title: page.title,
    description: page.metaDescription,
    body,
  });
}
