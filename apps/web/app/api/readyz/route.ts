import { NextResponse } from 'next/server';

/**
 * Web readiness probe. The web tier is "ready" once it can reach the API.
 * Without that, every page renders a 5xx, so refusing traffic at the edge
 * is the right call. The API's own readiness probe walks deeper (DB +
 * Redis); we just need the round-trip here.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const apiBase =
    process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  const start = Date.now();
  try {
    const res = await fetch(`${apiBase.replace(/\/$/, '')}/readyz`, { cache: 'no-store' });
    const ok = res.ok;
    const elapsedMs = Date.now() - start;
    return NextResponse.json(
      {
        status: ok ? 'ready' : 'not_ready',
        api: { reachable: true, status: res.status, elapsedMs },
      },
      { status: ok ? 200 : 503 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        status: 'not_ready',
        api: { reachable: false, error: (err as Error).message },
      },
      { status: 503 },
    );
  }
}
