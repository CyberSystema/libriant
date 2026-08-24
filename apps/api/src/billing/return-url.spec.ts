import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BILLING_ROUTE_TEMPLATE,
  DEFAULT_WEB_LOCALE,
  WEB_LOCALES,
  buildWebReturnUrl,
  resolveWebLocale,
} from './return-url.js';

/**
 * billing-01. Stripe's success/cancel URLs and the Customer Portal's
 * return_url all pointed at `/t/<slug>/billing`, a path the web app has never
 * served: its one billing route is `/[locale]/t/[slug]/billing` and the locale
 * segment is mandatory. Every library that paid landed on "This page could not
 * be found".
 *
 * The reason it survived is that the route shape lived as a string literal at
 * two call sites and nothing compared it to a route that exists. So the first
 * test here does not check another copy of the shape — it checks the FILE
 * TREE. Move or rename the billing page and this fails, in the API package,
 * before anyone pays.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

/** Turn `/[locale]/t/[slug]/billing` into the directory Next would serve it from. */
function routeDir(template: string): string {
  return path.join(REPO_ROOT, 'apps', 'web', 'app', ...template.split('/').filter(Boolean));
}

describe('the billing route shape the API builds URLs for', () => {
  it('matches a page that actually exists in apps/web', () => {
    const dir = routeDir(BILLING_ROUTE_TEMPLATE);
    expect(
      existsSync(path.join(dir, 'page.tsx')),
      `No page.tsx under ${dir} — the API is building URLs for a route the web app does not serve.`,
    ).toBe(true);
  });

  it('has NO locale-less variant to fall back on', () => {
    // The exact 404 the auditor booted the production build to prove. There is
    // no root-level catch-all, no middleware and no rewrite: if this directory
    // ever appears, the assumption behind the locale prefix has changed and
    // this file should be revisited rather than quietly relied on.
    const dir = routeDir('/t/[slug]/billing');
    expect(existsSync(dir)).toBe(false);
  });

  it('lists the same locales as the i18n package', async () => {
    // WEB_LOCALES is a deliberate duplicate (apps/api does not depend on
    // @libriant/i18n). Duplicates drift; this is the tripwire.
    const mod = (await import(path.join(REPO_ROOT, 'packages', 'i18n', 'src', 'locales.ts'))) as {
      SUPPORTED_LOCALES: readonly string[];
      DEFAULT_LOCALE: string;
    };
    expect([...WEB_LOCALES].sort()).toEqual([...mod.SUPPORTED_LOCALES].sort());
    expect(DEFAULT_WEB_LOCALE).toBe(mod.DEFAULT_LOCALE);
  });
});

describe('buildWebReturnUrl', () => {
  const base = 'https://app.libriant.test';

  it('prefixes the locale, so Stripe sends the browser to a route that exists', () => {
    expect(buildWebReturnUrl({ base, locale: 'el', slug: 'acme' })).toBe(
      'https://app.libriant.test/el/t/acme/billing',
    );
  });

  it('produces a path matching the declared route shape', () => {
    const url = new URL(buildWebReturnUrl({ base, locale: 'en', slug: 'acme' }));
    const shape = url.pathname
      .split('/')
      .filter(Boolean)
      .map((seg, i) => (i === 0 ? '[locale]' : seg === 'acme' ? '[slug]' : seg));
    expect('/' + shape.join('/')).toBe(BILLING_ROUTE_TEMPLATE);
  });

  it('appends the query without losing the locale', () => {
    expect(buildWebReturnUrl({ base, locale: 'el', slug: 'acme', query: 'checkout=success' })).toBe(
      'https://app.libriant.test/el/t/acme/billing?checkout=success',
    );
  });

  it('tolerates a trailing slash on BILLING_RETURN_URL', () => {
    expect(buildWebReturnUrl({ base: base + '/', locale: 'el', slug: 'acme' })).toBe(
      'https://app.libriant.test/el/t/acme/billing',
    );
  });

  it('prefixes a caller-supplied path that forgot the locale', () => {
    expect(
      buildWebReturnUrl({ base, locale: 'en', slug: 'acme', returnPath: '/t/acme/billing' }),
    ).toBe('https://app.libriant.test/en/t/acme/billing');
  });

  it('leaves a caller-supplied path that already carries a locale alone', () => {
    expect(
      buildWebReturnUrl({ base, locale: 'el', slug: 'acme', returnPath: '/en/t/acme/settings' }),
    ).toBe('https://app.libriant.test/en/t/acme/settings');
  });

  it.each(['//evil.example/x', '/\\evil.example', 'https://evil.example', 'no-leading-slash'])(
    'refuses returnPath %j and falls back to the tenant billing page',
    (bad) => {
      expect(buildWebReturnUrl({ base, locale: 'el', slug: 'acme', returnPath: bad })).toBe(
        'https://app.libriant.test/el/t/acme/billing',
      );
    },
  );
});

describe('resolveWebLocale', () => {
  it('uses the tenant default when it is a locale we serve', () => {
    expect(resolveWebLocale('en')).toBe('en');
  });

  it('falls back to Greek rather than emitting a second 404', () => {
    for (const bad of [null, undefined, '', 'de', 'el-GR']) {
      expect(resolveWebLocale(bad)).toBe('el');
    }
  });
});
