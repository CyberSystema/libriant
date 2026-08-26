# Libriant web (Next.js 16 app router).
#
# Next.js handles its own compilation, so this is closer to a stock
# multi-stage Node build: install deps → next build → ship a minimal
# runtime layer with .next/, public/, and prod deps.

# supply-chain-05: pinned by digest — see apps/api/Dockerfile for the why and
# for how to re-resolve. All three Dockerfiles must move together.
FROM node:26-alpine@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019 AS base
RUN apk add --no-cache tini
# COREPACK_HOME is pinned to a shared, world-readable path for the same reason
# as apps/api/Dockerfile: this image's CMD is `pnpm … start` running as the
# non-root `node` user, so a cache under root's HOME means corepack tries to
# re-download pnpm from the network on EVERY container start — on the boot path,
# in production, with no fallback if npmjs.org is unreachable.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable \
 && corepack prepare pnpm@11.22.0 --activate \
 && chmod -R a+rX "$COREPACK_HOME"
WORKDIR /app

# ----- deps ----------------------------------------------------------------
FROM base AS deps

# supply-chain-03, the web half of the same defect. @libriant/web depends on
# exactly @libriant/i18n, @libriant/shared, @libriant/ui, marked, next, react
# and react-dom — `grep -rn 'db-control|db-tenant|@libriant/api'` over apps/web
# returns nothing. Copying the api/db-control/db-tenant manifests here installed
# the whole server tree into the browser-facing image: @prisma/client (74.9 MB),
# the Prisma CLI (41.9 MB), @prisma/studio-core (42.2 MB — a database-browsing
# web UI), @electric-sql/pglite (23.2 MB — an embedded WASM Postgres), mysql2,
# NestJS, Stripe. None of it is imported; all of it was a CVE and a foothold
# toolkit on the tier that faces the internet.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/i18n/package.json packages/i18n/package.json
COPY packages/ui/package.json packages/ui/package.json

RUN pnpm install --frozen-lockfile

# ----- build ---------------------------------------------------------------
FROM deps AS build

COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages/i18n packages/i18n
COPY packages/shared packages/shared
COPY packages/ui packages/ui

# Static prerender at `next build` time reads assets/manifest.json +
# theme tokens + the per-locale message catalogs. They land on disk
# inside the image so the build is hermetic; the *runtime* stage gets
# them again via the bind-mount in compose so designers can hot-swap.
COPY assets assets
COPY locales locales

# `next build` produces .next/, which is what the runtime stage actually
# serves. Telemetry off so build logs stay clean and there's no outbound
# request from a hardened host.
#
# NODE_ENV must be `production` here, not just in the runtime stage:
# Next.js inlines `process.env.NODE_ENV` into the server bundle at build
# time. Without this, route handlers see the build-time fallback at
# runtime, not the env var the runtime stage sets.
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
RUN pnpm --filter @libriant/web build

# ----- runtime -------------------------------------------------------------
FROM base AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS="--enable-source-maps"

COPY --from=build /app /app

RUN chown -R node:node /app
USER node

EXPOSE 3000
ENTRYPOINT ["tini", "--"]
CMD ["pnpm", "--filter", "@libriant/web", "start"]
