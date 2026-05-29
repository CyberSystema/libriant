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
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.CONTROL_DATABASE_URL ?? '',
  },
});
