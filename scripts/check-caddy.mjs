#!/usr/bin/env node
// Every route that reaches a backend must sit behind the origin guard.
//
// The edge is the only thing standing between the internet and an API process
// that trusts `X-Real-IP`. `(origin_guard)` is the snippet that answers "is this
// peer actually Cloudflare?" from the connection rather than from a header, and
// it has to be imported into EVERY block that proxies to `api` or `web`.
//
// It shipped missing from one. `handle /webhooks/* { reverse_proxy api:3001 }`
// on the app host had no guard at all, so direct-to-origin traffic reached the
// API — and the omission was invisible because nothing checked. The pre-release
// audit found it by adapting the config and reading the emitted JSON by hand.
// This is that check, minus the hand.
//
// Deliberately a STRUCTURAL check, not a grep for a count: a guard in one block
// says nothing about a sibling block, and equal counts of `import origin_guard`
// and `reverse_proxy` can still leave a route open while another is guarded
// twice.
import { readFileSync } from 'node:fs';

const FILE = 'infra/caddy/Caddyfile';

// The services on the internal compose networks. Anything proxied to one of
// these is reachable from the public internet through this edge.
const INTERNAL = /^\s*reverse_proxy\s+(api|web):\d+/;
const GUARD = /^\s*import\s+origin_guard\b/;
// Snippet definitions — `(origin_guard) { … }` — are the guard itself, not a
// route, so their contents must not be scanned for missing guards.
const SNIPPET_OPEN = /^\s*\([A-Za-z0-9_]+\)\s*\{/;

const lines = readFileSync(FILE, 'utf8').split('\n');

/** One frame per open brace: does this block (or an ancestor) carry the guard? */
const stack = [{ guarded: false, snippet: false }];
const unguarded = [];

lines.forEach((raw, i) => {
  const line = raw.replace(/#.*$/, '');

  if (GUARD.test(line)) stack[stack.length - 1].guarded = true;

  if (INTERNAL.test(line)) {
    const inherited = stack.some((f) => f.guarded);
    const inSnippet = stack.some((f) => f.snippet);
    if (!inherited && !inSnippet) {
      unguarded.push({ line: i + 1, text: raw.trim() });
    }
  }

  // Track depth last, so a guard and a proxy on the same line as a brace are
  // attributed to the block they visually belong to.
  const opens = (line.match(/\{/g) ?? []).length;
  const closes = (line.match(/\}/g) ?? []).length;
  const snippet = SNIPPET_OPEN.test(line);
  for (let n = 0; n < opens; n++) {
    stack.push({ guarded: false, snippet: snippet && n === 0 });
  }
  for (let n = 0; n < closes; n++) {
    if (stack.length > 1) stack.pop();
  }
});

if (stack.length !== 1) {
  console.error(`✗ ${FILE}: unbalanced braces — ${stack.length - 1} block(s) left open.`);
  process.exit(1);
}

if (unguarded.length) {
  console.error(
    `✗ ${FILE}: ${unguarded.length} route(s) proxy to a backend with no origin guard:\n`,
  );
  for (const u of unguarded) {
    console.error(`    ${FILE}:${u.line}: ${u.text}`);
  }
  console.error(
    '\nAdd `import origin_guard <name>` to the enclosing block. Without it, anyone who\n' +
      'reaches the origin directly can set X-Real-IP to whatever they like, and every\n' +
      'rate limit and the login lockout are keyed on that value.',
  );
  process.exit(1);
}

// --- the access log must redact the same parameters the outbox seals --------
//
// The API seals credential-bearing query parameters out of email_outbox, and
// Caddy drops the same ones out of access.log. Protecting one and not the other
// protects nothing: the log is rolled 14x100mb and tarred into the nightly
// backup, so a token surviving there is a token in every archive. A verifier
// pulled a live reset link out of exactly that path and redeemed it.
const SECRETS_SRC = 'apps/api/src/email/outbox-secrets.ts';
let sealed = [];
try {
  const src = readFileSync(SECRETS_SRC, 'utf8');
  const block = /const SECRET_QUERY_PARAMS = \[([\s\S]*?)\]/.exec(src)?.[1] ?? '';
  sealed = [...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
} catch {
  console.error(
    `✗ ${SECRETS_SRC} is unreadable — cannot confirm the access log redacts what the outbox seals.`,
  );
  process.exit(1);
}

const logged = new Set(
  [...readFileSync(FILE, 'utf8').matchAll(/^\s*delete\s+([a-z]+)\s*$/gm)].map((m) => m[1]),
);
const unredacted = sealed.filter((p) => !logged.has(p));
if (unredacted.length) {
  console.error(`✗ ${FILE}: the access log does NOT redact ${unredacted.length} parameter(s) the`);
  console.error(`  API treats as secret in ${SECRETS_SRC}:\n`);
  for (const p of unredacted) console.error(`    ${p}`);
  console.error('\nAdd `delete <name>` inside the `request>uri query { … }` filter. Redacting a');
  console.error('link in the database and then writing it to a log that goes into the backups');
  console.error('protects nothing.');
  process.exit(1);
}

// --- no CORS header may appear on any vhost ---------------------------------
//
// There is no `Access-Control-Allow-Origin` in this file, and that absence IS the
// configuration rather than something nobody got round to. `POST /apply` is the
// only unauthenticated write in the control plane and it is served same-origin to
// its own form, so it needs no CORS at all; a permissive one is the single header
// that would let another origin's JavaScript drive it AND read back whether a
// submission was accepted, which is the difference between a blind cross-site
// POST and a working abuse loop. An absence cannot be read as deliberate — this
// is what makes it one, including for the vhosts above, which have no CSP to
// argue with a CORS header if one is added there.
const cors = lines
  .map((raw, i) => ({ line: i + 1, text: raw.replace(/#.*$/, '').trim() }))
  .filter(({ text }) => /Access-Control-Allow-/i.test(text));
if (cors.length) {
  console.error(`✗ ${FILE}: ${cors.length} CORS header(s) — this file must emit none:\n`);
  for (const c of cors) console.error(`    ${FILE}:${c.line}: ${c.text}`);
  console.error(
    '\nEvery host here serves its own pages to its own forms. If a genuine cross-origin\n' +
      'caller ever appears, name it and its exact origin in a comment before relaxing\n' +
      'this — a wildcard on the vhost that carries /apply hands the one unauthenticated\n' +
      'write in the product to any page on the internet.',
  );
  process.exit(1);
}

// --- HSTS must keep includeSubDomains ---------------------------------------
//
// `www.{$SITE_HOST}` at the bottom of this file is two lines of redirect and
// imports no header snippet, so www.libriant.com emits no Strict-Transport-
// Security of its own. It is covered ONLY by the apex policy's
// `includeSubDomains`. Deleting that token — the obvious tidy-up for someone who
// reads it as being about the not-yet-enabled wildcard vhost — would silently
// take HSTS off that host entirely, and nothing else in the repo would notice.
const hstsValues = [
  ...lines.join('\n').matchAll(/^\s*Strict-Transport-Security\s+"([^"]*)"/gm),
].map((m) => m[1]);
if (hstsValues.length === 0) {
  console.error(`✗ ${FILE}: no Strict-Transport-Security header at all.`);
  process.exit(1);
}
const weakHsts = hstsValues.filter((v) => !/includeSubDomains/i.test(v));
if (weakHsts.length) {
  console.error(`✗ ${FILE}: ${weakHsts.length} HSTS policy/policies without includeSubDomains:\n`);
  for (const v of weakHsts) console.error(`    Strict-Transport-Security "${v}"`);
  console.error('\nwww.{$SITE_HOST} emits no HSTS of its own and is covered only by this token.');
  process.exit(1);
}

// The token above was pinned and the number beside it was not, which is the
// weaker half: `max-age=0` disables the policy and de-preloads the domain, and
// it looks exactly like a value someone lowered while debugging a certificate.
const ONE_YEAR = 31536000;
const shortHsts = hstsValues.filter((v) => {
  const age = /max-age\s*=\s*(\d+)/i.exec(v);
  return !age || Number(age[1]) < ONE_YEAR;
});
if (shortHsts.length) {
  console.error(`✗ ${FILE}: ${shortHsts.length} HSTS policy/policies below one year:\n`);
  for (const v of shortHsts) console.error(`    Strict-Transport-Security "${v}"`);
  console.error(
    `\nmax-age must be at least ${ONE_YEAR} (one year) — the preload list's own\n` +
      'minimum. A lower value silently drops the domain from it.',
  );
  process.exit(1);
}

// --- the zero-JavaScript guarantee ------------------------------------------
//
// The marketing site ships no JavaScript, and `script-src 'none'` is the thing
// that makes that a guarantee rather than a habit: the application form is the
// commercial funnel, it re-renders a named librarian's contact details after a
// failed submission, and there is no framework between that HTML and the
// browser. Nothing checked it. The header could be weakened to
// `'self' 'unsafe-inline'`, or deleted outright, and this script printed
// "check passed" — while forty lines of comment beside it in the Caddyfile
// explained why three of these directives are the ones that carry the policy.
//
// These four are asserted by name because they are the four that do not fall
// back to `default-src`: dropping any of them removes it entirely rather than
// narrowing it.
const cspValues = [
  ...lines.join('\n').matchAll(/^\s*Content-Security-Policy\s+"([^"]*)"/gm),
].map((m) => m[1]);
if (cspValues.length === 0) {
  console.error(
    `✗ ${FILE}: no Content-Security-Policy header at all.\n\n` +
      "The site's premise is that it ships zero JavaScript. Without this header\n" +
      'that is an assertion about the source, not about what a browser will run.',
  );
  process.exit(1);
}
const CSP_REQUIRED = [
  ["script-src 'none'", 'the zero-JavaScript guarantee itself'],
  ["base-uri 'none'", 'stops an injected <base> retargeting every relative URL on the page'],
  ["form-action 'self'", "stops the application form's POST being retargeted off-site"],
  ["frame-ancestors 'none'", 'stops the form being framed and clickjacked'],
];
for (const csp of cspValues) {
  const absent = CSP_REQUIRED.filter(([d]) => !csp.includes(d));
  if (absent.length) {
    console.error(`✗ ${FILE}: a Content-Security-Policy is missing ${absent.length} directive(s):`);
    for (const [d, why] of absent) console.error(`    ${d} — ${why}`);
    console.error(`\n  in: Content-Security-Policy "${csp}"`);
    console.error(
      '\nNone of these four falls back to default-src, so removing one removes the\n' +
        'protection rather than loosening it.',
    );
    process.exit(1);
  }
}

// --- the application form's route ------------------------------------------
//
// `POST /apply` is the only unauthenticated write in the control plane, and the
// three things below are what stand in front of it at the edge. They are checked
// structurally — inside the block that actually routes /apply — rather than by
// grepping the whole file, because a matcher defined in one vhost and a respond
// in another would grep clean and route nothing.

/** The text of the block opened by the first line matching `re`, braces included. */
function blockOpenedBy(re) {
  const start = lines.findIndex((l) => re.test(l.replace(/#.*$/, '')));
  if (start === -1) return null;
  const body = [];
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const code = lines[i].replace(/#.*$/, '');
    body.push(lines[i]);
    depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
    if (i > start && depth <= 0) break;
  }
  return body.join('\n');
}

const applyBlock = blockOpenedBy(/^\s*handle\s+@apply\s*\{/);
if (!applyBlock) {
  console.error(
    `✗ ${FILE}: no \`handle @apply { … }\` block — the application form is not routed.`,
  );
  process.exit(1);
}

const applyRequirements = [
  {
    // The Fetch Standard appends `Origin` to every non-GET/HEAD request, so a
    // form POST from a browser always carries one and a scripted POST usually
    // does not. This refuses the latter for the price of a string comparison,
    // one hop before it costs the API an offer-state query and a full render of
    // the home page — work the per-IP throttle cannot bill because it runs after
    // validation on purpose.
    // Pinned to THIS site's host, not merely to the shape of the line. The
    // pattern was `not header Origin https://`, which a matcher naming
    // `https://evil.example` satisfies just as well — and the success line
    // below would still have reported the path as "Origin-gated".
    re: /^\s*not header Origin https:\/\/\{\$SITE_HOST:[a-z0-9.-]+\}\s*$/m,
    what:
      'a matcher requiring this site\'s own Origin on POST — exactly\n' +
      '      `not header Origin https://{$SITE_HOST:…}`, not just any https:// host',
  },
  {
    // Without this the gate 403s GET /apply too, which is `redirectToForm`
    // ("stray navigation to the form's action lands back on the form").
    re: /^\s*method POST$/m,
    what: '`method POST` in that matcher, so stray GET navigation still redirects',
  },
  {
    re: /^\s*respond @\w+ .* 403$/m,
    what: 'a 403 for the requests that matcher selects',
  },
  {
    // A failed submission comes back as the real page with the applicant's name,
    // email address and telephone number still in it. Nothing between us and
    // them may keep a copy, and this was the only route on the marketing vhost
    // with no cache directive at all.
    re: /^\s*header_down Cache-Control "no-store"$/m,
    what: '`header_down Cache-Control "no-store"` on the proxy to api:3001',
  },
];
const missing = applyRequirements.filter((r) => !r.re.test(applyBlock)).map((r) => r.what);
if (missing.length) {
  console.error(`✗ ${FILE}: the \`handle @apply\` block is missing ${missing.length} thing(s):\n`);
  for (const m of missing) console.error(`    ${m}`);
  console.error(
    '\nThis block fronts POST /apply, the only unauthenticated write in the control\n' +
      'plane. Removing any of these does not break a page, so nothing else would tell\n' +
      'you it had happened.',
  );
  process.exit(1);
}

// The 403 has to be written ABOVE the proxy, and that is not a style preference.
//
// `route` is used here precisely because it evaluates in written order instead
// of Caddy's standard directive order — the block's own comment says so. Swap
// these two lines and `reverse_proxy`, a terminal handler, answers first: the
// respond never runs, the gate is dead, and the config is still perfectly
// valid, so `caddy validate` in CI passes and every check in this repo stays
// green. Nothing encoded that the ordering was load-bearing.
const respondAt = applyBlock.search(/^\s*respond @\w+ .* 403$/m);
const proxyAt = applyBlock.search(/^\s*reverse_proxy\s+api:\d+/m);
if (respondAt > proxyAt) {
  console.error(
    `✗ ${FILE}: in \`handle @apply\`, the 403 is written BELOW \`reverse_proxy\`.\n\n` +
      '`route { … }` runs its directives in source order, and reverse_proxy is a\n' +
      'terminal handler — so the proxy answers first and the Origin gate never fires.\n' +
      'Move the `respond … 403` above the `reverse_proxy` line.',
  );
  process.exit(1);
}

// --- the edge and the API must gate the same paths --------------------------
//
// The Caddyfile refuses an Origin-less POST at the marketing vhost; the API
// refuses it again in OriginCheckMiddleware. That second copy is not belt and
// braces — `/lbr-api/apply` on the app host proxies to the same handler and
// never passes the matcher above — so the two lists have to name the same paths.
// A locale added to one and not the other opens the new path on whichever side
// was forgotten, exactly the way /webhooks/* shipped guarded nowhere.
const ORIGIN_CHECK_SRC = 'apps/api/src/platform/origin-check.middleware.ts';
let browserOnly = [];
try {
  const src = readFileSync(ORIGIN_CHECK_SRC, 'utf8');
  const block = /const BROWSER_ONLY_PATHS = new Set\(\[([\s\S]*?)\]\)/.exec(src)?.[1] ?? '';
  browserOnly = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
} catch {
  console.error(
    `✗ ${ORIGIN_CHECK_SRC} is unreadable — cannot confirm the API gates the paths this edge does.`,
  );
  process.exit(1);
}

const edgePaths = (/^\s*@apply path (.+)$/m.exec(lines.join('\n'))?.[1] ?? '').trim().split(/\s+/);
const sameSet =
  browserOnly.length > 0 &&
  edgePaths.length === browserOnly.length &&
  edgePaths.every((p) => browserOnly.includes(p));
if (!sameSet) {
  console.error(`✗ ${FILE}: the edge and the API do not gate the same application-form paths.`);
  console.error(`    ${FILE} @apply path       : ${edgePaths.join(' ') || '(none)'}`);
  console.error(`    ${ORIGIN_CHECK_SRC}: ${browserOnly.join(' ') || '(none)'}`);
  console.error(
    '\nBOTH lists must name every path that reaches ApplicationsController. The edge\n' +
      'copy stops the request before it costs the API anything; the API copy is the one\n' +
      'that still applies on app.<apex>/lbr-api/apply, which never sees this vhost.',
  );
  process.exit(1);
}

const guarded = lines.filter((l) => INTERNAL.test(l.replace(/#.*$/, ''))).length;
// Say only what was tested, and say where.
//
// This line used to report the form paths as "Origin-gated and no-store at the
// edge and in origin-check.middleware.ts", which read as two properties checked
// at two entrances. The no-store assertion is a regex run against the `@apply`
// block alone, and the middleware has no opinion about caching at all — naming
// it there described a guarantee nobody had made. The response-level no-store
// now lives in applications.controller.ts, where a third entrance cannot lose
// it, and this sentence stops claiming to have checked it twice.
console.log(
  `Caddyfile check passed: all ${guarded} backend route(s) sit behind the origin guard, ` +
    `the access log redacts all ${sealed.length} secret query parameter(s), no vhost emits a ` +
    `CORS header, every CSP keeps its ${CSP_REQUIRED.length} non-fallback directives ` +
    `(script-src 'none' among them), every HSTS policy is a year with includeSubDomains, ` +
    `and the ${edgePaths.length} application-form path(s) are gated at the edge on this ` +
    `site's own Origin — ahead of the proxy, not below it — and named identically in ` +
    `${ORIGIN_CHECK_SRC}.`,
);
