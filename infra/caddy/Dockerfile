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

# supply-chain-05: pinned by digest — see apps/api/Dockerfile for the why and
# for how to re-resolve. All three Dockerfiles must move together.
FROM node:26-alpine@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019 AS site
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

# supply-chain-05: the edge binary itself, pinned by digest. This one terminates
# TLS for every request, so "whatever the tag pointed at that minute" is the
# least acceptable place for a floating reference.
FROM caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648

# supply-chain-07: THERE IS NO `USER` HERE AND THAT IS ON PURPOSE — this image
# runs as uid 0, inheriting the upstream default. The audit found the absence
# with `grep -n USER infra/caddy/Dockerfile` returning nothing and read it as an
# oversight, which is fair: an unexplained absence is indistinguishable from one.
#
# The containment lives in infra/compose/docker-compose.prod.yml, on the `caddy`
# service: `cap_drop: [ALL]` + `cap_add: [NET_BIND_SERVICE]` +
# `no-new-privileges`, which leaves this uid 0 with exactly one capability. The
# long note there records why the uid itself was not changed — briefly, adding
# `USER` needs CAP_NET_BIND_SERVICE to survive the setuid, which depends on
# whether the upstream image runs `setcap` on /usr/bin/caddy, and Docker is not
# installed on the machine this was written on, so the image could not be pulled
# and checked. `getcap /usr/bin/caddy` on the real image answers it.
COPY --from=site /app/apps/site/dist /srv/libriant/site
