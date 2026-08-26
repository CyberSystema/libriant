/**
 * What a Libriant admin may do inside a consented support window.
 *
 * ## The failure this exists to stop (authn-authz-05)
 *
 * `RolesGuard.canActivate` used to open with `if (req.impersonation) return
 * true;`, so the impersonation cookie satisfied every `@Roles(...)` annotation
 * on the tenant API with no tenant session at all. An audit probe drove that
 * with nothing but the cookie and got:
 *
 *   - `POST   /t/<slug>/staff/<id>/reset-password` → **200, plaintext temporary
 *     password in the response body**, and
 *   - `DELETE /t/<slug>/support/keys/pending`      → **204**.
 *
 * Both break the promise the feature is sold on. Support access is a consented,
 * time-boxed, library-revocable four-hour window; nothing ties `users.passwordHash`
 * to `support_sessions`, so a password handed out inside that window works from
 * the ordinary login page forever after it closes. And the key/session routes are
 * the library's own lever over support — an impersonator who can delete the
 * pending key is holding the handle to the door they came through.
 *
 * So: the window is for looking at the library's data and fixing the library's
 * records. It is not for minting credentials, changing who holds them, moving
 * money, taking bulk copies of the member database, or touching the support
 * machinery itself. Those four things are refused here.
 *
 * ## Why prefixes rather than a list of routes
 *
 * An enumerated route list is a hole waiting for the next `POST
 * /t/:slug/staff/:id/<something>` to be added by someone who never read this
 * file. The rules below deny by **tenant-relative prefix + method**, so a new
 * write route under an already-fenced prefix is denied the day it is written,
 * without anyone remembering to come back here.
 *
 * ## What this is not
 *
 * It is not the role check. The blanket `if (req.impersonation) return true;`
 * that used to sit at the top of `RolesGuard` is GONE (authn-authz-04/-05
 * follow-up): support is now checked against a fixed effective library role
 * (`admin`) by the same expression that judges a signed-in librarian, so an
 * `@Roles('owner')` route is refused under impersonation without an entry here.
 *
 * The two controls answer different questions and both are needed. The guard
 * asks "does this ROLE cover this route?"; these rules ask "may a support
 * window touch this AREA at all?" — and the four areas below are refused to
 * support even though the `admin` role covers every one of them.
 */

/** Methods that cannot change state. Everything else is a write. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type DenyRule = {
  /** Stable id — recorded on the audit rows and asserted by the tests. */
  id: string;
  /**
   * Tenant-relative path prefix, no leading slash, lowercase. Matches the
   * segment run exactly: `staff` matches `staff` and `staff/x/y`, never
   * `staffroom`.
   */
  prefix: string;
  /** `write` fences mutations only; `all` fences reads too. */
  scope: 'write' | 'all';
  /** Shown to the impersonating admin, and to the library in its own log. */
  message: string;
};

/**
 * Each entry names the specific harm, because a rule whose reason is not
 * written down is a rule the next person deletes.
 *
 * **Why almost every rule is `write` and not `all`.** The obvious tightening is
 * to fence these prefixes outright. Do not: `apps/web/.../t/[slug]/layout.tsx`
 * fetches `GET /t/:slug/billing/gate` on EVERY tenant page load, so an `all`
 * scope on `billing` would 403 the layout of every page an impersonating admin
 * opens — the support window would be unusable rather than bounded. The same
 * logic covers `support` (the library's support page reads its own key metadata
 * and log) and `staff` (support has to be able to see who works there in order
 * to help). Reads under impersonation are already recorded in
 * `support_action_log` and visible to the library at
 * `GET /t/:slug/support/sessions/log`. The harm in this finding is writes.
 */
export const DENY_RULES: readonly DenyRule[] = [
  {
    id: 'staff-write',
    prefix: 'staff',
    scope: 'write',
    message:
      'Support access cannot create staff accounts, reset staff passwords, or change staff ' +
      'roles. A password minted here would still work after this four-hour window closes, ' +
      'which is exactly what the window exists to prevent. Ask a library owner or admin to ' +
      'do it from their own account.',
  },
  {
    id: 'support-write',
    prefix: 'support',
    scope: 'write',
    message:
      "Support access cannot change this library's support keys or end its support sessions. " +
      "Those are the library's controls over you, not yours. Reading the support log is fine.",
  },
  {
    id: 'billing-write',
    prefix: 'billing',
    scope: 'write',
    message:
      "Support access cannot change this library's plan or payment setup. Plan changes are made " +
      'from the Libriant admin console against a named admin, where they are attributable.',
  },
  {
    id: 'export-write',
    prefix: 'exports',
    scope: 'write',
    message:
      'Support access cannot start a full data export. The archive would outlive this window; ' +
      'the library can export its own data at any time from Settings.',
  },
];

export type ImpersonationVerdict = {
  allowed: boolean;
  /** The rule that refused, or `null` when nothing refused. */
  rule: string | null;
  /** Refusal text for the admin. Empty when allowed. */
  message: string;
  /** Dot-namespaced verb for the tenant audit row. */
  action: 'support.blocked' | 'support.action' | 'support.read';
  /** Coarse resource label, e.g. `staff`, `catalog/books`. Never contains an id. */
  targetType: string | null;
  /** The route's `:id` param when the route has one. */
  targetId: string | null;
};

export type ClassifyInput = {
  method: string;
  /** `req.originalUrl` with the query string already removed. */
  path: string;
  /** Express route params (`req.params`) — the reliable source of the target id. */
  params?: Record<string, unknown>;
  /** `TENANT_PATH_PREFIX`; defaults to the shipped `/t/`. */
  tenantPathPrefix?: string;
};

/**
 * Decide whether an impersonated request may proceed, and describe it well
 * enough that the library's own audit log is worth reading.
 *
 * Pure on purpose: the interceptor that calls it is hard to exercise, this is
 * trivial to exercise, and the two are tested separately *and* end-to-end.
 */
export function classifyImpersonatedRequest(input: ClassifyInput): ImpersonationVerdict {
  const method = input.method.toUpperCase();
  const isRead = READ_METHODS.has(method);
  const rel = tenantRelativePath(input.path, input.tenantPathPrefix ?? '/t/');
  const segments = rel.split('/').filter((s) => s.length > 0);
  // Route matching in Express is case-insensitive by default, so `/T/acme/STAFF`
  // reaches the same handler as `/t/acme/staff`. Compare lowercased or the fence
  // is one shift key wide.
  const lower = segments.map((s) => s.toLowerCase());

  const targetType = describeTarget(segments, lower, input.params);
  const targetId = extractTargetId(input.params);

  for (const rule of DENY_RULES) {
    if (!matchesPrefix(lower, rule.prefix)) continue;
    if (rule.scope === 'write' && isRead) continue;
    return {
      allowed: false,
      rule: rule.id,
      message: rule.message,
      action: 'support.blocked',
      targetType,
      targetId,
    };
  }

  return {
    allowed: true,
    rule: null,
    message: '',
    action: isRead ? 'support.read' : 'support.action',
    targetType,
    targetId,
  };
}

/**
 * Strip `/t/<slug>` when the URL carries it. A tenant can also be resolved from
 * the Host header, in which case there is no prefix to strip and the path is
 * already tenant-relative — handle both rather than assuming the path shape.
 */
function tenantRelativePath(path: string, tenantPathPrefix: string): string {
  const clean = (path.split('?')[0] ?? '/').replace(/\/{2,}/g, '/');
  const prefix = tenantPathPrefix.endsWith('/') ? tenantPathPrefix : `${tenantPathPrefix}/`;
  if (!clean.toLowerCase().startsWith(prefix.toLowerCase())) return clean;
  const after = clean.slice(prefix.length);
  const firstSlash = after.indexOf('/');
  return firstSlash === -1 ? '' : after.slice(firstSlash + 1);
}

/** `['staff','x']` matches prefix `staff`; `['staffroom']` does not. */
function matchesPrefix(lowerSegments: string[], prefix: string): boolean {
  const want = prefix.split('/').filter((s) => s.length > 0);
  if (lowerSegments.length < want.length) return false;
  return want.every((w, i) => lowerSegments[i] === w);
}

/**
 * A label the librarian can read: the leading STATIC segments, at most two.
 * Segments that equal one of the route's param values are ids, so we stop
 * there — an id must never end up in `targetType`, which is meant to be
 * groupable.
 */
function describeTarget(
  segments: string[],
  lower: string[],
  params?: Record<string, unknown>,
): string | null {
  const paramValues = new Set(
    Object.values(params ?? {})
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.toLowerCase()),
  );
  const parts: string[] = [];
  for (let i = 0; i < lower.length && parts.length < 2; i += 1) {
    const seg = lower[i]!;
    if (paramValues.has(seg)) break;
    parts.push(segments[i]!);
  }
  if (parts.length === 0) return null;
  return parts.join('/').slice(0, 64);
}

/**
 * The target id comes from the matched route's params, not from counting path
 * segments — `/t/:slug/staff/:id/reset-password` and `/t/:slug/support/keys/pending`
 * have an id in the same position and only one of them means it.
 */
function extractTargetId(params?: Record<string, unknown>): string | null {
  if (!params) return null;
  for (const key of ['id', 'memberId', 'bookId', 'loanId', 'tenantId']) {
    const v = params[key];
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 128);
  }
  return null;
}

/**
 * Field NAMES from a request body — never values. The whole point of this
 * finding is that a plaintext password left the building; copying request
 * bodies into the control plane would be the same mistake with extra steps.
 */
export function summarizeBodyKeys(body: unknown): string[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length === 0) return null;
  return keys.slice(0, 20).map((k) => k.slice(0, 40));
}
