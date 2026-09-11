/**
 * Every metric this platform emits, declared once.
 *
 * ## The failure this exists for
 *
 * While wiring the alerting that reliability-04 found missing, a rule was
 * written against `libriant_backup_last_offsite_success_timestamp_seconds`.
 * The metric is called `libriant_backup_offsite_last_success_timestamp_seconds`.
 * Prometheus does not complain: the expression is valid PromQL, it just matches
 * nothing — so the alert sat there looking like coverage and could never fire.
 * `scripts/check-alerts.ts` — then a `.mjs`, rewritten in 2.0 phase 5 to read
 * this file — was written to catch exactly that, by grepping the source for
 * `libriant_*` and comparing.
 *
 * That check has a shape problem it cannot fix from the outside: *any*
 * occurrence of the string counts as "emitted". A metric named only in a
 * comment, in a test assertion, or in the checker's own prose satisfies it. And
 * it can only ever check ONE direction — a rule naming a metric nobody writes.
 * The opposite failure is just as real and completely invisible: a metric that
 * is emitted, scraped, charted, and has no alert at all, so the thing it
 * measures can fail silently for as long as nobody happens to look at a
 * dashboard. `libriant_backup_last_exit_code` was in exactly that state: a
 * backup that failed at 03:00 was first mentioned by `BackupStale`, 36 hours
 * later.
 *
 * So the declaration moves here, where it can be reasoned about:
 *
 *   - the NAME, HELP text, TYPE and LABEL KEYS are written once, and the API
 *     and worker render their exposition through {@link metricHeader} and
 *     {@link metricLine} rather than repeating them;
 *   - `alert` says whether a rule MUST exist, and `alert: false` requires a
 *     reason, so "no rule" is a decision with a name on it rather than an
 *     omission;
 *   - `check:alerts` reads THIS FILE and asserts both directions, plus that
 *     every literal metric name in an emitter is declared and every declared
 *     metric is actually emitted somewhere.
 *
 * ## Why not prom-client
 *
 * The same reason `http-metrics.ts` gives: the API ships no metrics dependency,
 * `/metrics` is already assembled as an array of strings, and adding a package
 * to the production image runs against supply-chain-03. This is ~150 lines of
 * declaration and two renderers, not a metrics library.
 */

/** Prometheus metric types this platform uses. */
export type MetricType = 'counter' | 'gauge' | 'histogram';

/**
 * Which process writes the metric. Not decoration: it tells `check:alerts`
 * WHERE to look for the emission, and it is the only way to notice that a
 * metric is emitted by a process nothing scrapes.
 */
export type MetricSource =
  /** `apps/api` — served on the API's own `/metrics`, scraped as `libriant-api`. */
  | 'api'
  /** `apps/api/src/worker.ts` — served on the worker's `/metrics`, scraped as `libriant-worker`. */
  | 'worker'
  /** `apps/web/app/api/metrics/route.ts` — Next route, scraped as `libriant-web`. */
  | 'web'
  /** `scripts/backup.sh` → a node-exporter textfile, scraped as part of `node`. */
  | 'backup';

export type MetricDeclaration = {
  /** Exposition name. Must start `libriant_`. */
  readonly name: string;
  /** The `# HELP` text, verbatim. */
  readonly help: string;
  readonly type: MetricType;
  /**
   * Label KEYS, in the order they are rendered. Omit for an unlabelled metric.
   * `le` is never declared — it belongs to a histogram's `_bucket` series and
   * is added by the renderer.
   */
  readonly labels?: readonly string[];
  readonly source: MetricSource;
  /**
   * `true`  — at least one rule in `infra/monitoring/alerts.yml` must reference
   *           this metric, or the build fails.
   * `false` — deliberately unalerted. `why` is then mandatory.
   */
  readonly alert: boolean;
  /** Required when `alert` is false: why silence is the right answer here. */
  readonly why?: string;
};

/**
 * Declare one metric.
 *
 * `const D` keeps the literal types, so {@link MetricName} is a union of the
 * actual names and a typo at a call site is a compile error rather than a
 * series nobody notices is missing.
 */
export function defineMetric<const D extends MetricDeclaration>(d: D): D {
  if (!/^libriant_[a-z0-9_]+$/.test(d.name)) {
    throw new Error(`Metric "${d.name}" must match /^libriant_[a-z0-9_]+$/.`);
  }
  if (!d.help.trim() || !/[.!]$/.test(d.help.trim())) {
    // A HELP string is what an operator reads at 03:00. Requiring a full
    // sentence is cheap and stops "count" from being the whole explanation.
    throw new Error(`Metric "${d.name}" needs a HELP sentence ending in a full stop.`);
  }
  if (/[\\\n]/.test(d.help)) {
    // A `#`-comment line in the exposition is raw: Prometheus reads HELP to the
    // end of the line and unescapes `\\` and `\n`. A backslash in the text is
    // therefore either mangled or, with a newline, splits one HELP into a
    // second line the parser rejects. Refused rather than escaped, because
    // every HELP in this registry is prose written by hand and none of them
    // needs one.
    throw new Error(
      `Metric "${d.name}" has a backslash or newline in its HELP text. ` +
        'Prometheus unescapes both in a HELP line; rewrite the sentence without them.',
    );
  }
  if (d.labels?.includes('le')) {
    throw new Error(`Metric "${d.name}" must not declare the "le" label — the renderer adds it.`);
  }
  if (!d.alert && !d.why?.trim()) {
    throw new Error(
      `Metric "${d.name}" is declared alert:false with no reason. ` +
        'An unalerted metric is a thing that can fail silently; say why that is acceptable.',
    );
  }
  if (d.alert && d.why) {
    throw new Error(
      `Metric "${d.name}" is alert:true — "why" only documents a deliberate silence.`,
    );
  }
  return d;
}

// ---------------------------------------------------------------------------
// The declarations. Grouped by the process that writes them.
// ---------------------------------------------------------------------------

export const METRICS = [
  // --- API process (apps/api/src/platform/health.controller.ts) -------------
  defineMetric({
    name: 'libriant_api_uptime_seconds',
    help: 'Process uptime in seconds.',
    type: 'counter',
    source: 'api',
    alert: false,
    why: 'A restart loop shows as `up` flapping, which TargetDown already pages on; a threshold on uptime itself would page on every deploy.',
  }),
  defineMetric({
    name: 'libriant_api_build_info',
    help: 'Build information.',
    type: 'gauge',
    labels: ['node_env'],
    source: 'api',
    alert: false,
    why: 'An identity series, always 1. It exists to join build labels onto other queries, not to cross a threshold.',
  }),
  defineMetric({
    name: 'libriant_api_requests_total',
    help: 'HTTP requests handled, by method, route pattern and status.',
    type: 'counter',
    labels: ['method', 'route', 'status'],
    source: 'api',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_api_request_duration_seconds',
    help: 'Request latency by route pattern.',
    type: 'histogram',
    labels: ['route'],
    source: 'api',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_tenants_total',
    help: 'Number of tenants (libraries) by status.',
    type: 'gauge',
    labels: ['status'],
    source: 'api',
    alert: false,
    why: 'A growth series for the fleet dashboard. There is no count that is right for a five-library pilot and wrong for a fifty-library one, so any threshold would be arbitrary.',
  }),
  defineMetric({
    name: 'libriant_storage_used_bytes',
    help: 'Tracked per-tenant storage usage, summed.',
    type: 'gauge',
    source: 'api',
    alert: false,
    why: 'Disk pressure is alerted at the filesystem (HostDiskFilling / HostDiskCritical), which is the layer that actually runs out. This gauge attributes the growth; it does not detect it.',
  }),
  defineMetric({
    name: 'libriant_pg_connections',
    help: 'Current Postgres backend connections.',
    type: 'gauge',
    source: 'api',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_pg_connections_max',
    help: 'Postgres max_connections setting.',
    type: 'gauge',
    source: 'api',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_pg_cache_hit_ratio',
    help: 'Postgres buffer cache hit ratio (0-1).',
    type: 'gauge',
    source: 'api',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_redis_used_memory_bytes',
    help: 'Redis used_memory in bytes.',
    type: 'gauge',
    source: 'api',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_api_tenant_conn_peak',
    help: 'Worst-case tenant DB connections this API instance may hold.',
    type: 'gauge',
    source: 'api',
    alert: false,
    why: 'A plan constant, not a measurement — it changes only on deploy. The runtime consequence is alerted on libriant_pg_connections; the plan itself is asserted at build time by tenant-pool-budget.spec.ts.',
  }),
  defineMetric({
    name: 'libriant_api_tenant_conn_budget',
    help: 'Tenant DB connection budget for this API instance.',
    type: 'gauge',
    source: 'api',
    alert: false,
    why: 'The denominator for the gauge above. Alerting on a constant is alerting on the deploy that changed it.',
  }),

  // --- Worker process (apps/api/src/worker.ts) ------------------------------
  defineMetric({
    name: 'libriant_worker_uptime_seconds',
    help: 'Process uptime in seconds.',
    type: 'counter',
    source: 'worker',
    alert: false,
    why: 'Same reasoning as the API uptime counter: absence is TargetDown, and a value cannot be too small without also being a restart. It IS read by LibriantWorkerQueueWedged — as a guard, so that rule cannot evaluate before its own six-hour window has data — but nothing thresholds it.',
  }),
  defineMetric({
    name: 'libriant_worker_jobs_running',
    help: 'Number of jobs currently in-flight, by queue.',
    type: 'gauge',
    labels: ['queue'],
    source: 'worker',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_worker_consumer_up',
    help: 'Whether each registered queue consumer is running (1) or not (0).',
    type: 'gauge',
    labels: ['queue'],
    source: 'worker',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_worker_tenant_conn_peak',
    help: 'Worst-case tenant DB connections this worker may hold.',
    type: 'gauge',
    source: 'worker',
    alert: false,
    why: 'A plan constant. See libriant_api_tenant_conn_peak — the runtime consequence is libriant_pg_connections, and the arithmetic is asserted at build time.',
  }),
  defineMetric({
    name: 'libriant_worker_tenant_conn_budget',
    help: 'Tenant DB connection budget for this worker.',
    type: 'gauge',
    source: 'worker',
    alert: false,
    why: 'The denominator for the gauge above, and a plan constant like it. The ratio that matters at runtime is libriant_pg_connections over libriant_pg_connections_max, which is alerted.',
  }),
  defineMetric({
    name: 'libriant_worker_job_last_ok',
    help: 'Whether the last run of this scheduled job completed without failed units of work.',
    type: 'gauge',
    // `sweep`, NOT `job`. `job` is Prometheus's own target label: with the
    // default `honor_labels: false` the scrape keeps job="libriant-worker" and
    // renames the exposed one to `exported_job`. An alert templating
    // {{ $labels.job }} would have rendered "libriant-worker" on every page,
    // and `by (job)` would have collapsed all twelve sweeps into one series.
    // These three metrics had never reached a scrape, so this rename costs
    // nothing and is the last moment it is free.
    labels: ['sweep'],
    source: 'worker',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_worker_job_last_run_timestamp_seconds',
    help: "Unix time of this job's last completed run.",
    type: 'gauge',
    labels: ['sweep'],
    source: 'worker',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_worker_job_count',
    help: "The handler's own counters from its last run (tenantsFailed, rowsFailed, abandoned, and so on).",
    type: 'gauge',
    labels: ['sweep', 'count'],
    source: 'worker',
    alert: false,
    why: 'One series per handler-defined counter name, so no single threshold means the same thing across jobs. The run-level verdict those counters produce is libriant_worker_job_last_ok, which is alerted; this is the detail an operator reads after the page.',
  }),
  defineMetric({
    name: 'libriant_catalog_projection_drift_total',
    help: 'Bibliographic records whose relational projection disagrees with the record it is derived from, at the last nightly verify.',
    type: 'gauge',
    source: 'worker',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_catalog_projection_scanned_total',
    help: 'Bibliographic records re-projected by the last nightly verify.',
    type: 'gauge',
    source: 'worker',
    alert: false,
    why: 'The denominator. It is what makes a drift count readable — 12 of 12 is a projector change, 12 of 400,000 is a lost write — and a threshold on the total size of the fleet catalogue would page on a successful import.',
  }),
  defineMetric({
    name: 'libriant_partition_headroom_months',
    help: 'Months of monthly partitions still ahead of the current month, for the tightest partitioned table in the fleet.',
    type: 'gauge',
    source: 'worker',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_partitions_created_total',
    help: 'Monthly partitions created by the last partition-maintenance run.',
    type: 'gauge',
    source: 'worker',
    alert: false,
    why: 'Zero is the normal and correct value — a month passes once a month, so this is non-zero on about one tick in thirty. A threshold on it would page on a working system, and the failure it would supposedly catch (the window running out) is what libriant_partition_headroom_months alerts on, from the other end and with time to act.',
  }),
  defineMetric({
    name: 'libriant_circ_ledger_drift_total',
    help: 'Open ledger discrepancies: transactions that do not balance, fees whose counters disagree with their allocations, and accounts whose balance disagrees with the fees behind them.',
    type: 'gauge',
    labels: ['identity'],
    source: 'worker',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_hold_transit_overdue_total',
    help: 'Copies sent to a branch FOR A READER that have passed their expected arrival and not been received.',
    type: 'gauge',
    source: 'worker',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_hold_transit_overdue_oldest_days',
    help: 'How late, in days, the oldest un-received hold transit in the fleet is.',
    type: 'gauge',
    source: 'worker',
    alert: false,
    why: 'The shape of the count, not a second threshold on it. One crate a day late and one crate three weeks late are the same number on libriant_hold_transit_overdue_total and very different problems; alerting on both would page twice for one crate.',
  }),
  defineMetric({
    name: 'libriant_hold_shelf_expired_total',
    help: 'Requests that expired off the hold shelf uncollected, at the last sweep.',
    type: 'gauge',
    source: 'worker',
    alert: false,
    why: 'A normal, healthy, non-zero number: readers do not always come. What it is FOR is the denominator a librarian reads beside libriant_hold_shelf_promoted_total, and a threshold on it would page for a library whose readers are busy.',
  }),
  defineMetric({
    name: 'libriant_hold_shelf_promoted_total',
    help: 'Copies that went straight to the next reader in the queue when a hold-shelf request expired.',
    type: 'gauge',
    source: 'worker',
    alert: false,
    why: 'The half of the shelf sweep that is a service to a reader rather than a disappointment. Zero is normal in a small library and says nothing on its own, so there is nothing here to threshold.',
  }),
  defineMetric({
    name: 'libriant_email_outbox_rows',
    help: 'E-mail outbox rows by status.',
    type: 'gauge',
    labels: ['status'],
    source: 'worker',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_email_outbox_oldest_pending_seconds',
    help: 'Age of the oldest e-mail still owed, in seconds.',
    type: 'gauge',
    source: 'worker',
    alert: true,
  }),

  // --- Web process (apps/web/app/api/metrics/route.ts) ----------------------
  //
  // Rendered by a Next route handler, which cannot import from apps/api. The
  // declaration still lives here — `check:alerts` compares the route's literal
  // HELP/TYPE/name against it, so the two cannot drift.
  defineMetric({
    name: 'libriant_web_uptime_seconds',
    help: 'Process uptime in seconds.',
    type: 'counter',
    source: 'web',
    alert: false,
    why: 'Absence is what matters, and TargetDown covers it now that the web tier is scraped.',
  }),
  defineMetric({
    name: 'libriant_web_build_info',
    help: 'Build information.',
    type: 'gauge',
    source: 'web',
    alert: false,
    why: 'An identity series, always 1. WEB-03: this endpoint is publicly reachable, so it deliberately carries no node_env label.',
  }),

  // --- Backup (scripts/backup.sh → node-exporter textfile) ------------------
  //
  // Written by shell, which likewise cannot import this file. `check:alerts`
  // parses the `obs_set` calls and compares name and HELP against these.
  defineMetric({
    name: 'libriant_backup_last_run_timestamp_seconds',
    help: 'Unix time of the last backup attempt, successful or not.',
    type: 'gauge',
    source: 'backup',
    alert: false,
    why: 'A run that happened and failed is alerted by libriant_backup_last_exit_code; a run that never happened at all is alerted by BackupNeverRan on the success timestamp.',
  }),
  defineMetric({
    name: 'libriant_backup_last_exit_code',
    help: 'Exit status of the last backup run. 0 = complete; 1 = aborted or degraded.',
    type: 'gauge',
    source: 'backup',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_backup_duration_seconds',
    help: 'Wall-clock seconds of the last backup run.',
    type: 'gauge',
    source: 'backup',
    alert: false,
    why: 'A backup that runs long but succeeds is a capacity trend, not an incident; one that runs long and fails trips the exit-code rule. A duration threshold would have to be re-guessed at every fleet size.',
  }),
  defineMetric({
    name: 'libriant_backup_degraded',
    help: 'The backup completed but a promised property (off-site copy, encryption) was not met.',
    type: 'gauge',
    source: 'backup',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_backup_offsite_configured',
    help: 'RCLONE_REMOTE is set, so an off-server copy is attempted.',
    type: 'gauge',
    source: 'backup',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_backup_encrypted',
    help: 'Artefacts are encrypted at rest. The DPA states that they are.',
    type: 'gauge',
    source: 'backup',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_backup_artefact_bytes_postgres',
    help: 'Size of the last postgres dump artefact, in bytes.',
    type: 'gauge',
    source: 'backup',
    alert: false,
    why: 'A trend line for the restore-time estimate. A dump that is suspiciously small is caught by the restore drill (scripts/dr-drill.sh), which reads the artefact rather than its size.',
  }),
  defineMetric({
    name: 'libriant_backup_artefact_bytes_storage',
    help: 'Size of the last uploads archive, in bytes.',
    type: 'gauge',
    source: 'backup',
    alert: false,
    why: 'A trend line for the restore-time estimate, exactly as for the postgres artefact above. A suspiciously small archive is caught by the restore drill, which reads the artefact rather than its size.',
  }),
  defineMetric({
    name: 'libriant_backup_last_success_timestamp_seconds',
    help: "Unix time of the last fully successful backup. absent() on this metric is the dead man's switch.",
    type: 'gauge',
    source: 'backup',
    alert: true,
  }),
  defineMetric({
    name: 'libriant_backup_offsite_last_success_timestamp_seconds',
    help: 'Unix time of the last VERIFIED off-site copy.',
    type: 'gauge',
    source: 'backup',
    alert: true,
  }),
] as const;

/** Every declared metric name, as a union type. A typo is a compile error. */
export type MetricName = (typeof METRICS)[number]['name'];

const BY_NAME = new Map<string, MetricDeclaration>(METRICS.map((m) => [m.name, m]));
if (BY_NAME.size !== METRICS.length) {
  const seen = new Set<string>();
  const dup = METRICS.map((m) => m.name).find((n) => (seen.has(n) ? true : (seen.add(n), false)));
  throw new Error(`Metric "${dup}" is declared twice.`);
}

/** Look a declaration up by name. Throws on an undeclared name. */
export function metric(name: MetricName): MetricDeclaration {
  const d = BY_NAME.get(name);
  if (!d) throw new Error(`Metric "${name}" is not declared in metrics.registry.ts.`);
  return d;
}

/** Every declaration, for the gate and the tests. */
export function allMetrics(): readonly MetricDeclaration[] {
  return METRICS;
}

/** Prometheus label values must escape `\`, `"` and newlines. */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * The `# HELP` / `# TYPE` pair for a metric.
 *
 * Emitters call this instead of writing the two comment lines by hand. That is
 * the whole point of the registry: the declared HELP text and the exposed HELP
 * text are the same string, so they cannot disagree — and a rename is one edit.
 */
export function metricHeader(name: MetricName): string[] {
  const d = metric(name);
  return [`# HELP ${d.name} ${d.help}`, `# TYPE ${d.name} ${d.type}`];
}

/**
 * One sample line.
 *
 * Label KEYS are checked against the declaration, so a `{queue=…}` that should
 * have been `{q=…}` fails loudly at render time instead of quietly minting a
 * second series that no dashboard queries. Values are escaped.
 *
 * `suffix` is for histograms only (`_bucket`, `_sum`, `_count`); `le` is
 * accepted as a label alongside `_bucket` and nowhere else.
 */
export function metricLine(
  name: MetricName,
  value: number | bigint,
  labels?: Readonly<Record<string, string | number>>,
  suffix?: '_bucket' | '_sum' | '_count',
): string {
  const d = metric(name);
  if (suffix && d.type !== 'histogram') {
    throw new Error(`Metric "${name}" is a ${d.type}; "${suffix}" is a histogram suffix.`);
  }
  if (d.type === 'histogram' && !suffix) {
    throw new Error(`Metric "${name}" is a histogram — pass _bucket, _sum or _count.`);
  }
  const declared = new Set<string>(d.labels ?? []);
  if (suffix === '_bucket') declared.add('le');
  const entries = Object.entries(labels ?? {});
  for (const [k] of entries) {
    if (!declared.has(k)) {
      throw new Error(
        `Metric "${name}" has no label "${k}" (declared: ${[...declared].join(', ') || 'none'}).`,
      );
    }
  }
  const rendered = entries.length
    ? `{${entries.map(([k, v]) => `${k}="${escapeLabel(String(v))}"`).join(',')}}`
    : '';
  return `${d.name}${suffix ?? ''}${rendered} ${value}`;
}
