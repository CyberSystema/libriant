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
 && pnpm --version \
 # npm writes the tarball it fetched into /root/.npm/_cacache before unpacking
 # it, so this layer would otherwise hold pnpm twice — once installed, once as a
 # cached archive. Chained into the SAME RUN on purpose: a later `rm` writes a
 # whiteout over bytes the image already carries and saves nothing. Nothing
 # after this line runs npm (pnpm is the package manager everywhere else), so
 # the cache can never be a hit.
 && rm -rf /root/.npm
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

# supply-chain-07: THIS IMAGE RUNS AS uid 1000, gid 0. It ran as uid 0 until
# now, inheriting the upstream default, under a comment that explained why the
# `USER` line could not be added — that reasoning was wrong about the mechanism
# and is replaced below and, in full, on the `caddy` service in
# infra/compose/docker-compose.prod.yml. Read that one before touching either:
# it records how this process reaches ports 80 and 443 with NO capability at
# all, and why the group is 0 rather than 1000.
#
# The compose service sets `user: '1000:0'` as well, and that is the one that
# governs in production. This line is not redundant with it. The deploy
# validates the Caddyfile in a throwaway container built from this image
# (scripts/deploy-on-host.sh, stage `caddy-validate`), docs/RUNBOOK.md runs
# `caddy adapt` the same way, and neither should be the place where the edge
# image is quietly root again. The two must agree; changing one alone is a bug,
# not a simplification.
#
# THE THREE DIRECTORIES ARE THE OTHER HALF OF THE UID CHANGE, and skipping them
# is a start-up crash rather than a warning. Caddy writes all three: /data is
# its storage and it creates /data/caddy on startup, /config is XDG_CONFIG_HOME,
# and /var/log/caddy holds the access log the Caddyfile configures — a log it
# cannot open is a Caddy that exits. Docker populates a FRESH named volume by
# copying the image path's contents AND its ownership, so leaving these
# root-owned 0755 would hand uid 1000 an unwritable caddy_config and caddy_logs
# on a clean install. `chgrp 0` + `g+rwX` makes that first boot work with
# nobody chowning anything.
#
# It fixes NOTHING on a box that already has those volumes — Docker copies into
# an empty volume only, and caddy_data is a bind to the host under the volume
# overlay. Converting an existing box is an operator procedure with an order
# that matters: docs/RUNBOOK.md §3.7c.
#
# UNVERIFIED, and cheap to settle if a fresh install ever comes up unwritable:
# if the BASE image declared `VOLUME /data /config`, Docker would discard this
# RUN layer's changes to those two paths at build time and they would reach a new
# volume root-owned after all. /var/log/caddy — the one whose failure is fatal —
# is created here, so it cannot be a base VOLUME either way. One command answers
# it, and there is no Docker on the machine this was written on:
#   docker image inspect --format '{{json .Config.Volumes}}' caddy:2-alpine
# The recovery if it does bite is one `chown` per volume: docs/RUNBOOK.md §3.8.
#
# XDG_* are set here rather than inherited from the base image. The upstream
# image sets them to exactly these two values, so this changes nothing today —
# it removes a dependency. uid 1000 has no /etc/passwd entry and therefore no
# HOME, and if a future base image dropped those variables Caddy would fall
# through to os.UserHomeDir() and put its storage somewhere no volume is
# mounted, which loses state silently instead of failing.
ENV XDG_CONFIG_HOME=/config \
    XDG_DATA_HOME=/data
RUN mkdir -p /data/caddy /config/caddy /var/log/caddy \
 && chgrp -R 0 /data /config /var/log/caddy \
 && chmod -R g+rwX /data /config /var/log/caddy

# Left root-owned and world-readable (COPY's default), which is what a uid-1000
# process needs to serve it: read-only content, owned by a uid the container
# cannot become.
COPY --from=site /app/apps/site/dist /srv/libriant/site

USER 1000:0
