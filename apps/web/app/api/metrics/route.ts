import { NextResponse } from 'next/server';

/**
 * Prometheus exposition for the web tier. Today: uptime + a build-info
 * gauge. A scraper can already start collecting; richer metrics (request
 * counters, error rates) land later via Next.js instrumentation hooks.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bootedAt = Date.now();

export function GET() {
  const upSec = Math.round((Date.now() - bootedAt) / 1000);
  const body = [
    '# HELP libriant_web_uptime_seconds Process uptime in seconds.',
    '# TYPE libriant_web_uptime_seconds counter',
    `libriant_web_uptime_seconds ${upSec}`,
    '# HELP libriant_web_build_info Build information.',
    '# TYPE libriant_web_build_info gauge',
    `libriant_web_build_info{node_env="${process.env.NODE_ENV ?? 'development'}"} 1`,
    '',
  ].join('\n');
  return new NextResponse(body, {
    headers: { 'Content-Type': 'text/plain; version=0.0.4' },
  });
}
