import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Per-request counters and a latency histogram, in Prometheus text format.
 *
 * WHY THIS EXISTS (reliability-17). A full scrape of the live API returned
 * exactly eight gauges — uptime, build info, tenant counts by status, summed
 * storage bytes, Postgres connections/max, Postgres cache-hit ratio and Redis
 * used_memory — and nothing else. `grep -rn 'requests_total|http_request|
 * _duration_seconds' apps/api/src` matched nothing, and every one of the ten
 * rules in infra/monitoring/alerts.yml was a liveness or host/DB-capacity rule.
 *
 * So there was no signal for "the app is up but broken". A regression that 500s
 * one route, a tenant whose every request errors, a latency cliff after a bad
 * migration — all of it was invisible, because the only availability signal was
 * `up{job="libriant-api"}`, which requires /metrics ITSELF to stop answering.
 *
 * Deliberately hand-rolled rather than prom-client: the API ships no metrics
 * dependency today, `/metrics` is already assembled as an array of strings in
 * health.controller.ts, and adding a package to the production image runs
 * against supply-chain-03 in the same audit.
 *
 * ── Cardinality ─────────────────────────────────────────────────────────────
 * The `route` label is the ROUTE PATTERN Express matched (`/t/:slug/members`),
 * never the raw URL. Every tenant-scoped path in this app carries a slug and
 * most carry an id, so labelling by URL would mint a new time series per
 * library per record and eventually take Prometheus down — the monitoring
 * equivalent of the bug being monitored. `LABEL_BUDGET` is the belt to that
 * braces: if the pattern is somehow absent (an unmatched 404, a handler that
 * bypasses the router), the series collapses into `route="other"` instead of
 * growing without limit.
 */

/** Latency bucket upper bounds, in seconds. */
const BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

/**
 * Hard ceiling on distinct `route` label values. The API has well under a
 * hundred route patterns; anything past this is a bug (or an attack) and is
 * folded into `other` rather than allowed to grow the series count.
 */
const LABEL_BUDGET = 200;

const OTHER = 'other';

type RouteStats = {
  /** counts keyed by `${method} ${status}` */
  counts: Map<string, number>;
  /** cumulative bucket counts, parallel to BUCKETS, plus +Inf at the end */
  buckets: number[];
  sum: number;
  count: number;
};

/** Prometheus label values must escape `\`, `"` and newlines. */
function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Process-wide registry. A module-level singleton on purpose: the middleware is
 * instantiated by Nest and the renderer lives in HealthController, and the two
 * must see the same counters. Bounded by LABEL_BUDGET, so it cannot grow into
 * the leak it is meant to detect.
 */
class HttpMetricsRegistry {
  private readonly routes = new Map<string, RouteStats>();

  private statsFor(route: string): RouteStats {
    let s = this.routes.get(route);
    if (s) return s;
    if (this.routes.size >= LABEL_BUDGET) {
      // Budget spent: everything else lands in one shared bucket. Losing the
      // per-route breakdown is survivable; an unbounded label set is not.
      s = this.routes.get(OTHER);
      if (s) return s;
      route = OTHER;
    }
    s = { counts: new Map(), buckets: new Array(BUCKETS.length + 1).fill(0), sum: 0, count: 0 };
    this.routes.set(route, s);
    return s;
  }

  observe(route: string, method: string, status: number, seconds: number): void {
    const s = this.statsFor(route);
    const key = `${method} ${status}`;
    s.counts.set(key, (s.counts.get(key) ?? 0) + 1);
    s.sum += seconds;
    s.count += 1;
    // Cumulative histogram: a sample lands in its own bucket and every wider
    // one, which is the format `histogram_quantile()` expects.
    BUCKETS.forEach((upper, i) => {
      if (seconds <= upper) s.buckets[i] = (s.buckets[i] ?? 0) + 1;
    });
    s.buckets[BUCKETS.length] = (s.buckets[BUCKETS.length] ?? 0) + 1; // +Inf
  }

  /** Prometheus text exposition lines. Empty until the first request. */
  render(): string[] {
    if (this.routes.size === 0) return [];
    const lines: string[] = [
      '# HELP libriant_api_requests_total HTTP requests handled, by method, route pattern and status.',
      '# TYPE libriant_api_requests_total counter',
    ];
    for (const [route, s] of this.routes) {
      for (const [key, n] of s.counts) {
        const sep = key.indexOf(' ');
        const method = key.slice(0, sep);
        const status = key.slice(sep + 1);
        lines.push(
          `libriant_api_requests_total{method="${esc(method)}",route="${esc(route)}",status="${esc(status)}"} ${n}`,
        );
      }
    }
    lines.push(
      '# HELP libriant_api_request_duration_seconds Request latency by route pattern.',
      '# TYPE libriant_api_request_duration_seconds histogram',
    );
    for (const [route, s] of this.routes) {
      const r = esc(route);
      BUCKETS.forEach((upper, i) => {
        lines.push(
          `libriant_api_request_duration_seconds_bucket{route="${r}",le="${upper}"} ${s.buckets[i] ?? 0}`,
        );
      });
      lines.push(
        `libriant_api_request_duration_seconds_bucket{route="${r}",le="+Inf"} ${s.buckets[BUCKETS.length] ?? 0}`,
        `libriant_api_request_duration_seconds_sum{route="${r}"} ${s.sum.toFixed(6)}`,
        `libriant_api_request_duration_seconds_count{route="${r}"} ${s.count}`,
      );
    }
    return lines;
  }

  /** Test seam. Never called in production. */
  reset(): void {
    this.routes.clear();
  }
}

export const httpMetrics = new HttpMetricsRegistry();

/**
 * Resolve the label for a finished request.
 *
 * Read at `finish` time, not at middleware entry: Express only attaches
 * `req.route` once the router has matched, which happens AFTER this middleware
 * runs. `req.baseUrl` carries the mount prefix (empty in this app, but a Nest
 * global prefix would put it here), and `req.route.path` the pattern.
 */
export function routeLabel(req: Request): string {
  const pattern = (req as Request & { route?: { path?: string } }).route?.path;
  if (!pattern) return OTHER;
  // A request no controller matched keeps the pattern of the last layer that
  // DID match — for us, this middleware's own `forRoutes('*')` mount, which
  // Nest 11 compiles to the Express 5 wildcard `/{*path}`. Measured on a
  // running API: an unknown path and a `/t/<unknown-slug>/members` rejected by
  // TenantMiddleware both arrived here labelled `route="/{*path}"`.
  //
  // Fold every wildcard form into `other`. Two reasons, and the second is not
  // theoretical: it is not a route anyone can act on, and a label VALUE
  // containing `{` and `}` breaks naive parsing of the exposition — it broke
  // this file's own test helper first. No controller in this app registers a
  // wildcard path (`grep -rnE "@(Get|Post|…)\('[^']*\*"` → nothing), so
  // nothing real is merged away by this.
  if (pattern.includes('*')) return OTHER;
  const base = req.baseUrl ?? '';
  const full = `${base}${pattern}`;
  return full === '' ? '/' : full;
}

/**
 * Global middleware. Mounted in PlatformModule — see the note there.
 *
 * `res.on('finish')` rather than an interceptor is deliberate, and it is the
 * difference between measuring the app and measuring the happy path:
 *   - it fires for requests no controller matched (404s) and for responses the
 *     global exception filter re-skinned, so a 5xx storm is counted whatever
 *     produced it;
 *   - `res.statusCode` at that point is the status actually sent, not the one
 *     the handler intended;
 *   - the timer covers serialization, which is where a latency cliff on a big
 *     catalogue export actually lives.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const startedNs = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - startedNs) / 1e9;
      httpMetrics.observe(routeLabel(req), req.method, res.statusCode, seconds);
    });
    next();
  }
}
