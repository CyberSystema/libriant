# Libriant web (Next.js 16 app router).
#
# Next.js handles its own compilation, so this is closer to a stock
# multi-stage Node build: install deps → next build → ship a minimal
# runtime layer with .next/, public/, and prod deps.

# supply-chain-05: pinned by digest — see apps/api/Dockerfile for the why and
# for how to re-resolve. All three Dockerfiles must move together.
FROM node:26-alpine@sha256:ef24c5053d50fdc3e4e56eb4e7ddb7861874ab0fdc797046ba897581deb8e868 AS base
RUN apk add --no-cache tini
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
 && pnpm --version \
 # npm writes the tarball it fetched into /root/.npm/_cacache before unpacking
 # it, so this layer would otherwise hold pnpm twice — once installed, once as a
 # cached archive. Chained into the SAME RUN on purpose: a later `rm` writes a
 # whiteout over bytes the image already carries and saves nothing. Nothing
 # after this line runs npm (pnpm is the package manager everywhere else), so
 # the cache can never be a hit.
 && rm -rf /root/.npm
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
# The build also leaves a compiler cache behind, and the runtime stage copies
# /app wholesale, so it shipped. `next build` runs under Turbopack (Next 16's
# default) and writes apps/web/.next/cache/turbopack: a persistent module cache
# in .sst files, versioned by Next release. Nothing reads it once the build
# returns — turbo.json already says so, listing `!.next/cache/**` as not a build
# output — and after node_modules it is the largest thing in this image.
#
# The size is inferred rather than measured, because Docker is not available on
# the machine this was written on. On the CI build it was written against, the
# web `COPY --from=build` layer compressed to 144.08 MB while the API's
# compressed to 127.45 MB, and the API carries 150 MiB MORE node_modules (449
# MiB reachable against this image's 299). node_modules, .next/server (19 MB)
# and .next/static (1.4 MB) do not account for the gap. .sst files are already
# compacted and barely compress — 1.31:1 measured on a 3.4 MB sample from this
# repo, against ~3.8:1 for the API's JavaScript — which puts roughly 73 MB of
# cache in the image. A tree that has built many times accumulates far more;
# this working copy holds 193 MB.
#
# Only `turbopack/` goes, not all of `.next/cache`. The two dotfiles beside it
# are keys, not compiler output: `.rscinfo` holds the Server Actions encryption
# key (next/dist/server/app-render/encryption-utils-server.js — load or
# generate, 14-day rotation) and `.previewinfo` the draft-mode keys. They are
# ~400 bytes together, so removing them buys nothing and costs a real failure
# mode: each container mints its own key at boot, and two web containers cannot
# then decrypt each other's Server Action payloads. Nothing in CI boots the web
# image, so that would surface in production or not at all.
RUN pnpm --filter @libriant/web build \
 && rm -rf apps/web/.next/cache/turbopack

# ----- prune ---------------------------------------------------------------
# supply-chain-03, the web half. Trimming the manifest COPY list above stopped
# the SERVER tree being installed here, but `pnpm install --frozen-lockfile`
# still has no notion of "production", so the root manifest's devDependencies —
# eslint, turbo, prettier, typescript-eslint, typescript — plus apps/web's own
# @types/* still land in the image, and the runtime stage copies /app wholesale.
#
# Safe to prune AFTER `next build`: everything `next start` needs is either
# compiled into .next/ or a real `dependency` of @libriant/web (next, react,
# react-dom, marked). Verified, not assumed — a NODE_ENV=production `next start`
# against this repo's build was traced serving /el, /el/legal/terms, /el/login
# and /el/signup, and none of the packages this deletes was resolved. The
# --require-bin assertion fails the build if `next` itself goes missing, because
# an image that builds clean and cannot start is the worse outcome.
#
# Measured on this repo's store: 126 package directories / 398 MiB → 25 / 293
# MiB.
COPY scripts/docker-prune-dev-modules.mjs scripts/docker-prune-dev-modules.mjs
RUN node scripts/docker-prune-dev-modules.mjs \
      --root . \
      --root apps/web \
      --root packages/shared \
      --root packages/i18n \
      --root packages/ui \
      --require-bin apps/web/node_modules/.bin/next

# ----- runtime -------------------------------------------------------------
FROM base AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS="--enable-source-maps"

# COPY --chown, not COPY followed by `chown -R`. The `node` user (uid 1000)
# ships with the official image owning no files, so /app has to change hands —
# but a recursive chown in its own RUN touches every file, and overlayfs copies
# a file up into the new layer whenever anything about it changes, ownership
# included. The image therefore carried /app twice. The CI build this was
# written against shows it plainly: a 144.08 MB COPY layer followed by a
# 144.50 MB chown layer, with nothing else in this stage that could produce
# 144 MB. Setting ownership as COPY writes the files costs one layer, not two.
COPY --from=build --chown=node:node /app /app

# `--chown` above covers everything COPY writes; /app itself predates it, since
# `WORKDIR /app` in `base` created it root-owned. The `chown -R` this replaces
# did change that directory, so change it here too rather than quietly narrowing
# what the `node` user may write. One directory inode, not another copy of /app.
RUN chown node:node /app
USER node

EXPOSE 3000
ENTRYPOINT ["tini", "--"]
CMD ["pnpm", "--filter", "@libriant/web", "start"]
