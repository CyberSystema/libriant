import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'The subject is the /metrics exposition and the middleware that feeds it. No plan gate is ' +
    'involved, so the launch configuration is the honest posture.',
);

/**
 * reliability-17, and specifically the half a unit test structurally cannot
 * cover.
 *
 * A spec that calls `httpMetrics.observe()` directly and then reads
 * `httpMetrics.render()` proves the registry's arithmetic and NOTHING about
 * whether the running API feeds it. Delete the `consumer.apply(...)` line from
 * platform.module.ts, or the `...httpMetrics.render()` spread from
 * health.controller.ts, and every such test keeps passing while production goes
 * straight back to a /metrics that carries eight gauges, no error rate, and no
 * latency — which is exactly the state the audit found, and exactly the state
 * where a 5xx storm is unalertable.
 *
 * So this drives the real entry point: a booted Nest app, real HTTP requests
 * through the real middleware chain, and a real scrape of the real /metrics
 * route. It needs no Postgres data — the capacity block is allowed to fail and
 * omit itself; the request metrics are process-local and must be there anyway.
 *
 * Pre-reqs: the integration environment (control DB + Redis reachable).
 */
let app: NestExpressApplication;

/**
 * A path segment that appears nowhere else. Stands in for the tenant slugs and
 * record ids every real URL in this app carries: if it turns up in the scrape,
 * the `route` label is the raw URL and Prometheus gains a fresh time series per
 * library per record — the monitoring outage that replaces the monitoring gap.
 */
const CANARY = `cardinality-canary-${randomBytes(4).toString('hex')}`;

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error'],
  });
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  await listenOnce(app);
});

afterAll(async () => {
  await app?.close();
});

/**
 * Total requests recorded with the given status, across every route label.
 *
 * Deliberately NOT `\{[^}]*status="…"\}`. That is what this helper said first,
 * and it silently returned 0 for every sample, because unmatched requests were
 * being labelled `route="/{*path}"` — a brace inside a label value, which the
 * character class could not cross. The test failed for the right reason and the
 * fix belonged in the exposition (see routeLabel), but a parser that cannot
 * survive a brace has no business asserting anything about the format.
 */
function countStatus(body: string, status: string): number {
  const re = new RegExp(`^libriant_api_requests_total\\{.*status="${status}"\\} (\\d+)$`, 'gm');
  return [...body.matchAll(re)].reduce((n, m) => n + Number(m[1]), 0);
}

async function scrape(): Promise<string> {
  // No X-Real-IP / X-Forwarded-* — /metrics 404s a request that arrived via the
  // public edge (A14-03), and supertest adds none of them.
  const res = await request(app.getHttpServer()).get('/metrics').expect(200);
  return res.text;
}

describe('GET /metrics — request, error and latency series (reliability-17)', () => {
  it('counts a matched route by its PATTERN, with method and status', async () => {
    await request(app.getHttpServer()).get('/healthz').expect(200);

    const body = await scrape();

    expect(body).toContain('# TYPE libriant_api_requests_total counter');
    expect(body).toMatch(
      /libriant_api_requests_total\{method="GET",route="\/healthz",status="200"\} [1-9]\d*/,
    );
  });

  it('exports a latency histogram Prometheus can take a quantile from', async () => {
    await request(app.getHttpServer()).get('/healthz').expect(200);

    const body = await scrape();

    expect(body).toContain('# TYPE libriant_api_request_duration_seconds histogram');
    // The three pieces `histogram_quantile()` and the alert rules need.
    expect(body).toContain(
      'libriant_api_request_duration_seconds_bucket{route="/healthz",le="+Inf"}',
    );
    expect(body).toContain('libriant_api_request_duration_seconds_sum{route="/healthz"}');
    expect(body).toMatch(
      /libriant_api_request_duration_seconds_count\{route="\/healthz"\} [1-9]\d*/,
    );
    // Buckets must be cumulative and monotonic, or the quantile is nonsense.
    const buckets = [
      ...body.matchAll(
        /libriant_api_request_duration_seconds_bucket\{route="\/healthz",le="([^"]+)"\} (\d+)/g,
      ),
    ].map((m) => Number(m[2]));
    expect(buckets.length).toBeGreaterThan(1);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i]!).toBeGreaterThanOrEqual(buckets[i - 1]!);
    }
  });

  it('records a non-2xx status rather than only counting happy requests', async () => {
    // An unmatched path: no controller, so the response comes from outside the
    // Nest handler chain entirely. `res.on('finish')` is what makes it countable
    // at all — an interceptor would never see it.
    await request(app.getHttpServer()).get(`/${CANARY}`).expect(404);

    const body = await scrape();

    expect(body).toMatch(/libriant_api_requests_total\{method="GET",route="[^"]*",status="404"\}/);
  });

  it('counts a request the middleware chain REJECTED before any controller ran', async () => {
    // The finding's own example: "a tenant whose every request errors."
    // `/t/<unknown-slug>/…` is 404'd by TenantMiddleware, so nothing downstream
    // — no guard, no controller, no interceptor — ever sees it. Mounted anywhere
    // after TenantMiddleware this produced NO series at all; measured against a
    // running API before the mount point moved to the head of AppModule's chain.
    const before = countStatus(await scrape(), '404');

    await request(app.getHttpServer()).get(`/t/${CANARY}/members`).expect(404);

    expect(countStatus(await scrape(), '404')).toBeGreaterThan(before);
  });

  it('never puts a raw URL segment in a label', async () => {
    await request(app.getHttpServer()).get(`/t/${CANARY}/members`);
    await request(app.getHttpServer()).get(`/${CANARY}`);

    const body = await scrape();

    // The canary went through twice, in two shapes. Neither may appear.
    expect(body).not.toContain(CANARY);
  });
});
