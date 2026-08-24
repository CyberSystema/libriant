/**
 * The one place the API is allowed to build a URL that points back into the
 * web app.
 *
 * WHY THIS FILE EXISTS (billing-01).
 * `startCheckout` and `openCustomerPortal` each hand-assembled
 * `${BILLING_RETURN_URL}/t/<slug>/billing`. The web app has exactly ONE
 * billing route — `apps/web/app/[locale]/t/[slug]/billing/page.tsx`, four path
 * segments with the locale MANDATORY — and there is no root-level catch-all,
 * no Next middleware, and no rewrite in next.config.mjs or the Caddyfile that
 * would rescue a locale-less path. Neither web caller ever sends `returnPath`,
 * so the locale-less fallback was what Stripe received every time. The auditor
 * booted the production build and got it in writing:
 *
 *     /t/demo/billing?checkout=success  -> 404 ("could not be found")
 *     /el/t/demo/billing                -> 307 (the route exists)
 *
 * A library that had just paid landed on "This page could not be found". The
 * charge and the webhook-driven provisioning were both fine; what broke was
 * the first thing a paying customer sees.
 *
 * The mechanism behind the bug is not the missing segment — it is that a web
 * route shape was written as a string literal at two call sites with nothing
 * anywhere asserting it matched a route that exists. So: one builder, one
 * declared route shape, and a spec that pins the shape against the route file
 * on disk. Adding a third caller cannot reintroduce this without deleting the
 * test.
 */

/**
 * Locales the web app serves, mirroring `packages/i18n/src/locales.ts`.
 *
 * Duplicated rather than imported because `apps/api` does not depend on
 * `@libriant/i18n` and adding a workspace dependency is an install, not an
 * edit. `apps/api/src/help/help.service.ts:4` already carries the same local
 * copy for the same reason. The spec asserts this list matches the package, so
 * the duplication cannot silently drift.
 */
export const WEB_LOCALES = ['en', 'el'] as const;
export type WebLocale = (typeof WEB_LOCALES)[number];

/** Greek first — the launch market. Matches `DEFAULT_LOCALE` in @libriant/i18n. */
export const DEFAULT_WEB_LOCALE: WebLocale = 'el';

export function isWebLocale(value: string | null | undefined): value is WebLocale {
  return !!value && (WEB_LOCALES as readonly string[]).includes(value);
}

/**
 * The billing page's route shape, exactly as Next declares it. Kept as a
 * template so the spec can compare it against the directory tree under
 * `apps/web/app/` rather than against another copy of the same guess.
 */
export const BILLING_ROUTE_TEMPLATE = '/[locale]/t/[slug]/billing';

/**
 * Resolve the locale to send a returning browser to.
 *
 * The tenant's `defaultLocale` is the best answer available on the server: the
 * API has no session locale on the billing routes, and the browser's own
 * Accept-Language is not carried through Stripe's redirect. A tenant row that
 * somehow holds an unsupported value falls back to Greek rather than producing
 * a 404 for a second time.
 */
export function resolveWebLocale(tenantDefaultLocale?: string | null): WebLocale {
  return isWebLocale(tenantDefaultLocale) ? tenantDefaultLocale : DEFAULT_WEB_LOCALE;
}

/**
 * Is this path already anchored on a locale segment (`/el`, `/en/...`)?
 * A caller that knows the browser's locale may pass a fully-formed path; we
 * must not prefix a second locale onto it.
 */
function hasLocalePrefix(path: string): boolean {
  const first = path.split('/')[1] ?? '';
  return isWebLocale(first);
}

/**
 * Accept a caller-supplied `returnPath` only if it is unambiguously a path on
 * our own origin.
 *
 * `startsWith('/')` — the old test — also accepts `//evil.example` and
 * `/\evil.example`, which some clients normalise to a different host. Stripe
 * would reject the resulting URL, but the failure would surface as "checkout
 * is broken" rather than "your input was refused", so refuse it here where the
 * reason is legible. Anything suspicious falls back to the tenant's billing
 * page, which is where the caller was going anyway.
 */
function isSafeRelativePath(path: string | undefined): path is string {
  if (!path || !path.startsWith('/')) return false;
  if (path.startsWith('//') || path.startsWith('/\\')) return false;
  if (/[\r\n\t]/.test(path)) return false;
  return true;
}

/**
 * Build an absolute URL into the web app for a tenant.
 *
 * @param base    `BILLING_RETURN_URL`, with or without a trailing slash.
 * @param locale  Resolved via `resolveWebLocale(tenant.defaultLocale)`.
 * @param slug    Tenant slug — the `[slug]` segment.
 * @param returnPath Optional caller override. Prefixed with the locale when it
 *                   does not already carry one, so a client that sends the
 *                   short form still lands on a route that exists.
 * @param query   Appended verbatim (no leading `?`).
 */
export function buildWebReturnUrl(input: {
  base: string;
  locale: WebLocale;
  slug: string;
  returnPath?: string;
  query?: string;
}): string {
  const base = input.base.replace(/\/+$/, '');
  const raw = isSafeRelativePath(input.returnPath) ? input.returnPath : `/t/${input.slug}/billing`;
  const path = hasLocalePrefix(raw) ? raw : `/${input.locale}${raw}`;
  return input.query ? `${base}${path}?${input.query}` : `${base}${path}`;
}
