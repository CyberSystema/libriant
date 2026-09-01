#!/usr/bin/env node
// An alert on a metric nothing emits is a rule that can never fire.
//
// While wiring the alerting that reliability-04 found missing, I wrote
// `libriant_backup_last_offsite_success_timestamp_seconds`. The metric is
// actually called `libriant_backup_offsite_last_success_timestamp_seconds`.
// Prometheus does not complain about that — the expression is valid, it just
// matches nothing, so the alert sits there looking like coverage and never
// fires. That is the same failure as the rules themselves: something that reads
// as protection and is not.
//
// So this cross-checks every `libriant_*` metric named in a rule against the
// metric names the codebase actually writes, and asserts the dead man's switch
// is present and routed. It is deliberately dependency-free and text-based,
// like the other check:* scripts — `promtool check rules` runs in CI for real
// syntax validation, and this covers the thing promtool cannot know.
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ALERTS = 'infra/monitoring/alerts.yml';
const ROUTES = 'infra/monitoring/alertmanager.yml';

/**
 * Every place a libriant_* metric is produced.
 *
 * Walked rather than listed. My first attempt hardcoded the files I expected
 * and named `metrics.controller.ts`, which does not exist — the Postgres gauges
 * come from `health.controller.ts` — so the check reported three perfectly good
 * rules as broken. A checker that cries wolf gets switched off, which would
 * have left the real defect it exists to catch unguarded.
 */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.next') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|mts|js|mjs|sh)$/.test(e.name)) out.push(full);
  }
  return out;
}

const EMITTERS = [...walk('apps/api/src'), ...walk('scripts'), ...walk('apps/web/app')];

const METRIC = /libriant_[a-z0-9_]+/g;

const emitted = new Set();
for (const f of EMITTERS) {
  let src;
  try {
    src = readFileSync(f, 'utf8');
  } catch {
    continue; // an emitter that does not exist yet is not an error here
  }
  for (const m of src.match(METRIC) ?? []) emitted.add(m);
}

const alertsSrc = readFileSync(ALERTS, 'utf8');

// Pull `alert:` names and `expr:` bodies without a YAML parser. Rules here are
// always `- alert: Name` and an `expr:` that is either inline or a `|` block;
// both forms are covered by scanning the lines that follow until the next key.
const rules = [];
let current = null;
for (const raw of alertsSrc.split('\n')) {
  const line = raw.replace(/#.*$/, '');
  const alert = /^\s*-\s*alert:\s*(\S+)/.exec(line);
  if (alert) {
    if (current) rules.push(current);
    current = { name: alert[1], expr: '' };
    continue;
  }
  if (!current) continue;
  const expr = /^\s*expr:\s*(.*)$/.exec(line);
  if (expr) {
    current.expr += ' ' + expr[1];
    current.inExpr = true;
    continue;
  }
  if (current.inExpr) {
    if (/^\s*(for|labels|annotations|record|-\s*alert):/.test(line)) current.inExpr = false;
    else current.expr += ' ' + line.trim();
  }
}
if (current) rules.push(current);

let bad = 0;

const unknown = [];
for (const r of rules) {
  for (const m of r.expr.match(METRIC) ?? []) {
    if (!emitted.has(m)) unknown.push({ rule: r.name, metric: m });
  }
}
if (unknown.length) {
  console.error(`✗ ${ALERTS}: ${unknown.length} rule(s) reference a metric nothing emits:\n`);
  for (const u of unknown) console.error(`    ${u.rule.padEnd(30)} ${u.metric}`);
  console.error('\nThe expression is valid PromQL and will simply never match. Check the name');
  console.error('against what the code writes, or remove the rule.');
  bad += unknown.length;
}

// The dead man's switch is the one rule whose absence is invisible by design:
// if alerting breaks, nothing fires, and silence reads as health.
const watchdog = rules.find((r) => r.name === 'Watchdog');
if (!watchdog) {
  console.error(`✗ ${ALERTS}: no Watchdog rule. Without a heartbeat that fires ALWAYS, a broken`);
  console.error('  alerting pipeline is indistinguishable from a quiet night.');
  bad++;
} else if (!/vector\(1\)/.test(watchdog.expr)) {
  console.error(`✗ ${ALERTS}: the Watchdog rule must be unconditionally true (\`vector(1)\`).`);
  bad++;
}

let routesSrc = '';
try {
  routesSrc = readFileSync(ROUTES, 'utf8');
} catch {
  console.error(`✗ ${ROUTES} is missing — Prometheus has nowhere to deliver a firing rule.`);
  bad++;
}
/**
 * The routing file with every comment removed.
 *
 * Everything below asks "what will Alertmanager DO", and Alertmanager does not
 * read comments. The same trap caught scripts/deploy-on-host.sh once already:
 * its placeholder grep matched the header sentence EXPLAINING what a
 * [PLACEHOLDER] is, so a fully configured file still read as unconfigured. The
 * inverse is worse and is what this guards — a `# receiver: watchdog` in prose
 * satisfying a check about the real route.
 *
 * Naive, deliberately: `#` inside a quoted YAML scalar would be stripped too.
 * No value in this file contains one, and the destinations that could (a URL
 * with a fragment) live outside it in `url_file` on purpose.
 */
const routesCode = routesSrc.replace(/#.*$/gm, '');

if (routesSrc && !/alertname\s*=\s*Watchdog/.test(routesCode)) {
  console.error(`✗ ${ROUTES}: the Watchdog alert has no route of its own. It must go to a`);
  console.error('  receiver that alerts on SILENCE, not to the same place as real alerts —');
  console.error('  otherwise a dead pipeline looks exactly like a healthy one.');
  bad++;
}

/**
 * Every `receivers:` entry, and whether it can actually deliver anything.
 *
 * WHY THIS REPLACED A `[PLACEHOLDER]` COUNT. The old version counted the string
 * anywhere in the file and printed "NOT DELIVERING YET — 3 [PLACEHOLDER]
 * receiver(s)" for a file with two receivers: the third match was the header
 * comment explaining the convention. It could not have said anything else,
 * because a count of a marker is not a statement about delivery — and the state
 * this file is now in is one receiver DELIVERING and one deliberately OPEN,
 * which a single number cannot express and which matters enormously. `default`
 * reaching a phone while the dead man's switch reaches nobody is a real posture
 * with a real hole in it; "2 placeholders" and "0 placeholders" both describe it
 * wrongly.
 *
 * Text-based like the rest of this file — `amtool check-config` is the syntax
 * authority and runs in both deploy paths.
 */
function parseReceivers(src) {
  const out = [];
  const lines = src.split('\n');
  let inSection = false;
  let current = null;
  // A run of comment/blank lines belongs to whatever comes NEXT, not to what
  // came before. The `watchdog` receiver is the case that matters: the whole
  // explanation of why it is deliberately open — and the [PLACEHOLDER] that
  // says so — is written above its `- name:` line, which is where a reader
  // will look for it. Attributed backwards, it credited `default` with the
  // marker and reported `watchdog` as an unexplained silence.
  let pending = '';
  const flush = () => {
    if (current) {
      current.prose += pending;
      pending = '';
    } else {
      pending = '';
    }
  };
  for (const raw of lines) {
    // A new top-level key ends the section. `receivers:` itself is one.
    if (/^[A-Za-z_]/.test(raw)) {
      flush();
      if (current) out.push(current);
      current = null;
      inSection = /^receivers:/.test(raw);
      continue;
    }
    if (!inSection) continue;
    const name = /^\s*-\s*name:\s*'?"?([^'"\s]+)'?"?/.exec(raw);
    if (name) {
      if (current) out.push(current);
      current = { name: name[1], code: '', prose: pending };
      pending = '';
      continue;
    }
    if (/^\s*(#|$)/.test(raw)) {
      pending += raw + '\n';
      continue;
    }
    flush();
    if (!current) continue;
    current.code += raw.replace(/#.*$/, '') + '\n';
    current.prose += raw + '\n';
  }
  flush();
  if (current) out.push(current);
  return out;
}

const receivers = parseReceivers(routesSrc);
const receiverByName = new Map(receivers.map((r) => [r.name, r]));

// Which receiver each route names. The top-level `receiver:` is the default;
// `routes:` entries override it for what they match.
const routed = new Set();
let defaultReceiver = '';
let watchdogReceiver = '';
{
  const lines = routesCode.split('\n');
  let sawWatchdogMatcher = false;
  for (const raw of lines) {
    const rec = /^\s*receiver:\s*'?"?([^'"\s]+)'?"?/.exec(raw);
    if (/alertname\s*=\s*Watchdog/.test(raw)) sawWatchdogMatcher = true;
    if (!rec) continue;
    routed.add(rec[1]);
    if (!defaultReceiver) defaultReceiver = rec[1];
    if (sawWatchdogMatcher && !watchdogReceiver) watchdogReceiver = rec[1];
  }
}

for (const name of routed) {
  if (receiverByName.has(name)) continue;
  console.error(`✗ ${ROUTES}: a route sends alerts to receiver '${name}', which is not defined.`);
  console.error('  Alertmanager refuses to start on that, so nothing would be delivered at all.');
  bad++;
}

// The dead man's switch must not share the destination of the alerts it exists
// to prove are still flowing. Asserted rather than commented, because the
// tempting shortcut — pointing `watchdog` at the receiver that already works —
// is exactly the change that makes a dead pipeline look like a quiet night, and
// would push once a minute until the phone muted the channel.
if (watchdogReceiver && defaultReceiver && watchdogReceiver === defaultReceiver) {
  console.error(`✗ ${ROUTES}: the Watchdog route and the default route share receiver`);
  console.error(`  '${watchdogReceiver}'. The heartbeat must go somewhere that complains when it`);
  console.error('  STOPS arriving; delivered alongside real alerts it proves nothing.');
  bad++;
}

if (bad) process.exit(1);

console.log(
  `alert check passed: ${rules.length} rules, every libriant_* metric is emitted, Watchdog present and routed.`,
);

// A receiver delivers if it declares at least one notifier config whose
// destination is not still a placeholder. `url_file` counts: the file is
// written on the host by scripts/deploy-on-host.sh, and the deploy refuses to
// start Alertmanager when it could not write it.
const DELIVERY_KEY = /^\s*[a-z_]+_configs:/m;
const PLACEHOLDER = /\[PLACEHOLDER[^\]]*\]/;

const report = receivers.map((r) => {
  const hasConfig = DELIVERY_KEY.test(r.code);
  const brokenUrl = PLACEHOLDER.test(r.code);
  const pendingNote = PLACEHOLDER.test(r.prose);
  if (brokenUrl) return { ...r, state: 'broken' };
  if (hasConfig) return { ...r, state: 'delivering' };
  return { ...r, state: pendingNote ? 'pending' : 'silent' };
});

console.log(`\nreceivers in ${ROUTES}:`);
for (const r of report) {
  const how = {
    delivering: 'delivers  — has a destination',
    pending: 'NO DELIVERY — deliberately open, marked [PLACEHOLDER] in the file',
    silent: 'NO DELIVERY — no config, and nothing says that is intentional',
    broken: 'BROKEN    — a [PLACEHOLDER] inside a real URL; Alertmanager will not start',
  }[r.state];
  console.log(`  ${r.name.padEnd(12)} ${how}`);
}

const open = report.filter((r) => r.state !== 'delivering');
if (open.length) {
  console.log(
    `\nPARTIALLY DELIVERING — ${open.length} of ${report.length} receiver(s) reach nobody.\n` +
      'Every alert routed to them fires and is dropped. The Watchdog is the one that\n' +
      'cannot be closed with a push channel: it must alert on SILENCE, so it needs an\n' +
      'external dead-man service (healthchecks.io or similar), never ntfy.',
  );
}
