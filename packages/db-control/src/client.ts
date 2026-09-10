import { PrismaPg } from '@prisma/adapter-pg';
import { PG_SESSION_OPTIONS } from '@libriant/shared/postgres-session';
import { PrismaClient } from '@prisma/client';

/**
 * Control-plane Prisma client.
 *
 * The control-plane DB is small and queried from many places (every request
 * resolves a tenant against it via Redis-cached lookups; webhooks, audit
 * writes, admin UI, etc.). We share ONE client across the API process. The
 * `globalThis` guard prevents Next.js / dev hot-reload from spawning a new
 * client on every reload, which would exhaust the connection budget.
 *
 * Prisma 7 connects through a driver adapter rather than a built-in engine,
 * so the connection string (still `CONTROL_DATABASE_URL`) is handed to
 * `@prisma/adapter-pg` here instead of living in `schema.prisma`.
 *
 * Construction is LAZY (deferred to first use via the Proxy below) rather
 * than at import time. That keeps `import { controlDb }` free of any env
 * requirement, so unit tests that mock every DB call can pull in services
 * transitively without a live `CONTROL_DATABASE_URL`. `@prisma/adapter-pg`
 * opens no socket until the first query, so deferring construction changes
 * nothing at runtime, where the env var is always present.
 */

declare global {
  var __libriantControlPrisma: PrismaClient | undefined;
}

function makeClient(): PrismaClient {
  const connectionString = process.env.CONTROL_DATABASE_URL;
  if (!connectionString) {
    throw new Error('CONTROL_DATABASE_URL is not set');
  }
  // The UTC session. `packages/shared/src/postgres-session.ts` carries the
  // measurement; `packages/db-tenant/src/client.ts` carries the argument for
  // putting it on the adapter rather than on the URL.
  //
  // NOT DEAD CODE HERE, though it looks it: every instant column in the CONTROL
  // datamodel is `timestamp without time zone`, which the adapter round-trips
  // exactly whatever the session says. It is here for two reasons. Phase 20
  // makes `lbr2` the tenant `public` schema and this client's siblings start
  // sharing shapes with it; and one client in the product connecting on a
  // different frame from the other two is precisely the asymmetry that makes a
  // bug like this survive — three pools, one rule.
  const adapter = new PrismaPg({ connectionString, options: PG_SESSION_OPTIONS });
  return new PrismaClient({
    adapter,
    log: ['warn', 'error'],
    errorFormat: 'minimal',
  });
}

/**
 * Memoized singleton. `memo` holds the instance in every environment; the
 * `globalThis` slot is only the dev hot-reload guard so repeated module
 * evaluations reuse one client.
 */
let memo: PrismaClient | undefined;
function instance(): PrismaClient {
  if (memo) return memo;
  memo = globalThis.__libriantControlPrisma ?? makeClient();
  if (process.env.NODE_ENV !== 'production') {
    globalThis.__libriantControlPrisma = memo;
  }
  return memo;
}

/**
 * Proxy that forwards every property access to the lazily-built singleton.
 * Methods are bound to the real client so `this` stays correct (`$transaction`,
 * `$queryRaw`, model delegates, …). Typed as `PrismaClient` for consumers.
 */
export const controlDb: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = instance();
    const value = Reflect.get(client as object, prop);
    return typeof value === 'function' ? value.bind(client) : value;
  },
  has(_target, prop) {
    return prop in (instance() as object);
  },
});

/**
 * Gracefully disconnect on process shutdown. Wire from main.ts and seed
 * scripts. No-op if the client was never constructed, so calling it doesn't
 * force construction (and an env requirement) purely to tear nothing down.
 */
export async function disconnectControlDb(): Promise<void> {
  if (memo) {
    await memo.$disconnect();
  }
}
