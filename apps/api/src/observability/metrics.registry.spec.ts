import { describe, expect, it } from 'vitest';
import { allMetrics, defineMetric, metric, metricHeader, metricLine } from './metrics.registry.js';

/**
 * The registry's own invariants.
 *
 * These are not tests of Prometheus formatting for its own sake. Every one of
 * them corresponds to a way the old arrangement — a name written out by hand at
 * each emission site — could go wrong without anything failing: a HELP text
 * that drifted from the rule's assumption, a label key spelled two ways so a
 * dashboard queried a series nobody wrote, a metric declared and never emitted.
 */

describe('the declarations', () => {
  it('declares a source, a type and a full HELP sentence for every metric', () => {
    for (const m of allMetrics()) {
      expect(m.name, 'name shape').toMatch(/^libriant_[a-z0-9_]+$/);
      expect(m.help.trim(), `${m.name} HELP`).toMatch(/[.!]$/);
      expect(['counter', 'gauge', 'histogram']).toContain(m.type);
      expect(['api', 'worker', 'web', 'backup']).toContain(m.source);
    }
  });

  it('makes every silence a decision with a reason on it', () => {
    // The whole point of `alert: false`. "No rule" used to be indistinguishable
    // from "nobody thought about it", which is how libriant_backup_last_exit_code
    // went unalerted while a failed backup waited 36 hours for BackupStale.
    for (const m of allMetrics().filter((m) => !m.alert)) {
      expect(m.why, `${m.name} is unalerted with no reason`).toBeTruthy();
      expect(m.why!.length, `${m.name}'s reason is too thin to be a decision`).toBeGreaterThan(40);
    }
  });

  it('never carries a reason on a metric that IS alerted', () => {
    for (const m of allMetrics().filter((m) => m.alert)) expect(m.why).toBeUndefined();
  });

  it('declares no name twice', () => {
    const names = allMetrics().map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('defineMetric', () => {
  const base = { help: 'A thing.', type: 'gauge', source: 'api', alert: true } as const;

  it('refuses a name outside the libriant_ namespace', () => {
    expect(() => defineMetric({ ...base, name: 'requests_total' })).toThrow(/must match/);
    expect(() => defineMetric({ ...base, name: 'libriant_Requests' })).toThrow(/must match/);
  });

  it('refuses a HELP text that is not a sentence', () => {
    // A HELP string is what somebody reads at 03:00. "count" is not an answer.
    expect(() => defineMetric({ ...base, name: 'libriant_x', help: 'count' })).toThrow(/HELP/);
  });

  it('refuses a HELP text Prometheus would unescape', () => {
    // A `# HELP` line is raw and Prometheus unescapes `\\` and `\n` in it, so a
    // backslash is mangled and a newline splits one HELP into a second line the
    // parser rejects. Refused rather than escaped: every HELP here is prose.
    expect(() =>
      defineMetric({ ...base, name: 'libriant_x', help: 'Matches \\d+ in the path.' }),
    ).toThrow(/backslash or newline/);
    expect(() => defineMetric({ ...base, name: 'libriant_x', help: 'Two\nlines.' })).toThrow(
      /backslash or newline/,
    );
  });

  it('refuses a declared `le` label — the renderer owns it', () => {
    expect(() =>
      defineMetric({ ...base, name: 'libriant_x', type: 'histogram', labels: ['route', 'le'] }),
    ).toThrow(/"le"/);
  });

  it('refuses an unalerted metric with no reason, and a reasoned one that IS alerted', () => {
    expect(() => defineMetric({ ...base, name: 'libriant_x', alert: false })).toThrow(/reason/);
    expect(() =>
      defineMetric({ ...base, name: 'libriant_x', alert: true, why: 'because' }),
    ).toThrow(/only documents/);
  });
});

describe('rendering', () => {
  it('emits the declared HELP and TYPE verbatim', () => {
    const d = metric('libriant_worker_jobs_running');
    expect(metricHeader('libriant_worker_jobs_running')).toEqual([
      `# HELP ${d.name} ${d.help}`,
      `# TYPE ${d.name} ${d.type}`,
    ]);
  });

  it('renders labels in the order they are given', () => {
    expect(
      metricLine('libriant_api_requests_total', 3, {
        method: 'GET',
        route: '/t/:slug/members',
        status: 200,
      }),
    ).toBe('libriant_api_requests_total{method="GET",route="/t/:slug/members",status="200"} 3');
  });

  it('REFUSES a label the declaration does not carry', () => {
    // The failure this prevents is silent: a `{path=…}` where `{route=…}` was
    // meant mints a second series that every rule and dashboard misses, and the
    // exposition still parses.
    expect(() => metricLine('libriant_api_requests_total', 1, { path: '/x' })).toThrow(
      /has no label "path"/,
    );
  });

  it('escapes backslashes, quotes and newlines in label values', () => {
    const line = metricLine('libriant_worker_jobs_running', 1, { queue: 'a"b\\c\nd' });
    expect(line).toBe('libriant_worker_jobs_running{queue="a\\"b\\\\c\\nd"} 1');
  });

  it('requires a suffix on a histogram and refuses one anywhere else', () => {
    expect(() => metricLine('libriant_api_request_duration_seconds', 1, { route: '/x' })).toThrow(
      /_bucket, _sum or _count/,
    );
    expect(() => metricLine('libriant_worker_jobs_running', 1, {}, '_sum')).toThrow(/histogram/);
  });

  it('accepts `le` only on a bucket series', () => {
    expect(
      metricLine('libriant_api_request_duration_seconds', 7, { route: '/x', le: 0.5 }, '_bucket'),
    ).toBe('libriant_api_request_duration_seconds_bucket{route="/x",le="0.5"} 7');
    expect(() =>
      metricLine('libriant_api_request_duration_seconds', 7, { route: '/x', le: 0.5 }, '_sum'),
    ).toThrow(/has no label "le"/);
  });

  it('refuses a name nothing declares', () => {
    // Only reachable from JavaScript — TypeScript rejects it at the call site,
    // which is the first of the two lines of defence.
    expect(() => metric('libriant_nope' as never)).toThrow(/not declared/);
  });
});
