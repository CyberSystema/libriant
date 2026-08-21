/**
 * Libriant marketing site Worker.
 *
 * Static pages are served by the Assets binding; this Worker only owns the
 * handful of routes listed in `run_worker_first` in `wrangler.jsonc`:
 *
 *   POST /apply             the launch-offer application form
 *   GET  /apply             stray navigation → back to the form
 *   GET  /applications.csv  token-protected export of everything received
 *
 * DURABILITY RULE: the D1 insert is the commit point. The notification email is
 * strictly best-effort on top of it — if Email Sending has not been enabled on
 * the zone yet, or the send fails for any reason, the row is already safe and
 * the applicant still lands on the thank-you page. An application is never lost
 * to a mail problem, and `notified = 0` marks the ones that need a manual look.
 */

import landing from '../../../locales/el/landing.json' with { type: 'json' };
import rawConfig from '../site.config.json' with { type: 'json' };
import { renderIndex, LIBRARY_TYPE_OPTIONS, type FieldErrors, type FieldValues } from './pages.js';
import type { SiteConfig } from './shell.js';

const config = rawConfig as unknown as SiteConfig;
const copy = landing as Record<string, string>;

/** Version stamp recorded with each consent, so we know what was agreed to.
 *  Read from site.config.json so it is the SAME value the policy page displays.
 *  It must change only when the policy text changes — never on a rebuild. */
const PRIVACY_VERSION = config.legal.lastUpdated;

/** Max submissions accepted from one IP hash per hour. */
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;

export interface Env {
  DB: D1Database;
  EMAIL?: SendEmail;
  ASSETS: Fetcher;
  TURNSTILE_SECRET?: string;
  /** Secret pepper for the IP hash. Set in production; see README. */
  HASH_PEPPER?: string;
  EXPORT_TOKEN?: string;
}

type Parsed = {
  values: FieldValues;
  errors: FieldErrors;
};

const MAX_LEN: Record<string, number> = {
  libraryName: 200,
  libraryType: 40,
  city: 120,
  contactName: 160,
  contactEmail: 320,
  phone: 40,
  collectionSize: 40,
  currentSystem: 200,
  message: 4000,
};

/**
 * Deliberately permissive: one `@`, something either side, a dot in the domain,
 * no whitespace. Anything stricter rejects valid addresses, and the real
 * validation is that our reply has to arrive.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function trim(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function validate(form: FormData): Parsed {
  const values: FieldValues = {};
  const errors: FieldErrors = {};

  for (const key of Object.keys(MAX_LEN)) {
    values[key] = trim(form, key);
  }
  if (trim(form, 'consent') === 'yes') values.consent = 'yes';

  const required: Array<[string, string]> = [
    ['libraryName', 'Συμπληρώστε το όνομα της βιβλιοθήκης.'],
    ['libraryType', 'Επιλέξτε τύπο βιβλιοθήκης.'],
    ['city', 'Συμπληρώστε την πόλη ή τον δήμο.'],
    ['contactName', 'Συμπληρώστε το όνομά σας.'],
    ['contactEmail', 'Συμπληρώστε ένα email επικοινωνίας.'],
  ];
  for (const [key, msg] of required) {
    if (!values[key]) errors[key] = msg;
  }

  for (const [key, max] of Object.entries(MAX_LEN)) {
    const v = values[key];
    if (v && v.length > max) {
      errors[key] = `Το πεδίο είναι πολύ μεγάλο (έως ${max} χαρακτήρες).`;
    }
  }

  const email = values.contactEmail;
  if (email && !errors.contactEmail && !EMAIL_RE.test(email)) {
    errors.contactEmail = 'Το email δεν φαίνεται σωστό. Ελέγξτε το και δοκιμάστε ξανά.';
  }

  const type = values.libraryType;
  if (type && !LIBRARY_TYPE_OPTIONS.some((o) => o.value === type)) {
    errors.libraryType = 'Επιλέξτε έναν από τους διαθέσιμους τύπους.';
  }

  if (values.consent !== 'yes') {
    errors.consent = 'Επιβεβαιώστε ότι διαβάσατε την Πολιτική Απορρήτου.';
  }

  return { values, errors };
}

/** Salted SHA-256 of the client IP — we throttle on it without storing the
 *  address. The pepper MUST be a secret: the whole IPv4 space is only 2^32, so
 *  a hash with a publicly-known salt is a rainbow table away from being the IP
 *  itself. HASH_PEPPER is a Worker secret; the fallback exists only so local
 *  dev works without one. */
async function hashIp(ip: string, pepper?: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${pepper ?? 'libriant-dev-only'}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyTurnstile(token: string, secret: string, ip: string | null): Promise<boolean> {
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}

/** Constant-time string compare, so the export token can't be probed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * `frame-ancestors 'none'` and `form-action 'self'` are the two that matter for
 * a form page: nobody may frame us to overlay a fake submit button, and the form
 * cannot be repointed at another origin. Turnstile needs its script and frame
 * allowed; when it is not configured those sources are simply unused.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    'frame-src https://challenges.cloudflare.com',
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
};

function rerenderWithErrors(parsed: Parsed, formError: string, status = 400): Response {
  return htmlResponse(
    renderIndex(config, copy, {
      errors: parsed.errors,
      values: parsed.values,
      formError,
    }),
    status,
  );
}

async function handleApply(request: Request, env: Env): Promise<Response> {
  if (config.offer.spotsRemaining <= 0) {
    return Response.redirect(new URL('/#apply', request.url).toString(), 303);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return htmlResponse(renderIndex(config, copy, { formError: 'Μη έγκυρη υποβολή.' }), 400);
  }

  // Honeypot: a field hidden off-screen and marked aria-hidden. A human never
  // fills it; naive scrapers fill every input they find. Answer 303 exactly as
  // for a success so the bot learns nothing from the difference.
  if (trim(form, 'website') !== '') {
    return Response.redirect(new URL('/thank-you', request.url).toString(), 303);
  }

  const parsed = validate(form);

  // Turnstile needs BOTH halves: the site key renders the widget (and loads its
  // script — see renderShell), the secret verifies the token it produces.
  // Enforcing on the secret alone would reject 100% of real applications,
  // because with no site key there is no widget and no token to send.
  const turnstileConfigured = config.site.turnstileSiteKey !== '' && !!env.TURNSTILE_SECRET;

  if (env.TURNSTILE_SECRET && config.site.turnstileSiteKey === '') {
    // Misconfigured: a secret with no widget. Fail closed rather than silently
    // accepting everything — this is a deployment mistake, not a visitor's.
    console.error(
      'TURNSTILE_SECRET is set but site.turnstileSiteKey is empty — refusing to accept applications unverified',
    );
    return rerenderWithErrors(
      parsed,
      'Ο έλεγχος ασφαλείας δεν είναι διαθέσιμος αυτή τη στιγμή. Δοκιμάστε ξανά αργότερα ή γράψτε μας απευθείας.',
      503,
    );
  }

  if (turnstileConfigured) {
    const token = trim(form, 'cf-turnstile-response');
    const ok =
      token !== '' &&
      (await verifyTurnstile(
        token,
        env.TURNSTILE_SECRET!,
        request.headers.get('cf-connecting-ip'),
      ));
    if (!ok) {
      return rerenderWithErrors(
        parsed,
        'Ο έλεγχος ασφαλείας δεν ολοκληρώθηκε. Ανανεώστε τη σελίδα και δοκιμάστε ξανά.',
      );
    }
  }

  if (Object.keys(parsed.errors).length > 0) {
    return rerenderWithErrors(
      parsed,
      'Ελέγξτε τα πεδία που σημειώνονται παρακάτω και δοκιμάστε ξανά.',
    );
  }

  const ip = request.headers.get('cf-connecting-ip') ?? '0.0.0.0';
  const ipHash = await hashIp(ip, env.HASH_PEPPER);
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();

  // Degrade OPEN on a throttle-lookup failure: losing a real application is a
  // far worse outcome than admitting one extra submission from one IP.
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM submit_log WHERE ip_hash = ? AND created_at > ?',
  )
    .bind(ipHash, since)
    .first<{ n: number }>()
    .catch((err: unknown) => {
      console.error('rate-limit lookup failed, allowing through:', err);
      return null;
    });

  if ((recent?.n ?? 0) >= RATE_LIMIT) {
    return rerenderWithErrors(
      parsed,
      'Λάβαμε ήδη αρκετές υποβολές από εσάς. Δοκιμάστε ξανά σε μία ώρα, ή γράψτε μας απευθείας.',
      429,
    );
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // `consent` binds the value actually submitted, not a literal — the record is
  // evidence of what the applicant did, so a hardcoded 1 would be worthless.
  // country/user_agent are deliberately NOT stored: nothing read them, and
  // collecting personal data no purpose needs is exactly what Art. 5(1)(c)
  // forbids. Removing them also keeps the privacy notice's table exhaustive.
  try {
    await env.DB.prepare(
      `INSERT INTO applications
         (id, created_at, library_name, library_type, city, contact_name, contact_email,
          phone, collection_size, current_system, message, consent, privacy_version,
          notified, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'new')`,
    )
      .bind(
        id,
        now,
        parsed.values.libraryName ?? '',
        parsed.values.libraryType ?? '',
        parsed.values.city ?? '',
        parsed.values.contactName ?? '',
        parsed.values.contactEmail ?? '',
        parsed.values.phone || null,
        parsed.values.collectionSize || null,
        parsed.values.currentSystem || null,
        parsed.values.message || null,
        trim(form, 'consent') !== '' ? 1 : 0,
        PRIVACY_VERSION,
      )
      .run();
  } catch (err) {
    // The commit point failed. Do not drop the lead on the floor: try to get it
    // to the inbox, and tell the applicant honestly how else to reach us.
    console.error('application insert failed:', err);
    await notify(env, id, parsed.values).catch(() => undefined);
    return rerenderWithErrors(
      parsed,
      `Δεν καταφέραμε να αποθηκεύσουμε την αίτησή σας. Δοκιμάστε ξανά σε λίγο, ή στείλτε μας email στο ${config.identity.contactEmail}.`,
      500,
    );
  }

  // Throttle bookkeeping and the retention sweep are both non-critical: the
  // application is already committed and must never fail because of them.
  await env.DB.prepare('INSERT INTO submit_log (ip_hash, created_at) VALUES (?, ?)')
    .bind(ipHash, now)
    .run()
    .catch((err: unknown) => console.error('submit_log insert failed:', err));

  // Retention: the hashes exist only to enforce a one-hour window, so anything
  // older than the window has no purpose and is deleted.
  await env.DB.prepare('DELETE FROM submit_log WHERE created_at < ?')
    .bind(since)
    .run()
    .catch((err: unknown) => console.error('submit_log sweep failed:', err));

  // Best-effort from here on. Everything above is already committed.
  await notify(env, id, parsed.values).catch(() => undefined);

  return Response.redirect(new URL('/thank-you', request.url).toString(), 303);
}

async function notify(env: Env, id: string, v: FieldValues): Promise<void> {
  if (!env.EMAIL) return;

  const typeLabel =
    LIBRARY_TYPE_OPTIONS.find((o) => o.value === v.libraryType)?.label ?? v.libraryType ?? '—';

  const lines = [
    `Βιβλιοθήκη:      ${v.libraryName ?? ''}`,
    `Τύπος:           ${typeLabel}`,
    `Πόλη:            ${v.city ?? ''}`,
    `Επικοινωνία:     ${v.contactName ?? ''} <${v.contactEmail ?? ''}>`,
    `Τηλέφωνο:        ${v.phone || '—'}`,
    `Μέγεθος:         ${v.collectionSize || '—'}`,
    `Τρέχον σύστημα:  ${v.currentSystem || '—'}`,
    '',
    'Μήνυμα:',
    v.message || '—',
    '',
    `id: ${id}`,
  ].join('\n');

  try {
    await env.EMAIL.send({
      to: config.site.notifyTo,
      from: { email: config.site.notifyFrom, name: 'Libriant — αιτήσεις' },
      replyTo: v.contactEmail ? { email: v.contactEmail, name: v.contactName ?? '' } : undefined,
      subject: `Νέα αίτηση: ${v.libraryName ?? 'άγνωστη βιβλιοθήκη'} (${v.city ?? ''})`,
      text: lines,
    });
    await env.DB.prepare('UPDATE applications SET notified = 1 WHERE id = ?').bind(id).run();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await env.DB.prepare('UPDATE applications SET notify_error = ? WHERE id = ?')
      .bind(reason.slice(0, 500), id)
      .run();
    // Rethrown into the caller's .catch() — the applicant must never see this.
    throw err;
  }
}

/** RFC 4180 field: always quote, double any embedded quote — and neutralise
 *  spreadsheet formulas. An applicant who types `=HYPERLINK(...)` into a free
 *  text field would otherwise get it EXECUTED when the owner opens the export
 *  in Excel, which the README explicitly tells them to do. */
function csvCell(value: unknown): string {
  const raw = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

async function handleExport(request: Request, env: Env): Promise<Response> {
  // Prefer the Authorization header: a query string is captured in Workers
  // Logs, browser history and any intermediary, all of which outlive the request.
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ')
    ? auth.slice(7)
    : (new URL(request.url).searchParams.get('token') ?? '');
  if (!env.EXPORT_TOKEN || !safeEqual(token, env.EXPORT_TOKEN)) {
    return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
  }

  const cols = [
    'created_at',
    'library_name',
    'library_type',
    'city',
    'contact_name',
    'contact_email',
    'phone',
    'collection_size',
    'current_system',
    'message',
    'status',
    'notified',
    'id',
  ];
  const { results } = await env.DB.prepare(
    `SELECT ${cols.join(', ')} FROM applications ORDER BY created_at DESC`,
  ).all<Record<string, unknown>>();

  const rows = (results ?? []).map((r) => cols.map((c) => csvCell(r[c])).join(','));
  // A UTF-8 BOM so Excel on Windows opens the Greek text correctly.
  const csv = '﻿' + [cols.join(','), ...rows].join('\r\n') + '\r\n';

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="libriant-applications.csv"',
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/apply') {
      if (request.method === 'POST') return handleApply(request, env);
      if (request.method === 'GET' || request.method === 'HEAD') {
        return Response.redirect(new URL('/#apply', request.url).toString(), 303);
      }
      return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
    }

    if (url.pathname === '/applications.csv') {
      return handleExport(request, env);
    }

    // Everything else is a static asset. Add the security headers on the way
    // out — the Assets binding does not set them itself.
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
} satisfies ExportedHandler<Env>;
