import { NextResponse } from 'next/server';

/**
 * Web liveness probe. Doesn't touch the API or any other dependency —
 * the orchestrator only needs to know Next.js itself is alive. Readiness
 * (`/api/readyz`) is the one that fans out.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bootedAt = new Date().toISOString();

export function GET() {
  return NextResponse.json({ status: 'ok', bootedAt });
}
