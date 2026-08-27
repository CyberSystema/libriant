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
#
# launch-readiness-14: the client major is PINNED to the server major, and the
# pin is asserted rather than assumed. `postgresql-client` is a meta-package
# that resolves to whatever major the base image's Alpine release defaults to,
# so the client floated upward with every re-resolution of the node:26-alpine
# digest above while the server stayed on postgres:16-alpine
# (infra/compose/docker-compose.prod.yml:376). A newer client dumping an older
# server writes its own settings into the header: a pg_dump 18 dump opens with
# `SET transaction_timeout = 0;`, which 16 does not know. Measured against this
# project's Postgres 16.15, restoring such a file with plain `psql -f` prints
# the error and carries on (exit 0), but `psql -v ON_ERROR_STOP=1 -f` — what a
# careful technician uses — stops on that line and exits 3 having restored
# nothing. apps/site tells libraries the SQL export "restores into any
# PostgreSQL installation"; that promise gets tested on the worst day they will
# ever have, and nothing in CI restores an export.
#
# The `case` is not decoration. Alpine puts the binaries under
# /usr/libexec/postgresql16 and reaches /usr/bin/pg_dump through
# postgresql-common's version-dispatching wrapper, so the package name alone
# does not settle which major actually answers. This asserts it inside the
# image, at build time, on every build — including verify.yml's image-contents
# job, which builds this Dockerfile on every run. If postgresql16-client is ever
# dropped from Alpine, this line fails loudly at build time; move the server and
# both numbers together rather than un-pinning the client.
RUN apk add --no-cache openssl tini postgresql16-client \
 && case "$(pg_dump --version)" in \
      *' 16.'*) pg_dump --version ;; \
      *) echo "pg_dump is not major 16: $(pg_dump --version) — see launch-readiness-14" >&2; \
         exit 1 ;; \
    esac
# Install pnpm directly instead of through corepack.
#
# `corepack enable` exits 127 — command not found — in
# node:26-alpine@sha256:aadf416b. Corepack is no longer in the image, and the
# digest pin (supply-chain-05) means it will not come back on its own; the CI
# build reported it as
#   process "/bin/sh -c corepack enable && corepack prepare pnpm@11.22.0 …"
#   did not complete successfully: exit code: 127
#
# This is strictly better than what it replaces, which is worth saying because
# the comment that used to sit here was about working around corepack rather
# than about pnpm. Corepack RESOLVES the package manager at run time: it kept a
# cache, and the whole COREPACK_HOME dance existed because the non-root `node`
# user could not read root's cache and would therefore re-fetch pnpm from
# npmjs.org — on the boot path, in production, with no fallback. `npm i -g`
# lands the binary in /usr/local, owned by root and readable by everyone, and
# nothing reaches for the network after the build. The failure mode the old
# comment described cannot happen.
#
# The version is pinned and `scripts/check-pnpm-pins.mjs` asserts it matches
# package.json's `packageManager` across all three Dockerfiles.
RUN npm install -g pnpm@11.22.0 \
 && pnpm --version
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
# privacy-legal-09: the frozen, version-addressed copies of the legal documents.
# `legal_document_versions` is loaded from here before any acceptance is
# recorded, so a library's consent record can produce the exact text it agreed
# to years later. 148 KB, immutable, one directory per LEGAL_VERSION — never
# prune old versions, they are the evidence.
COPY docs/legal/accepted docs/legal/accepted

# Generate Prisma clients. Both control + tenant schemas produce a client
# under node_modules/.prisma — these stay in the image and are what the
# API imports at runtime.
RUN pnpm --filter @libriant/db-control prisma:generate \
 && pnpm --filter @libriant/db-tenant prisma:generate

# ----- prune ---------------------------------------------------------------
# supply-chain-03. The install above is the FULL tree: `--frozen-lockfile` has
# no notion of "production", so every devDependency of the root manifest, of
# apps/api and of the copied packages lands here — eslint, vitest, turbo,
# prettier, typescript-eslint, supertest and every @types/* — and the runtime
# stage below copies /app wholesale. A previous fix trimmed the manifest COPY
# list (which did remove the entire Next.js tree) and was correctly refused as
# incomplete, because the install line itself was untouched.
#
# It is done HERE rather than by `pnpm install --prod`, and that is not a style
# choice: `tsx` is a devDependency of apps/api and is this image's CMD, `prisma`
# is a devDependency of packages/db-control and is what the compose `migrate`
# one-shot runs before api and worker are allowed to start, and `marked` is a
# root devDependency that `pnpm ingest:help` imports in the same one-shot. A
# prod install deletes all three and the stack never comes up — the same class
# of silent, total, runtime-only breakage as the pnpm version pin
# (scripts/check-pnpm-pins.mjs). Promoting them to `dependencies` would edit
# pnpm-lock.yaml, which `--frozen-lockfile` then rejects.
#
# So: keep what the running processes can actually resolve, delete the rest,
# and assert the entrypoint still exists before the layer is allowed to commit.
# Measured on this repo's store: 599 package directories / 541 MiB → 447 / 449
# MiB. The keep set was checked against a live module-resolution trace of a
# NODE_ENV=production API serving a real signup, the BullMQ worker, `prisma
# migrate deploy`, and every step of scripts/prod-bootstrap.sh; the intersection
# of "loaded at runtime" with "deleted here" was empty.
#
# Not removed, and it is the bulk of what is left: the Prisma CLI and its
# @prisma/studio-core / @prisma/dev / @electric-sql/pglite / mysql2 subtree
# (~170 MiB). `prisma` is an AUTO-INSTALLED OPTIONAL PEER of @prisma/client, a
# production dependency, so it is in the prod closure and no Dockerfile change
# can drop it; and `prisma migrate deploy` was measured eagerly loading
# @prisma/studio-core and @prisma/dev, so they cannot be carved out either.
# Closing that needs a pnpm-lock.yaml change — see supply-chain-04.
COPY scripts/docker-prune-dev-modules.mjs scripts/docker-prune-dev-modules.mjs
RUN node scripts/docker-prune-dev-modules.mjs \
      --root . \
      --root apps/api \
      --root packages/db-control \
      --root packages/db-tenant \
      --root packages/shared \
      --root apps/site \
      --keep tsx \
      --keep prisma \
      --keep marked \
      --require-bin apps/api/node_modules/.bin/tsx \
      --require-bin packages/db-control/node_modules/.bin/prisma

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
