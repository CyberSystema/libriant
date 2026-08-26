# Libriant API — multi-stage build.
#
# Runtime model: pnpm workspaces export their TypeScript source directly
# (`main: ./src/index.ts`), so the API can't run under plain `node` without
# pre-compiling every workspace package. Easiest + faster-than-it-looks
# alternative: run under `tsx` in production too. esbuild-on-import caches
# after the first hit, so the startup penalty is sub-second on a warm
# container and zero on hot requests. We trade ~30 MB of image size for a
# build pipeline that mirrors `pnpm dev` exactly.
#
# Build stages:
#   base       — node 24 + pnpm + openssl (needed for Prisma's engine)
#   deps       — locked dep install
#   build      — workspace source + Prisma client generation
#   runtime    — minimal image with source + node_modules + non-root user
#
# Cache hits: changes to source under apps/api/src only invalidate `build`;
# everything below that re-fetches in seconds.

# supply-chain-05: tag AND digest. `node:26-alpine` moves whenever upstream
# republishes, so two builds of the same commit could produce images with
# different Node/OpenSSL/musl binaries and nothing in the repo would record it.
# The tag stays for readability; the digest is what resolves. Re-resolve
# deliberately when bumping (`docker buildx imagetools inspect node:26-alpine`)
# and update apps/web/Dockerfile + infra/caddy/Dockerfile in the same commit.
FROM node:26-alpine@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019 AS base
# postgresql-client provides pg_dump for the SQL-format database export.
RUN apk add --no-cache openssl tini postgresql-client
# Pin corepack's cache to a SHARED, world-readable location instead of the
# per-user default (~/.cache/node/corepack). The migrate one-shot runs `pnpm`
# via corepack as the non-root `node` user (INFRA-4); without a warm cache it
# would try to re-download pnpm into node's HOME and fail. Preparing here lands
# pnpm under COREPACK_HOME where every user can read it.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable \
 && corepack prepare pnpm@11.22.0 --activate \
 && chmod -R a+rX "$COREPACK_HOME"
WORKDIR /app

# ----- deps ----------------------------------------------------------------
FROM base AS deps

# Copy workspace manifests first so the install layer is cached when only
# source changes. Done verbosely (one COPY per workspace) so cache-bust
# behaviour is predictable.
#
# supply-chain-03: copy ONLY the workspace manifests this image's runtime
# actually needs. pnpm installs for the projects it can discover on disk, so a
# manifest copied here is a whole dependency tree installed into the production
# API image.
#
# `apps/web/package.json` used to be in this list, and nothing in the API image
# imports the web app — the build stage below does not even copy apps/web. It
# dragged the entire Next.js 16 tree (next 198 MB + @next/swc 84.8 MB, plus
# sharp/libvips and lightningcss native binaries) into a container that holds
# CONTROL_DATABASE_URL and every tenant credential, and made every future
# Next.js advisory a production advisory for the API. Same for
# packages/i18n and packages/ui: neither is a dependency of @libriant/api or of
# anything it imports (checked against every package.json in the workspace), and
# neither has its source copied into the build stage, so they were unreachable
# code with an install cost.
#
# Omitting a workspace member is safe with `--frozen-lockfile`: pnpm only
# validates the projects it finds. `apps/desktop` is a workspace member and has
# never been copied into ANY of the three Dockerfiles, which is the standing
# proof that this works in this repo.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/db-control/package.json packages/db-control/package.json
COPY packages/db-tenant/package.json packages/db-tenant/package.json
COPY packages/shared/package.json packages/shared/package.json
# The API renders the marketing site's home page when the application form
# fails validation, so @libriant/site is a real runtime dependency.
COPY apps/site/package.json apps/site/package.json

# Prisma schema is referenced by `prisma generate` which runs in `build`;
# the schema file itself doesn't affect dep install.
RUN pnpm install --frozen-lockfile

# ----- build ---------------------------------------------------------------
FROM deps AS build

# Copy everything the API and its workspace deps need at runtime. Web is
# excluded; the web image is a separate target.
COPY tsconfig.base.json ./
COPY apps/api apps/api
# apps/site supplies the renderer; locales/ supplies the landing copy it reads.
# apps/site/src/plans.ts reaches across the workspace with a relative import to
# packages/db-control/prisma/seed-data.js — already copied below, do not prune.
COPY apps/site apps/site
COPY locales locales
COPY packages/db-control packages/db-control
COPY packages/db-tenant packages/db-tenant
COPY packages/shared packages/shared

# Generate Prisma clients. Both control + tenant schemas produce a client
# under node_modules/.prisma — these stay in the image and are what the
# API imports at runtime.
RUN pnpm --filter @libriant/db-control prisma:generate \
 && pnpm --filter @libriant/db-tenant prisma:generate

# ----- runtime -------------------------------------------------------------
FROM base AS runtime

# tini = PID 1 with proper signal forwarding. Without it, SIGTERM never
# reaches the Nest app and Compose has to SIGKILL on shutdown.
ENV NODE_ENV=production \
    PORT=3001 \
    NODE_OPTIONS="--enable-source-maps" \
    # tsx 4+ doesn't always resolve `extends`-chained tsconfigs at the
    # nearest-on-disk level. Pinning the path makes it pick up
    # apps/api/tsconfig.json (which has experimentalDecorators on, needed
    # for NestJS DI), regardless of CWD.
    TSX_TSCONFIG_PATH=/app/apps/api/tsconfig.json

COPY --from=build /app /app

# Run as a non-root user. The standard `node` user (uid 1000) ships with
# the official image and owns no files yet, so chown the work dir to it.
RUN chown -R node:node /app
USER node

EXPOSE 3001

# tsx lives under node_modules/.bin after the install above. Calling it
# directly (instead of via `pnpm`) avoids spawning an extra process tree
# under PID 1.
ENTRYPOINT ["tini", "--"]
CMD ["./apps/api/node_modules/.bin/tsx", "apps/api/src/main.ts"]
