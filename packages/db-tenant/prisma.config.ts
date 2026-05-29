import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 moved the Migrate/introspection connection URL out of
 * `schema.prisma` and into this config file. Per-tenant runtime clients
 * supply their own connection via a driver adapter (see
 * `makeTenantPrismaClient` in `src/client.ts`); this `datasource.url` is
 * only read by CLI commands run against a single tenant DB (e.g.
 * `TENANT_DATABASE_URL=… prisma migrate deploy`).
 *
 * `?? ''` keeps `prisma generate` working without the env var (generate
 * doesn't touch the database).
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.TENANT_DATABASE_URL ?? '',
  },
});
