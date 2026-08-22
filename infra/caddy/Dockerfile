# Libriant edge — stock Caddy with the marketing site baked in.
#
# Why bake rather than bind-mount, which is how `assets/` reaches Caddy today:
# `apps/site/dist` is gitignored, so the host's `git reset --hard` produces no
# built files, and the host has no Node or pnpm to render them (the runbook
# installs git, curl, ufw, fail2ban, unattended-upgrades and Docker — nothing
# else). Rendering here also makes the site's content version part of IMAGE_TAG,
# so a rollback rolls the marketing copy back with the code, and a broken build
# fails at `docker compose pull` before anything running is touched.
#
# The cost: Caddy base-image CVE patches now arrive on a rebuild rather than on
# the next `pull`. Every push to main rebuilds this.

FROM node:24-alpine AS site
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/site/package.json apps/site/package.json
COPY packages/db-control/package.json packages/db-control/package.json
COPY packages/db-tenant/package.json packages/db-tenant/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/i18n/package.json packages/i18n/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps/site apps/site
COPY packages/shared packages/shared
# apps/site/src/plans.ts reaches across the workspace with a relative import to
# packages/db-control/prisma/seed-data.js, so the pricing table is generated
# from the plans the product actually enforces. Do not prune this — and note it
# needs only the schema directory, not a generated Prisma client: seed-data.ts
# imports from @libriant/shared and nothing else.
COPY packages/db-control/prisma packages/db-control/prisma
# build.ts reads locales/<lang>/landing.json and copies assets/icons.
COPY locales locales
COPY assets/icons assets/icons

# Strict, not --draft: refuses to emit while site.config.json still holds a
# [PLACEHOLDER], and fails on any copy-lint violation.
RUN pnpm --filter @libriant/site build

FROM caddy:2-alpine
COPY --from=site /app/apps/site/dist /srv/libriant/site
