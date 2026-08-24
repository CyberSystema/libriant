/**
 * Browser + server-side fetch wrapper for the Libriant API.
 *
 * Two callers:
 *   - **Server components / route handlers** — pass an explicit cookie
 *     string (read via `next/headers` ➜ `cookies()`). The fetch runs
 *     against the API's internal address (`API_INTERNAL_URL`), which on
 *     the single-host topology is the same as the public URL but lets us
 *     hop straight to the API container in compose / Kubernetes.
 *   - **Client components** — call with no cookie; the browser ships its
 *     own session cookie automatically and the request goes through the
 *     public origin.
 *
 * Both paths produce a typed `ApiError` for non-2xx responses and a typed
 * `ApiUnavailableError` when the API never answered at all, so callers can
 * render a single, plain-language toast / banner. Turn either into a sentence
 * with `translateApiError()` — never with `err.message`, which is the API's
 * hardcoded English.
 */

export type ApiErrorBody = {
  statusCode?: number;
  error?: string;
  message?: string | string[];
  /** Some endpoints (auth, quota) tag the payload with extra context. */
  [key: string]: unknown;
};

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  /**
   * Machine-readable error code, when the endpoint sends one. `message` is the
   * API's English prose and must never be shown to a librarian as-is — use
   * `translateApiError()` (lib/api-errors.ts), which prefers this code.
   */
  readonly code: string | null;
  constructor(status: number, body: ApiErrorBody) {
    const friendly = Array.isArray(body.message) ? body.message.join(' ') : body.message;
    super(friendly ?? `API error (${status})`);
    this.status = status;
    this.body = body;
    this.code = typeof body.code === 'string' && body.code.length ? body.code : null;
  }
}

/**
 * The API never answered — the request timed out, or the socket/DNS/TLS never
 * got far enough to produce a status. Distinct from `ApiError` (which means the
 * API *did* answer, unhappily) so the UI can say "the server is not responding"
 * instead of leaking `TypeError: fetch failed`, and so the offline queue keeps
 * treating it as "no connectivity" rather than a rejected action.
 */
export class ApiUnavailableError extends Error {
  readonly reason: 'timeout' | 'network';
  constructor(reason: 'timeout' | 'network', options?: { cause?: unknown }) {
    super(reason === 'timeout' ? 'The API did not respond in time.' : 'The API is unreachable.', {
      cause: options?.cause,
    });
    this.name = 'ApiUnavailableError';
    this.reason = reason;
  }
}

/**
 * Deadline for a request a person is waiting on.
 *
 * Node's undici has no overall response deadline — only a 300 s
 * `headersTimeout` — so an upstream that accepted the socket and then went
 * quiet (deadlocked Prisma pool, saturated Postgres, half-open TCP through
 * Caddy) held the server render for five minutes before failing. Librarians
 * reload long before that, so every reload piled another wedged render onto
 * the same wedged API. 10 s is comfortably above the slowest healthy request
 * we serve and short enough to fail while the user is still looking at the tab.
 *
 * `NEXT_PUBLIC_` so the browser bundle and the server render agree on the knob.
 */
export const API_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_API_TIMEOUT_MS) || 10_000;

/**
 * Deadline for endpoints that legitimately do work before answering — the CSV
 * import validate/commit pass and the multipart uploads. Nobody expects these
 * to be instant, but they still must not inherit undici's five minutes. Pass
 * `timeoutMs: API_JOB_TIMEOUT_MS` explicitly at those call sites.
 */
export const API_JOB_TIMEOUT_MS = 60_000;

/**
 * `AbortSignal.timeout` rejects with a `TimeoutError` DOMException; a caller's
 * own abort surfaces as `AbortError`. Everything else thrown by `fetch` is a
 * transport failure. Match on `name` rather than `instanceof DOMException`,
 * which is not reliable across the server/browser split.
 */
function asUnavailable(err: unknown): ApiUnavailableError {
  const name = (err as { name?: unknown })?.name;
  const timedOut = name === 'TimeoutError' || name === 'AbortError';
  return new ApiUnavailableError(timedOut ? 'timeout' : 'network', { cause: err });
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** JSON body. Passed through `JSON.stringify` if it's not already a string. */
  body?: unknown;
  /** Override for server-side calls. Browser code can leave this undefined. */
  cookie?: string;
  /** Per-request override of the API base URL. */
  baseUrl?: string;
  /** Add custom headers — usually not needed. */
  headers?: Record<string, string>;
  /**
   * Stable key for a non-idempotent action (checkout/return/renew/…). Sent as
   * the `Idempotency-Key` header; a retry/double-submit with the SAME key
   * replays the original result instead of acting twice. Generate once per
   * logical action and reuse across retries (see `useIdempotencyKey`).
   */
  idempotencyKey?: string;
  /**
   * `Cache-Control`-shaped hint forwarded to `fetch()`. Defaults to
   * `'no-store'` so authenticated pages never serve a stale tenant's data.
   */
  cache?: RequestCache;
  /**
   * Per-request deadline in milliseconds. Defaults to `API_TIMEOUT_MS`; pass
   * `API_JOB_TIMEOUT_MS` for import/export-class work. `0` disables the
   * deadline entirely — only for a stream the user explicitly started.
   */
  timeoutMs?: number;
};

function resolveBase(opts: RequestOptions): string {
  if (opts.baseUrl) return opts.baseUrl.replace(/\/$/, '');
  // Server-side: hit the API directly. In single-host dev that's also
  // localhost:3001; in production it's the container's internal name.
  if (typeof window === 'undefined') {
    return (
      process.env.API_INTERNAL_URL ??
      process.env.NEXT_PUBLIC_API_URL ??
      'http://localhost:3001'
    ).replace(/\/$/, '');
  }
  // Client-side: use the Next.js rewrite at `/lbr-api/*` so the request
  // stays same-origin with the web app and the session cookie travels
  // both directions without CORS or `SameSite` headaches.
  return '/lbr-api';
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const base = resolveBase(opts);
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.headers ?? {}),
  };
  if (opts.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.cookie) headers['Cookie'] = opts.cookie;

  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
    // Browser path needs credentials; server path uses the explicit Cookie
    // header and ignores this.
    credentials: typeof window === 'undefined' ? undefined : 'include',
    cache: opts.cache ?? 'no-store',
  };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  const timeoutMs = opts.timeoutMs ?? API_TIMEOUT_MS;
  if (timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw asUnavailable(err);
  }
  // 204 / 205 carry no body; everything else we parse.
  if (res.status === 204 || res.status === 205) {
    return undefined as T;
  }
  // The deadline covers the body too, so a connection that dies mid-stream
  // lands here rather than as an unhandled rejection.
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw asUnavailable(err);
  }
  let parsed: unknown = null;
  if (text.length) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { message: text };
    }
  }
  if (!res.ok) {
    // A10-02: session lost → wipe cached pages/data (PII) NOW, while online, so
    // the next user on a shared device can't be served them offline. Caches-only
    // (keeps the offline queue); fire-and-forget; browser-only (dynamic import
    // avoids pulling IndexedDB helpers into server bundles).
    if (res.status === 401 && typeof window !== 'undefined') {
      void import('@/lib/offline').then((m) => m.clearOfflineReadCaches()).catch(() => undefined);
    }
    throw new ApiError(res.status, (parsed ?? {}) as ApiErrorBody);
  }
  return parsed as T;
}

// -- Common shapes returned by the API ---------------------------------------

export type AuthMeResponse = {
  user: {
    id: string;
    email: string | null;
    username: string | null;
    fullName: string;
    role: 'owner' | 'admin' | 'librarian' | 'volunteer';
    mustChangeCredentials: boolean;
    /** Email-account confirmed (or staff, which has no email). Soft gate. */
    emailVerified: boolean;
  };
  tenant: {
    id: string;
    slug: string;
    name: string;
    defaultLocale: string;
    brandColor?: string | null;
    brandLogoRef?: string | null;
  };
};

export type BillingSnapshot = {
  tenantId: string;
  tenantSlug: string;
  billingMode: 'stripe' | 'manual';
  status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'paused';
  plan: { id: string; slug: string; name: string };
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  paidUntil: string | null;
  graceUntil: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  driver: 'real' | 'fake';
  /** When false, plan/quota enforcement is off — all features are free. */
  billingEnabled: boolean;
  /** Whether the library has explicitly chosen a plan. When billingEnabled is
   *  true and this is false, the library is shown the forced plan chooser. */
  planSelected: boolean;
};

export type ListResponse<T> = { items: T[]; nextCursor: string | null };
