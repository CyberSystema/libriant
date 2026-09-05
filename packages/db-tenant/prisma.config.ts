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
 *
 * SCHEMA IS A FOLDER, not a file. The tenant schema was one 701-line
 * `schema.prisma`; it is on its way to several thousand lines across a dozen
 * modules, and a single file that large is unreviewable in a diff. The parts
 * live in `prisma/schema/` and Prisma concatenates them.
 *
 * The numeric prefixes on those files are load-bearing. Prisma reads the
 * folder in lexical order, and declaration order decides the order of models
 * and field enums in the GENERATED CLIENT. Without the prefixes the split
 * reordered the client (audit before catalogue, and so on) — harmless, but it
 * makes the "did this refactor change anything?" question unanswerable by
 * diff. With them, splitting the file changed the generated client by exactly
 * three characters: `../` to `../../` in the inlined copy of the generator
 * block, because a relative `output` path now resolves against the folder.
 * Every type declaration is byte-identical.
 *
 * `shadowDatabaseUrl` is spread in CONDITIONALLY, never defaulted to `''`.
 * Prisma validates it as a connection string whenever the key is present, so
 * `?? ''` made `prisma migrate deploy` — the command every tenant migration
 * runs — fail with P1013 "must not be an empty string" on any machine that had
 * not set the variable. It is only needed by `prisma migrate diff
 * --from-migrations`, which `pnpm check:schema-drift` runs against a throwaway
 * database, and is unset in all normal operation.
 */
export default defineConfig({
  schema: 'prisma/schema',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.TENANT_DATABASE_URL ?? '',
    ...(process.env.SHADOW_DATABASE_URL
      ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL }
      : {}),
  },
});
