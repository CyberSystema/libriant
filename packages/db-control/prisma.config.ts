import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 moved the Migrate/introspection connection URL out of
 * `schema.prisma` and into this config file. The runtime client supplies
 * its own connection via a driver adapter (see `src/client.ts`); this
 * `datasource.url` is only read by CLI commands (`migrate`, `db`, `studio`).
 *
 * `?? ''` keeps `prisma generate` working when the env var isn't set
 * (generate doesn't touch the database); migrate commands always run with
 * `CONTROL_DATABASE_URL` exported.

 * `shadowDatabaseUrl` is spread in CONDITIONALLY, never defaulted to `''`.
 * Prisma validates it as a connection string whenever the key is present, so
 * `?? ''` made `prisma migrate deploy` — the command every tenant migration
 * runs — fail with P1013 "must not be an empty string" on any machine that had
 * not set the variable. It is only needed by `prisma migrate diff
 * --from-migrations`, which `pnpm check:schema-drift` runs against a throwaway
 * database, and is unset in all normal operation.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.CONTROL_DATABASE_URL ?? '',
    ...(process.env.SHADOW_DATABASE_URL
      ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL }
      : {}),
  },
});
