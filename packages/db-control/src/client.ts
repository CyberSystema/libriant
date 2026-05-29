import { PrismaPg } from '@prisma/adapter-pg';
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
 */

declare global {
  var __libriantControlPrisma: PrismaClient | undefined;
}

function makeClient() {
  const connectionString = process.env.CONTROL_DATABASE_URL;
  if (!connectionString) {
    throw new Error('CONTROL_DATABASE_URL is not set');
  }
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['warn', 'error'],
    errorFormat: 'minimal',
  });
}

export const controlDb: PrismaClient = globalThis.__libriantControlPrisma ?? makeClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__libriantControlPrisma = controlDb;
}

/**
 * Gracefully disconnect on process shutdown. Wire from main.ts and seed scripts.
 */
export async function disconnectControlDb(): Promise<void> {
  await controlDb.$disconnect();
}
