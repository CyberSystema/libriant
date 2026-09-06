#!/usr/bin/env tsx
// Every metric is declared once, alerted on purpose, and reachable by a scrape.
//
// WHAT THIS REPLACED, AND WHY. The first version of this gate existed because
// of a real mistake: a rule was written against
// `libriant_backup_last_offsite_success_timestamp_seconds` when the metric is
// called `libriant_backup_offsite_last_success_timestamp_seconds`. Prometheus
// does not complain — the expression is valid PromQL, it just matches nothing —
// so the alert sat there looking like coverage and could never fire. That
// version grepped the source for `libriant_*` and compared.
//
// It had two structural limits it could not fix from the outside:
//
//   1. ANY occurrence of the string counted as "emitted". A metric named only
//      in a comment, in a test assertion, or in this checker's own prose
//      satisfied it. `renderScheduledJobMetrics` is what that costs: it was
//      written, exported, unit-tested and documented with the sentence
//      "worker.ts just concatenates the string" — and worker.ts never called
//      it, so `libriant_worker_job_last_ok` had a passing test, a docblock
//      describing its alert, and no series in Prometheus.
//
//   2. It could only check ONE direction. A rule naming a metric nobody writes
//      was caught; a metric that is written, scraped, charted and has NO alert
//      was invisible. `libriant_backup_last_exit_code` sat in exactly that
//      state: a backup that failed at 03:00 was first mentioned 36 hours later
//      by BackupStale.
//
// So the declaration moved into `apps/api/src/observability/metrics.registry.ts`
// and this reads it. Ten checks, both directions:
//
//   1. every libriant_* named in a rule is DECLARED
//   2. every metric declared `alert: true` is named by at least one rule
//   3. every libriant_* literal in emitter source (comments stripped) is DECLARED
//   4. every declared metric is EMITTED by the source it claims
//   5. the two emitters that cannot import the registry — the Next route and
//      backup.sh — expose the declared HELP text and TYPE verbatim
//   6. every source a metric declares has a Prometheus scrape job
//   7. every libriant_* in a Grafana dashboard is DECLARED
//   8. every libriant_* named in README.md or the RUNBOOK is DECLARED, unless
//      it is on a short list of non-metric identifiers with a reason
//   9. the Watchdog exists, is unconditional, and is routed apart
//  10. every routed receiver is defined, and the report says who actually
//      delivers
//
// Deliberately dependency-free and text-based, like the other check:* scripts.
// `promtool check rules` runs in CI for real syntax validation; this covers
// what promtool cannot know.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allMetrics,
  type MetricDeclaration,
} from '../apps/api/src/observability/metrics.registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ALERTS = 'infra/monitoring/alerts.yml';
const ROUTES = 'infra/monitoring/alertmanager.yml';
const SCRAPE = 'infra/monitoring/prometheus.yml';
const DASHBOARDS = 'infra/monitoring/grafana';

const METRIC = /libriant_[a-z0-9_]+/g;

const problems: string[] = [];
const fail = (m: string) => problems.push(m);

const read = (rel: string): string => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------------------
// The declarations
// ---------------------------------------------------------------------------

const declared = new Map<string, MetricDeclaration>(allMetrics().map((m) => [m.name, m]));

/**
 * Where each source's metrics are written, and which Prometheus job collects
 * them. A `source` with no entry here is a declaration nothing can check.
 */
const SOURCES: Record<
  MetricDeclaration['source'],
  { files: string[]; job: string | null; jobNote: string }
> = {
  api: {
    files: ['apps/api/src/platform'],
    job: 'libriant-api',
    jobNote: 'the API serves them on its own /metrics',
  },
  worker: {
    files: [
      'apps/api/src/worker.ts',
      'apps/api/src/queues',
      'apps/api/src/jobs/scheduled-jobs.runner.ts',
      'apps/api/src/email/outbox-census.ts',
    ],
    job: 'libriant-worker',
    jobNote: 'the worker serves them on its own /metrics',
  },
  web: {
    files: ['apps/web/app/api/metrics/route.ts'],
    job: 'libriant-web',
    jobNote: 'the Next route serves them at /api/metrics',
  },
  backup: {
    files: ['scripts/backup.sh'],
    // Written to a file node-exporter reads; there is no job of its own.
    job: null,
    jobNote: 'written to the node-exporter textfile directory, collected by the `node` job',
  },
};

// ---------------------------------------------------------------------------
// Emitter scan — comments stripped, so prose cannot pass for an emission
// ---------------------------------------------------------------------------

/**
 * Blank out `//`, block and `#` comments so a metric NAMED IN PROSE does not
 * count as emitted.
 *
 * This is the fix for the first structural limit above, and it has teeth: this
 * file's own header quotes the misspelt backup metric, `metrics.registry.ts`
 * quotes it too, and both would otherwise register as emissions of a metric
 * that has never existed.
 *
 * String literals are KEPT — that is where the names actually live.
 */
function stripComments(src: string, kind: 'ts' | 'sh'): string {
  if (kind === 'sh') {
    return src
      .split('\n')
      .map((l) => l.replace(/(^|\s)#.*$/, '$1'))
      .join('\n');
  }
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'tpl' = 'code';
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (mode === 'code') {
      if (two === '//') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (two === '/*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (src[i] === "'") mode = 'single';
      else if (src[i] === '"') mode = 'double';
      else if (src[i] === '`') mode = 'tpl';
      out += src[i++];
      continue;
    }
    if (mode === 'line') {
      if (src[i] === '\n') {
        mode = 'code';
        out += '\n';
      }
      i++;
      continue;
    }
    if (mode === 'block') {
      if (two === '*/') {
        mode = 'code';
        i += 2;
        continue;
      }
      if (src[i] === '\n') out += '\n';
      i++;
      continue;
    }
    // inside a string: copy verbatim, honouring backslash escapes
    if (src[i] === '\\') {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    const quote = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
    if (src[i] === quote) mode = 'code';
    out += src[i++];
  }
  // A file that ends mid-comment or mid-string did not tokenize correctly.
  //
  // This tokenizer does not know about REGEX LITERALS — telling `/` as division
  // from `/` as a regex start needs a real parser — so a literal containing
  // `/*` would open a block comment and swallow the rest of the file. That
  // fails LOUD (every metric below it reads as unemitted) rather than silently,
  // which is the safe direction, but the symptom points at the wrong thing
  // entirely. TypeScript has already rejected a genuinely unterminated comment
  // by the time this runs, so reaching here means the stripper is wrong, and
  // saying so beats reporting six metrics as missing.
  if (mode !== 'code') {
    throw new Error(
      `check-alerts could not tokenize a source file: it ends inside a ${mode}. ` +
        'The usual cause is a regular-expression literal containing `/*` or `//`, which this ' +
        'deliberately simple stripper reads as a comment. Move the pattern into a named ' +
        'constant built with `new RegExp(...)`, or extend stripComments.',
    );
  }
  return out;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'build', '.turbo', 'out', 'test']);

function walk(rel: string, out: string[] = []): string[] {
  const abs = path.join(ROOT, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return out;
  }
  if (st.isFile()) {
    out.push(rel);
    return out;
  }
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(child, out);
    else if (/\.(ts|mts|tsx|js|mjs|sh)$/.test(e.name) && !/\.spec\.tsx?$/.test(e.name)) {
      out.push(child);
    }
  }
  return out;
}

/**
 * The declaration site is NOT an emitter.
 *
 * `metrics.registry.ts` names every metric in a string literal, so a scan that
 * included it would find every declaration "emitted" by the file that declares
 * it — and check 4 below, the one that catches a metric rendered by a function
 * nobody calls, would pass on any registry at all. It did, until a deliberately
 * unemitted declaration was added and the gate stayed green.
 */
const NOT_AN_EMITTER = new Set(['apps/api/src/observability/metrics.registry.ts']);

/**
 * `libriant_x_bucket` is a series of the histogram `libriant_x`, not a metric.
 *
 * Only stripped when the base is DECLARED AS A HISTOGRAM — otherwise a rule or
 * a dashboard naming `libriant_tenants_total_count` would normalise onto
 * `libriant_tenants_total` and pass, which is the undeclared-name failure this
 * gate exists for, wearing a suffix.
 */
function baseName(name: string): string {
  const stripped = name.replace(/_(bucket|sum|count)$/, '');
  return declared.get(stripped)?.type === 'histogram' ? stripped : name;
}

/** metric name → source → the files under that source that write it. */
const emittedIn = new Map<string, Map<MetricDeclaration['source'], string[]>>();
for (const [source, spec] of Object.entries(SOURCES) as Array<
  [MetricDeclaration['source'], (typeof SOURCES)[MetricDeclaration['source']]]
>) {
  for (const rel of spec.files.flatMap((f) => walk(f))) {
    if (NOT_AN_EMITTER.has(rel)) continue;
    const raw = read(rel);
    if (!raw) continue;
    const isShell = rel.endsWith('.sh');
    let code: string;
    try {
      code = stripComments(raw, isShell ? 'sh' : 'ts');
    } catch (err) {
      fail(`${rel}: ${(err as Error).message}`);
      continue;
    }
    // Shell is scanned by CALL SITE, not by regex over the whole file: the
    // backup script also names databases (`libriant_control`), which match the
    // metric shape exactly. `obs_set` / `obs_set_labelled` is the one way this
    // repo writes a metric from a shell script.
    const names = isShell
      ? [...code.matchAll(/\bobs_set(?:_labelled)?\s+(libriant_[a-z0-9_]+)/g)].map((m) => m[1]!)
      : (code.match(METRIC) ?? []);
    for (const name of new Set(names)) {
      // Suffixed histogram series (`…_bucket`) are rendered by the registry,
      // not written literally, so nothing here should produce one — but
      // normalise anyway rather than reporting a name that only looks
      // undeclared.
      const key = declared.has(name) ? name : baseName(name);
      const bySource = emittedIn.get(key) ?? new Map<MetricDeclaration['source'], string[]>();
      const list = bySource.get(source) ?? [];
      if (!list.includes(rel)) list.push(rel);
      bySource.set(source, list);
      emittedIn.set(key, bySource);
    }
  }
}

// 3. every literal in an emitter is declared
for (const [name, bySource] of emittedIn) {
  if (declared.has(name)) continue;
  const files = [...bySource.values()].flat();
  fail(
    `${files[0]}: writes "${name}", which is not declared in ` +
      'apps/api/src/observability/metrics.registry.ts.\n' +
      '      A metric nothing declares cannot be alerted on, because nothing knows it exists.',
  );
}

// 4. every declaration is actually emitted — BY THE SOURCE IT CLAIMS
for (const d of declared.values()) {
  if (emittedIn.get(d.name)?.has(d.source)) continue;
  fail(
    `"${d.name}" is declared with source "${d.source}" but no file under ` +
      `${SOURCES[d.source].files.join(', ')} writes it.\n` +
      '      Either the emitter was removed and the declaration is now fiction, or it is ' +
      'rendered by a function nobody calls — which is how libriant_worker_job_last_ok ' +
      'reached production with a passing unit test and no series.',
  );
}

// 5. the two emitters that cannot import the registry must match it verbatim
//
// Bound to the NAME, not merely present in the file. Searching the whole source
// for the HELP string would pass on two metrics whose HELP texts had been
// swapped — every string is still there, attached to the wrong gauge, and the
// exposition parses perfectly.
for (const d of declared.values()) {
  if (d.source !== 'web' && d.source !== 'backup') continue;
  // `'"'"'` is how a POSIX single-quoted string embeds an apostrophe. The
  // shell sees one character; a naive comparison sees five and reports a HELP
  // text that is in fact identical.
  const src = SOURCES[d.source].files
    .map((f) => read(f))
    .join('\n')
    .replaceAll(`'"'"'`, "'");
  if (!src) continue;
  const where = SOURCES[d.source].files[0];
  if (d.source === 'web') {
    // The Next route writes the exposition literally.
    if (!src.includes(`# HELP ${d.name} ${d.help}`)) {
      fail(
        `${where}: the HELP line for "${d.name}" does not match the declaration.\n` +
          `      declared: # HELP ${d.name} ${d.help}\n` +
          '      This emitter cannot import the registry, so the two are kept honest here.',
      );
    }
    if (!src.includes(`# TYPE ${d.name} ${d.type}`)) {
      fail(`${where}: "${d.name}" is not exposed as a ${d.type}.`);
    }
    continue;
  }
  // backup.sh passes the HELP as the last argument, on its own continuation
  // line:  obs_set <name> "<value>" \\
  //          '<help>'
  //
  // Taken between the FIRST and LAST apostrophe of that line rather than with a
  // `'([^']*)'` capture: the shell embeds an apostrophe as `'"'"'`, which the
  // un-escaping above has already turned back into one, so a character class
  // that stops at the first `'` truncates every HELP containing the word
  // "man's" — which is the dead man's switch itself.
  const helpLine = helpArgumentFor(src, d.name);
  if (helpLine === null) {
    fail(`${where}: no obs_set call for "${d.name}" carries a HELP string.`);
  } else if (helpLine !== d.help) {
    fail(
      `${where}: the HELP text for "${d.name}" does not match the declaration.\n` +
        `      declared: ${d.help}\n      emitted:  ${helpLine}`,
    );
  }
}

/** The single-quoted HELP argument of the first `obs_set <name> …` call. */
function helpArgumentFor(src: string, name: string): string | null {
  const call = new RegExp(`obs_set(?:_labelled)?\\s+${name}\\s`).exec(src);
  if (!call) return null;
  const rest = src.slice(call.index);
  // The call spans at most two lines: the value, then the continuation holding
  // the help. Stop before the next call so a missing help cannot borrow one.
  const upToNext = rest.slice(
    0,
    rest.indexOf('obs_set', 1) === -1 ? undefined : rest.indexOf('obs_set', 1),
  );
  const first = upToNext.indexOf("'");
  const last = upToNext.lastIndexOf("'");
  if (first === -1 || last <= first) return null;
  return upToNext.slice(first + 1, last);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const alertsSrc = read(ALERTS);
if (!alertsSrc) fail(`${ALERTS} is missing — there are no rules at all.`);

type Rule = { name: string; expr: string; inExpr?: boolean };
const rules: Rule[] = [];
{
  let current: Rule | null = null;
  for (const raw of alertsSrc.split('\n')) {
    const line = raw.replace(/#.*$/, '');
    const alert = /^\s*-\s*alert:\s*(\S+)/.exec(line);
    if (alert) {
      if (current) rules.push(current);
      current = { name: alert[1]!, expr: '' };
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
}

// 1. every metric a rule names is declared
const alertedMetrics = new Set<string>();
for (const r of rules) {
  for (const m of r.expr.match(METRIC) ?? []) {
    const key = declared.has(m) ? m : baseName(m);
    if (!declared.has(key)) {
      fail(
        `${ALERTS}: rule ${r.name} references "${m}", which nothing declares.\n` +
          '      The expression is valid PromQL and will simply never match.',
      );
      continue;
    }
    alertedMetrics.add(key);
  }
}

// 2. every metric declared alert:true has a rule
for (const d of declared.values()) {
  if (!d.alert || alertedMetrics.has(d.name)) continue;
  fail(
    `"${d.name}" is declared alert:true but no rule in ${ALERTS} references it.\n` +
      '      Either write the rule, or declare it alert:false with a reason. A metric that is ' +
      'emitted, scraped and unalerted measures something that can fail in silence.',
  );
}

// ---------------------------------------------------------------------------
// 6. Scrape coverage
// ---------------------------------------------------------------------------

const scrapeSrc = read(SCRAPE);
if (!scrapeSrc) fail(`${SCRAPE} is missing — nothing is collected.`);
const jobs = new Set([...scrapeSrc.matchAll(/^\s*-\s*job_name:\s*(\S+)/gm)].map((m) => m[1]!));
const neededJobs = new Set<string>();
for (const d of declared.values()) {
  const job = SOURCES[d.source].job;
  if (job) neededJobs.add(job);
}
// The backup source has no scrape job of its own: it writes a file that
// node-exporter's textfile collector picks up. That collector is opt-in behind
// a flag, and without it the file is written every night and scraped by
// nothing — a dead man's switch with no man. So the equivalent assertion for
// this source is that the flag is set and its directory matches the one
// backup.sh writes to.
{
  const monitoring = read('infra/monitoring/docker-compose.monitoring.yml');
  const dir = /BACKUP_TEXTFILE_DIR:-([^}]+)\}/.exec(read('scripts/backup.sh'))?.[1]?.trim();
  const usesBackupSource = [...declared.values()].some((d) => d.source === 'backup');
  if (usesBackupSource && dir) {
    if (!monitoring.includes(`--collector.textfile.directory=${dir}`)) {
      fail(
        `infra/monitoring/docker-compose.monitoring.yml: node-exporter does not enable the ` +
          `textfile collector at "${dir}", which is where scripts/backup.sh writes its metrics.\n` +
          '      Without the flag the file is produced every night and read by nobody, and every ' +
          "backup rule — including BackupNeverRan, the dead man's switch — can never fire.",
      );
    }
    if (!monitoring.includes(`${dir}:${dir}:ro`)) {
      fail(
        `infra/monitoring/docker-compose.monitoring.yml: "${dir}" is not mounted into ` +
          'node-exporter, so the collector directory is empty inside the container.',
      );
    }
  }
}

for (const job of neededJobs) {
  if (jobs.has(job)) continue;
  fail(
    `${SCRAPE}: no scrape job "${job}", but metrics are declared for it ` +
      `(${SOURCES[[...declared.values()].find((d) => SOURCES[d.source].job === job)!.source].jobNote}).\n` +
      '      An emitted metric nobody collects is a metric that does not exist.',
  );
}

// ---------------------------------------------------------------------------
// 7. Dashboards
// ---------------------------------------------------------------------------

for (const rel of walkAny(DASHBOARDS)) {
  if (!rel.endsWith('.json')) continue;
  const src = read(rel);
  for (const name of new Set(src.match(METRIC) ?? [])) {
    if (declared.has(baseName(name))) continue;
    fail(
      `${rel}: a panel queries "${name}", which nothing declares. ` +
        'The panel renders empty — the same failure as a rule that never matches.',
    );
  }
}

function walkAny(rel: string, out: string[] = []): string[] {
  const abs = path.join(ROOT, rel);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) walkAny(child, out);
    else out.push(child);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 8. Documentation
// ---------------------------------------------------------------------------

/**
 * `libriant_`-prefixed identifiers in the docs that are NOT metrics.
 *
 * The prefix is used for databases, docker volumes, cookies and one file name,
 * so a doc scan that treats every match as a metric would cry wolf on a dozen
 * true statements — and a gate that cries wolf gets switched off, which is the
 * lesson `check-alerts` already records from its own `[PLACEHOLDER]` count.
 * Each entry names what the identifier actually is.
 */
const DOC_NON_METRICS: Record<string, string> = {
  libriant_control: 'the control-plane database',
  libriant_demo: 'the demo tenant database in the CI fixture',
  libriant_shadow: 'the throwaway shadow database check:schema-drift builds',
  libriant_smoke: 'the throwaway database tenant:smoke builds',
  libriant_session: 'the staff session cookie',
  libriant_admin: 'the platform-admin session cookie',
  libriant_imp: 'the impersonation cookie',
  libriant_backup:
    'the node-exporter textfile scripts/backup.sh writes (libriant_backup.prom), not a metric',
  libriant_worker_jobs_total:
    'named in §7.4 precisely BECAUSE it does not exist — the table of health surfaces that lie',
};

/**
 * …plus every docker volume and network the compose files declare.
 *
 * DERIVED, not listed. Hand-listing them meant a routine RUNBOOK edit naming a
 * volume nobody had thought to add would fail this gate — the cry-wolf outcome
 * that gets a checker switched off. Compose already knows the full set, and the
 * project prefix is `libriant`, so `${'$'}{project}_${'$'}{name}` is exactly the
 * shape these identifiers take in the docs.
 */
function composeIdentifiers(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of [
    'infra/compose/docker-compose.prod.yml',
    'infra/compose/docker-compose.dev.yml',
    'infra/monitoring/docker-compose.monitoring.yml',
  ]) {
    const src = read(file);
    if (!src) continue;
    for (const section of ['volumes', 'networks'] as const) {
      const block = new RegExp(`^${section}:\\n((?:[ \\t].*\\n|\\n)*)`, 'm').exec(src);
      if (!block) continue;
      for (const m of block[1]!.matchAll(/^ {2}([a-z0-9_-]+):/gm)) {
        out.set(`libriant_${m[1]!.replaceAll('-', '_')}`, `a docker ${section.slice(0, -1)}`);
      }
    }
  }
  return out;
}
for (const [name, what] of composeIdentifiers()) {
  if (!(name in DOC_NON_METRICS)) DOC_NON_METRICS[name] = what;
}

const DOC_FILES = ['README.md', 'docs/RUNBOOK.md'];
for (const rel of DOC_FILES) {
  const src = read(rel);
  if (!src) continue;
  for (const name of new Set(src.match(METRIC) ?? [])) {
    // `libriant_worker_job_*` in prose matches up to the underscore; a trailing
    // `_` is never a real metric name.
    if (name.endsWith('_')) continue;
    if (name in DOC_NON_METRICS) continue;
    if (declared.has(baseName(name))) continue;
    fail(
      `${rel}: documents "${name}", which nothing declares.\n` +
        '      README.md carried `libriant_jobs_in_flight{queue="email"}` in its worker drill for ' +
        'months — a metric name that never existed anywhere, with a label value that was not a ' +
        'queue name either. An operator following that drill sees an empty response and ' +
        'concludes the worker is broken.\n' +
        '      If the mention is deliberate (documenting something that does NOT exist), add it ' +
        'to DOC_NON_METRICS in this script with the reason.',
    );
  }
}

// ---------------------------------------------------------------------------
// 9. The dead man's switch
// ---------------------------------------------------------------------------

// The one rule whose absence is invisible by design: if alerting breaks,
// nothing fires, and silence reads as health.
const watchdog = rules.find((r) => r.name === 'Watchdog');
if (!watchdog) {
  fail(
    `${ALERTS}: no Watchdog rule. Without a heartbeat that fires ALWAYS, a broken alerting ` +
      'pipeline is indistinguishable from a quiet night.',
  );
} else if (!/vector\(1\)/.test(watchdog.expr)) {
  fail(`${ALERTS}: the Watchdog rule must be unconditionally true (\`vector(1)\`).`);
}

const routesSrc = read(ROUTES);
if (!routesSrc) {
  fail(`${ROUTES} is missing — Prometheus has nowhere to deliver a firing rule.`);
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
 */
const routesCode = routesSrc.replace(/#.*$/gm, '');

if (routesSrc && !/alertname\s*=\s*Watchdog/.test(routesCode)) {
  fail(
    `${ROUTES}: the Watchdog alert has no route of its own. It must go to a receiver that ` +
      'alerts on SILENCE, not to the same place as real alerts — otherwise a dead pipeline ' +
      'looks exactly like a healthy one.',
  );
}

// ---------------------------------------------------------------------------
// 10. Receivers
// ---------------------------------------------------------------------------

type Receiver = { name: string; code: string; prose: string };

/**
 * Every `receivers:` entry, and whether it can actually deliver anything.
 *
 * WHY THIS REPLACED A `[PLACEHOLDER]` COUNT. The old version counted the string
 * anywhere in the file and printed "NOT DELIVERING YET — 3 [PLACEHOLDER]
 * receiver(s)" for a file with two receivers: the third match was the header
 * comment explaining the convention. A count of a marker is not a statement
 * about delivery — and the state this file is in is one receiver DELIVERING and
 * one deliberately OPEN, which a single number cannot express.
 */
function parseReceivers(src: string): Receiver[] {
  const out: Receiver[] = [];
  let inSection = false;
  let current: Receiver | null = null;
  // A run of comment/blank lines belongs to whatever comes NEXT, not to what
  // came before. The `watchdog` receiver is the case that matters: the whole
  // explanation of why it is deliberately open — and the [PLACEHOLDER] that
  // says so — is written above its `- name:` line.
  let pending = '';
  const flush = () => {
    if (current) current.prose += pending;
    pending = '';
  };
  for (const raw of src.split('\n')) {
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
      current = { name: name[1]!, code: '', prose: pending };
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
const routed = new Set<string>();
let defaultReceiver = '';
let watchdogReceiver = '';
{
  let sawWatchdogMatcher = false;
  for (const raw of routesCode.split('\n')) {
    // `- receiver: x` as well as `receiver: x`: a route written as a list item
    // is valid Alertmanager YAML, and missing it would let "Watchdog routed
    // apart" be printed without ever having been checked.
    const rec = /^\s*-?\s*receiver:\s*'?"?([^'"\s]+)'?"?/.exec(raw);
    if (/alertname\s*=\s*Watchdog/.test(raw)) sawWatchdogMatcher = true;
    if (!rec) continue;
    routed.add(rec[1]!);
    if (!defaultReceiver) defaultReceiver = rec[1]!;
    if (sawWatchdogMatcher && !watchdogReceiver) watchdogReceiver = rec[1]!;
  }
}

for (const name of routed) {
  if (receiverByName.has(name)) continue;
  fail(
    `${ROUTES}: a route sends alerts to receiver '${name}', which is not defined. ` +
      'Alertmanager refuses to start on that, so nothing would be delivered at all.',
  );
}

// The dead man's switch must not share the destination of the alerts it exists
// to prove are still flowing. Asserted rather than commented, because the
// tempting shortcut — pointing `watchdog` at the receiver that already works —
// is exactly the change that makes a dead pipeline look like a quiet night.
if (watchdogReceiver && defaultReceiver && watchdogReceiver === defaultReceiver) {
  fail(
    `${ROUTES}: the Watchdog route and the default route share receiver '${watchdogReceiver}'. ` +
      'The heartbeat must go somewhere that complains when it STOPS arriving; delivered ' +
      'alongside real alerts it proves nothing.',
  );
}

// ---------------------------------------------------------------------------

if (problems.length) {
  console.error(`✗ alerts: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`    ${p}\n`);
  console.error(
    'A rule on a metric nothing emits can never fire, and a metric with no rule can fail in\n' +
      'silence. Both read as coverage from the file you happen to be looking at.',
  );
  process.exit(1);
}

const alerted = [...declared.values()].filter((d) => d.alert).length;
const silent = declared.size - alerted;
console.log(
  `alert check passed: ${declared.size} declared metric(s) across ` +
    `${new Set([...declared.values()].map((d) => d.source)).size} source(s) — ${alerted} alerted, ` +
    `${silent} deliberately silent with a stated reason; ${rules.length} rule(s), every ` +
    `libriant_* in one of them declared and every declaration emitted by the source it claims; ` +
    `every source that is scraped over HTTP has a job and the backup source's textfile ` +
    `collector is wired; every libriant_* in README.md and the RUNBOOK is a real ` +
    `metric or a named exception; Watchdog present, unconditional and routed apart.`,
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
  if (brokenUrl) return { ...r, state: 'broken' as const };
  if (hasConfig) return { ...r, state: 'delivering' as const };
  return { ...r, state: (pendingNote ? 'pending' : 'silent') as const };
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
