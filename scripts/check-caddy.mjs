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

const guarded = lines.filter((l) => INTERNAL.test(l.replace(/#.*$/, ''))).length;
console.log(
  `Caddyfile check passed: all ${guarded} backend route(s) sit behind the origin guard, ` +
    `and the access log redacts all ${sealed.length} secret query parameter(s).`,
);
