/**
 * Turn any failure from `api()` into a sentence in the reader's language.
 *
 * The API raises 336 exceptions and every one of them carries a hardcoded
 * English string ("Member not found.", "Due date must be after the checkout
 * date — pick a later day."). Those used to be rendered verbatim: an English
 * sentence in the middle of an otherwise Greek circulation desk. Since the API
 * is a separate deployable that does not yet emit machine codes, we translate
 * on this side — by `code` when one arrives, otherwise by HTTP status — and
 * keep the English original for the console, where an operator wants it.
 *
 * Nothing here ever returns `err.message`. An unmapped failure gets the
 * caller's contextual fallback, or the generic catalogue entry with a copyable
 * reference. The day the API starts sending `{ code: 'loans.dueBeforeCheckout' }`
 * the only change needed is a new `errors.api.*` key in both catalogues.
 */
import type { Translator } from '@libriant/i18n';
import { ApiError, ApiUnavailableError } from '@/lib/api';

/**
 * Status → catalogue key for the shapes the API actually produces. 402 and 503
 * are handled separately below because their bodies carry the detail that makes
 * the message useful (which quota, which kind of downtime).
 */
const STATUS_KEYS: Record<number, string> = {
  400: 'errors.http.badRequest',
  401: 'errors.http.unauthenticated',
  403: 'errors.permission.denied',
  404: 'errors.notFound.description',
  405: 'errors.http.badRequest',
  409: 'errors.http.conflict',
  410: 'errors.notFound.description',
  413: 'errors.http.tooLarge',
  415: 'errors.http.unsupportedMedia',
  422: 'errors.http.badRequest',
  429: 'errors.http.rateLimited',
};

/**
 * `createTranslator` returns the key itself when the catalogue has no entry, so
 * that is our "not translated" signal — a real translation is never identical
 * to its own dotted id.
 */
function maybe(t: Translator, id: string, values?: Record<string, string | number>): string | null {
  const out = t(id, values);
  return out === id ? null : out;
}

function statusKey(status: number): string | null {
  const exact = STATUS_KEYS[status];
  if (exact) return exact;
  if (status >= 500) return 'errors.http.server';
  return null;
}

/**
 * A 402 from `PlanGuard` / `QuotaInterceptor` carries `{ feature, limit?, used? }`.
 * With a `limit` it's a quota ceiling; without one it's a feature the plan
 * simply doesn't include.
 */
function planMessage(body: Record<string, unknown>, t: Translator): string {
  const feature = typeof body.feature === 'string' ? body.feature : null;
  const resource = feature ? maybe(t, `errors.feature.${feature}`) : null;
  const limit = typeof body.limit === 'number' ? body.limit : null;
  if (limit === null) {
    return resource
      ? t('errors.planFeature.named', { feature: resource })
      : t('errors.planFeature.description');
  }
  return resource
    ? t('errors.quotaExceeded.description', { limit, resource })
    : t('errors.quotaExceeded.descriptionUnnamed', { limit });
}

/** The maintenance middleware answers 503 with `reason` so we can be specific. */
function unavailableMessage(body: Record<string, unknown>, t: Translator): string {
  if (body.reason === 'read_only') return t('system.readOnly.body');
  if (body.reason === 'maintenance') return t('errors.http.maintenance');
  return t('errors.http.unavailable');
}

export function translateApiError(err: unknown, t: Translator, fallback?: string): string {
  if (err instanceof ApiUnavailableError) {
    return t(err.reason === 'timeout' ? 'errors.network.timeout' : 'errors.network.unreachable');
  }

  if (err instanceof ApiError) {
    // Keep the API's English wording where an operator can read it — the
    // browser console and the server log — but never on screen.
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[api] ${err.status} ${err.code ?? ''} ${err.message}`);
    }
    // A code, when the endpoint sends one, beats guessing from the status.
    if (err.code) {
      const byCode = maybe(t, `errors.api.${err.code}`);
      if (byCode) return byCode;
    }
    if (err.status === 402) return planMessage(err.body, t);
    if (err.status === 503) return unavailableMessage(err.body, t);
    const key = statusKey(err.status);
    if (key) return t(key);
    return fallback ?? t('errors.generic.description', { code: `E${err.status}` });
  }

  // The multipart uploads call `fetch` directly (FormData can't go through the
  // JSON wrapper), so their deadline and their transport failures arrive raw.
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return t('errors.network.timeout');
  if (err instanceof TypeError) return t('errors.network.unreachable');

  // Not an API failure at all — a bug in our own client code, or the browser
  // refusing the request. Nothing here is worth showing verbatim either.
  //
  // Every key this function can reach lives in the `errors` or `system`
  // namespace on purpose, so the helper also works against the two-namespace
  // catalogue bundled for the error boundaries (lib/static-catalog.ts).
  return fallback ?? t('errors.generic.title');
}
