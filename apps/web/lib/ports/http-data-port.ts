import { api, type RequestOptions } from '@/lib/api';
import type { DataOptions, DataPort, UploadPayload } from '@libriant/shared/ports';

/**
 * The web's `DataPort`: HTTP to the NestJS API, over the existing `api()`.
 *
 * Deliberately a thin adapter and not a reimplementation. `api()` carries five
 * behaviours that took incidents to get right — the 10s deadline undici does
 * not give you, `ApiError` vs `ApiUnavailableError`, the server/browser base-URL
 * split, the `Idempotency-Key` header, and the 401 cache purge that keeps the
 * previous librarian's patron pages off a shared circulation desk. Rewriting
 * them behind an interface would mean owning them twice.
 */

/**
 * The Next.js rewrite (`next.config.mjs`) that keeps browser calls same-origin,
 * so the session cookie travels without CORS.
 *
 * Exported because it is a THREE-way coupling, not a local detail: the rewrite
 * defines it, `api()` prepends it in the browser, and `public/sw.js` decides
 * what to cache by matching `url.pathname.startsWith('/lbr-api/')`. A port that
 * quietly moved to a different prefix would keep working online and stop
 * working offline, with no test failing. `ports.test.ts` asserts sw.js still
 * contains this exact string.
 */
export const BROWSER_API_PREFIX = '/lbr-api';

function toRequest(method: RequestOptions['method'], opts?: DataOptions): RequestOptions {
  return {
    method,
    ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts?.cookie ? { cookie: opts.cookie } : {}),
  };
}

export class HttpDataPort implements DataPort {
  get<T>(path: string, opts?: DataOptions): Promise<T> {
    return api<T>(path, toRequest('GET', opts));
  }

  post<T>(path: string, body?: unknown, opts?: DataOptions): Promise<T> {
    return api<T>(path, { ...toRequest('POST', opts), body });
  }

  patch<T>(path: string, body?: unknown, opts?: DataOptions): Promise<T> {
    return api<T>(path, { ...toRequest('PATCH', opts), body });
  }

  put<T>(path: string, body?: unknown, opts?: DataOptions): Promise<T> {
    return api<T>(path, { ...toRequest('PUT', opts), body });
  }

  delete<T>(path: string, opts?: DataOptions): Promise<T> {
    return api<T>(path, toRequest('DELETE', opts));
  }

  /**
   * Builds the multipart body here rather than taking one, so `FormData` — an
   * HTTP encoding — stays out of the shared contract.
   *
   * The part name is `file` for every upload endpoint in the API
   * (`FileInterceptor('file')` in branding, covers, photos, storage and
   * import), so it is fixed rather than a parameter: a per-call part name would
   * be one more thing a native implementation has to reproduce exactly.
   */
  upload<T>(path: string, payload: UploadPayload, opts?: DataOptions): Promise<T> {
    const form = new FormData();
    for (const [k, v] of Object.entries(payload.fields ?? {})) form.set(k, v);
    const { name, type, data } = payload.file;
    const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: type ?? '' });
    form.set('file', blob, name);
    return api<T>(path, { ...toRequest('POST', opts), body: form });
  }

  /**
   * Always the BROWSER-facing URL, even during a server render.
   *
   * A server component builds an `<img src>` for a member photo and hands it to
   * the browser to load; resolving it to `API_INTERNAL_URL` — the container
   * address `api:3001` — would produce a URL that works from the render process
   * and is unreachable from the reader's laptop. `api()` makes the opposite
   * choice for the same reason (it is the one doing the fetching), which is
   * exactly why this is a separate method rather than a mode of `get`.
   */
  resourceUrl(path: string): string {
    return `${BROWSER_API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
  }
}
