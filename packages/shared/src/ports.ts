/**
 * The three seams a staff screen is allowed to reach the outside world through.
 *
 * ## Why this file exists
 *
 * M8 replaces the Electron shell — a browser in a box loading `app.libriant.com`
 * — with a Tauri client over a Rust core and an encrypted local replica. On that
 * client there is no `/lbr-api` origin, no session cookie, and often no network.
 * A screen that calls `fetch('/lbr-api/…')` cannot run there, and a screen that
 * calls `window.open()` to print cannot print there.
 *
 * Today that is not hypothetical: `apps/web` reaches the API through exactly one
 * function (`lib/api.ts`), which decides everything by sniffing `typeof window`
 * and hard-codes `/lbr-api` for the browser. Sixty screens depend on that shape.
 * If phase 20 onward keeps writing them that way, M8 is a rewrite of sixty
 * screens rather than three new classes.
 *
 * So the rule, from phase 20 onward: **a screen depends on these interfaces, and
 * an implementation is chosen once at the root.** The web supplies
 * `HttpDataPort` / `BrowserPlatformPort` / `BrowserPrintPort` (+ the desktop
 * bridge variant); the Tauri client supplies its own three. Neither knows about
 * the other, and an ESLint rule (`no-restricted-syntax`, `eslint.config.mjs`)
 * fails the build on a bare `fetch(` or a hard-coded `/lbr-api` inside a screen.
 *
 * ## Why interfaces and not a base class
 *
 * These types must be readable from a package with no DOM lib, no React and no
 * Node built-ins, because the Tauri client compiles a different way. This file
 * therefore has **no runtime exports at all** — importing it costs nothing and
 * cannot drag a browser API into a build that has none.
 *
 * ## Two things about this file's own wiring
 *
 * It is reachable as `@libriant/shared/ports` and is deliberately NOT re-exported
 * from `src/index.ts`. The barrel is what `apps/api`, `db-tenant`, `db-control`
 * and `apps/site` import, and none of them should see a client-side port. That
 * asymmetry is a decision, not an omission — `check:shared-imports` cannot tell
 * the two apart, so it is written down here.
 *
 * And the ESLint rule that enforces this boundary only runs under the ROOT
 * `pnpm lint`. Every package's own `lint` script is `echo 'lint: ok'`, so
 * `turbo run lint` and `pnpm --filter @libriant/web lint` are green whatever the
 * rule says.
 *
 * ## 1.0 screens are deliberately NOT converted
 *
 * They are replaced at phase 20. What phase 6 does convert is the handful of
 * places that would otherwise need an `eslint-disable` on day one — the four
 * multipart uploads and the direct `/lbr-api` asset URLs — because a rule that
 * ships with exemptions is a rule nobody believes.
 */

/**
 * The uniform answer from a host capability that can decline.
 *
 * Deliberately the same shape the Electron bridge already returns
 * (`apps/desktop/src/main.ts` — `type Ack = { ok: boolean; reason?: string }`),
 * so `DesktopPrintPort` is a pass-through and the browser implementations
 * borrow its vocabulary rather than inventing a second one. `reason` is a
 * machine-readable slug (`'popup-blocked'`, `'bridge-error'`, `'unsupported'`),
 * never prose to show a librarian.
 */
export type PortAck = { readonly ok: boolean; readonly reason?: string };

// ---------------------------------------------------------------------------
// DataPort
// ---------------------------------------------------------------------------

/** The HTTP-shaped verbs a screen may ask for. */
export type DataMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type DataOptions = {
  /**
   * Stable key for a non-idempotent action. A retry or double-submit carrying
   * the SAME key replays the first result instead of acting twice.
   *
   * Load-bearing beyond the browser: the offline queue replays a queued action
   * with its original key hours later, and phase 78's sync push does the same
   * from the native client. An implementation that drops this header turns
   * every reconnect into a double checkout.
   */
  readonly idempotencyKey?: string;
  /**
   * Per-request deadline in milliseconds. Omitted means the implementation's
   * default (10s on the web); `0` disables it, which is only ever right for a
   * stream the user started deliberately.
   */
  readonly timeoutMs?: number;
  /**
   * Cookie header for a server-side render. Browser and native callers leave
   * this alone — the browser attaches its own cookie and the native client
   * authenticates with a device token instead (phase 79).
   */
  readonly cookie?: string;
};

/**
 * A file being sent to the library, described without naming a transport.
 *
 * `Blob` rather than `File` because `File` exists only where there is a file
 * picker; a `File` from an `<input>` already IS a `Blob`, and a native host can
 * hand over bytes it read itself.
 */
export type UploadFile = {
  readonly name: string;
  /** MIME type as the source declared it. The server sniffs the content anyway. */
  readonly type?: string;
  readonly data: Blob | Uint8Array;
};

export type UploadPayload = {
  readonly file: UploadFile;
  /**
   * Accompanying string fields — the CSV import sends `entityKind`, `format`,
   * `encoding`, `delimiter` and `hasHeader` alongside the file.
   */
  readonly fields?: Readonly<Record<string, string>>;
};

/**
 * Everything a screen knows about where the library's data lives.
 *
 * Paths are API paths — `/t/acme/loans`, never `/lbr-api/t/acme/loans`. The
 * `/lbr-api` prefix is one implementation's rewrite, not part of the contract,
 * and a screen that spells it out has hard-coded the transport.
 *
 * The path itself DOES stay in the contract, on purpose. It is the routing key
 * the whole platform already agrees on: the offline queue persists actions as
 * `{method, path}` and replays them hours later, and phase 78's sync push
 * re-executes the identical service methods from the same pair. A port whose
 * vocabulary were named operations instead would need a second registry
 * mapping them back to paths, and every queued action written by an older
 * build would become unreplayable.
 *
 * ### Requirements on every implementation
 *
 * 1. **A non-2xx response throws.** The web throws `ApiError` carrying the
 *    status and parsed body; a native implementation must throw something
 *    `translateApiError()` can read. Returning an error value would make every
 *    call site grow a branch that the 1.0 screens do not have.
 * 2. **A transport failure is distinguishable from a rejection.** "The server
 *    said no" and "the server never answered" are different sentences to a
 *    librarian and different decisions for the offline queue, which retries the
 *    second and not the first.
 * 3. **A 401 purges locally cached personal data before the error propagates.**
 *    This is a security property, not a nicety: `apps/web/lib/api.ts` clears the
 *    offline read caches on 401 so the next person on a shared circulation desk
 *    cannot be served the previous librarian's patron pages. A native
 *    implementation has a different cache — an encrypted SQLite replica — and
 *    the obligation is the same. It is stated here because it is the one
 *    behaviour that would otherwise be lost silently in the port.
 */
export interface DataPort {
  get<T>(path: string, opts?: DataOptions): Promise<T>;
  post<T>(path: string, body?: unknown, opts?: DataOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, opts?: DataOptions): Promise<T>;
  put<T>(path: string, body?: unknown, opts?: DataOptions): Promise<T>;
  delete<T>(path: string, opts?: DataOptions): Promise<T>;
  /**
   * Upload a file — a cover image, a member photo, a branding logo, an import
   * CSV.
   *
   * Separate from `post` because the body is not JSON. It is on the DATA port
   * rather than the platform port because it moves a record into the library's
   * collection; choosing the file is the platform's job, and sending it is this
   * one's.
   *
   * Takes an {@link UploadPayload} rather than a `FormData` deliberately.
   * `FormData` is an HTTP encoding, and a port that names it has already
   * decided the transport: a native host writing to a local replica has bytes
   * and a filename, not a multipart body. (Note that `packages/shared`'s
   * tsconfig does NOT stop you from writing `FormData` here — `@types/node`
   * declares it globally, so this is a rule the reviewer keeps, not the
   * compiler.)
   */
  upload<T>(path: string, payload: UploadPayload, opts?: DataOptions): Promise<T>;
  /**
   * A URL the **rendering surface** can load directly — an `<img src>` for a
   * cover, an `<a href>` for a CSV download.
   *
   * Not a fetch. This exists because a browser can stream a
   * `Content-Disposition: attachment` response far better than any JavaScript
   * can, and because a server component must be able to hand the browser a URL
   * without making the request itself. It therefore always returns a
   * BROWSER-facing URL even when called during a server render — the one place
   * this contract is not symmetric, and the reason it is a named method rather
   * than string concatenation at each call site.
   */
  resourceUrl(path: string): string;
}

// ---------------------------------------------------------------------------
// PlatformPort
// ---------------------------------------------------------------------------

/** Which host is underneath. Screens should branch on a CAPABILITY, not on this. */
export type PlatformKind = 'browser' | 'desktop' | 'native';

/**
 * The host capabilities a screen needs that are not data.
 *
 * Kept to what screens measurably use today rather than what a host could
 * offer: clipboard writes (support-access codes, recovery codes, outbox ids),
 * connectivity (the offline queue flushes on reconnect), and opening a link
 * outside the app. A capability nobody calls is a capability M8 has to
 * implement for nothing.
 */
export interface PlatformPort {
  readonly kind: PlatformKind;
  /**
   * Best-effort connectivity. `navigator.onLine` is famously optimistic — it
   * reports a captive portal as online — so treat a `true` as "worth trying",
   * never as a guarantee, and let the request's own failure be the authority.
   */
  isOnline(): boolean;
  /** Subscribe to connectivity changes. Returns an unsubscribe function. */
  onOnlineChange(listener: (online: boolean) => void): () => void;
  /** Copy plain text to the system clipboard. */
  copyText(text: string): Promise<PortAck>;
  /**
   * Open a URL OUTSIDE the app — the user's real browser on desktop and
   * native, a new tab in the browser.
   *
   * Implementations must refuse anything but `http:`/`https:`. The Electron
   * shell already does (`apps/desktop/src/main.ts`), and the reason generalises:
   * this method is reachable from any screen, so a `file:` or `javascript:` URL
   * arriving from an API response must not become code execution on the host.
   */
  openExternal(url: string): Promise<PortAck>;
}

// ---------------------------------------------------------------------------
// PrintPort
// ---------------------------------------------------------------------------

export type PrintKind = 'receipt' | 'label';

export type PrintTarget = {
  readonly locale: string;
  readonly slug: string;
  readonly kind: PrintKind;
  /** Loan id for a receipt, copy id for a label. */
  readonly id: string;
  /** Required for a label — the copy's book id (there is no copy-by-id fetch). */
  readonly bookId?: string;
};

/** A printer the host can reach. Empty list means "the host chooses". */
export type PrintDestination = {
  readonly name: string;
  readonly displayName: string;
  readonly isDefault: boolean;
};

/**
 * Put a receipt or a spine label on paper.
 *
 * This port is a formalisation, not a new idea: `apps/web/lib/print.ts` already
 * had two implementations written as an `if (bridge)` inside one function —
 * silent printing through the desktop bridge, or `window.open` on a print route
 * for the browser. Phase 34 adds hand-rolled ESC/POS and ZPL, and M8 adds the
 * Tauri host; naming the seam now is what stops that if/else growing a third and
 * fourth branch in a file every screen imports.
 */
export interface PrintPort {
  print(target: PrintTarget): Promise<PortAck>;
  /**
   * Printers the host can enumerate. `[]` means it cannot (every browser), which
   * is a valid answer and not an error — the UI hides the picker rather than
   * showing an empty one.
   */
  listDestinations(): Promise<readonly PrintDestination[]>;
}
