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
if (routesSrc && !/alertname\s*=\s*Watchdog/.test(routesSrc)) {
  console.error(`✗ ${ROUTES}: the Watchdog alert has no route of its own. It must go to a`);
  console.error('  receiver that alerts on SILENCE, not to the same place as real alerts —');
  console.error('  otherwise a dead pipeline looks exactly like a healthy one.');
  bad++;
}

if (bad) process.exit(1);

const placeholders = (routesSrc.match(/\[PLACEHOLDER[^\]]*\]/g) ?? []).length;
console.log(
  `alert check passed: ${rules.length} rules, every libriant_* metric is emitted, Watchdog present and routed.`,
);
if (placeholders) {
  console.log(
    `\nNOT DELIVERING YET — ${placeholders} [PLACEHOLDER] receiver(s) in ${ROUTES}.\n` +
      'Alerts will fire and reach nobody until an owner fills in a real destination.',
  );
}
