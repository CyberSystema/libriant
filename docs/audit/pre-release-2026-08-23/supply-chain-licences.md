# Third-party licence position, and the one decision an owner has to take

`scripts/check-supply-chain.mjs` points here. It is the enforcement; this is the
reasoning, and the two questions it cannot answer on its own.

Libriant is sold to Greek public libraries. Their procurement asks what
third-party code is in the product and under what terms, and until 2026-08-26
the honest answer was "nobody has looked". This file is the answer, and the
check beside it is what keeps the answer true — it runs inside
`pnpm check:pnpm-pins`, the command at `.github/workflows/verify.yml:47`, and
`verify.yml` is the reusable gate that `ci.yml` calls on every push to main and
every PR and that `deploy.yml` calls before a production deploy. So a new
dependency carrying an unruled-on licence fails the build rather than arriving
unnoticed.

## Method

The walk starts from every workspace's `dependencies` + `optionalDependencies`
(never `devDependencies` — eslint's licence is not a procurement question) and
follows pnpm's store layout to a fixed point. **477 packages** on 2026-08-26.
Distribution:

```
 359 MIT              9 BSD-3-Clause      1 LGPL-3.0-or-later   1 CC-BY-4.0
  42 Apache-2.0       3 Unlicense         1 MIT and ISC         1 BSD-2-Clause
  41 ISC              3 BlueOak-1.0.0     1 Python-2.0          1 EPL-2.0
   8 (no field)       2 MIT/X11           1 MIT-0               1 0BSD
                                          1 (MIT AND Zlib)      1 (MIT OR GPL-3.0-or-later)
```

Six of the eight with no `license` field are our own `@libriant/*` workspace
packages. **There is no AGPL, no SSPL and no GPL-only package anywhere in the
production closure**, so nothing in the runtime tree asks Libriant to publish its
source. That is the sentence procurement actually wants, and it holds.

## The one that needs an owner, not an engineer

### `buffers@0.1.1` — no licence grant of any kind

Checked all three places a grant can live: `package.json` has no `license` field,
the tarball ships no `LICENSE`/`COPYING` file, and `README.markdown` has no
licence section. Published 2012, unmaintained. Default copyright therefore
applies: Libriant has **no written permission to copy or redistribute it**, and
every deploy of the API image copies it.

It arrives four levels down from a first-order runtime dependency:

```
apps/api  ->  exceljs@4.4.0  ->  unzipper@0.10.14  ->  binary@0.3.0  ->  buffers@0.1.1
```

(The shallow trace is a trap: `app-builder-lib` pulls `unzipper@0.12.5`, which
does **not** depend on `binary`. Both copies are in the tree; only the 0.10.x one
reaches `buffers`.)

And it is not dormant. `require('exceljs')` alone loads it:

```
$ cd apps/api && node -e 'require("exceljs"); …'
unzipper@0.10.14/node_modules/unzipper/unzip.js
binary@0.3.0/node_modules/binary/index.js
buffers@0.1.1/node_modules/buffers/index.js
```

`exceljs` is imported by `apps/api/src/export/export-processors.ts` and
`apps/api/src/import/parsers/xlsx-parser.ts`, i.e. by the spreadsheet import a
librarian uses to load their catalogue and the export they use to leave. So this
is executing code, not shelfware.

**OWNER DECISION REQUIRED — pick one and write the date next to it:**

1. **Accept in writing.** Record that Libriant knowingly redistributes a 2012
   package with no grant, in a NOTICE file, with the risk stated. Practical
   exposure is very low (unmaintained, no rights-holder activity in fourteen
   years, sub-100-line utility) but it is not zero and it is not ours to waive
   silently.
2. **Replace the path.** `exceljs` is the only route. Swapping it for a
   maintained xlsx library removes `buffers`, `binary`, `unzipper@0.10.14` and
   `jszip`'s dual-licence question in one move, at the cost of re-testing the
   import and export features.
3. **Seek a grant.** Ask the author (`substack`) to publish a licence. Free, may
   never be answered.

Nothing in this repository can take that decision, and the check deliberately
does not pretend it has been taken — the `LICENCE_DECISIONS` entry for
`buffers@0.1.1` says "owner decision pending" and points back here.

## Corrections to the audit

**`seq-queue@0.0.5` is NOT a second unlicensed package.** The audit
(supply-chain-12) named two packages with "no licence at all". It read the
`package.json`, which indeed declares none — but the tarball ships a full MIT
`LICENSE` ("(The MIT License) Copyright (c) 2012 Netease, Inc. and other pomelo
contributors"). The grant exists; only the metadata is missing. The consequence
is narrower and different: every manifest-driven notice generator, `pnpm licenses
list` included, will omit it from a NOTICE file, so it has to be listed by hand.
It reaches the closure via `mysql2` via the Prisma CLI, and leaves whenever that
does.

## Recorded decisions on the rest

| Package | Licence | Decision |
|---|---|---|
| `jszip@3.10.1` (via `exceljs`) | `(MIT OR GPL-3.0-or-later)` | **Libriant elects MIT.** An election that is not written down is not an election, and the other arm is a source-disclosure obligation on a closed product. |
| `@img/sharp-libvips-*@1.3.2` (via `next` -> `sharp`) | LGPL-3.0-or-later | Server-side only. LGPL asks nothing of software that is run rather than conveyed, and this is never conveyed. **Condition to re-check:** `apps/desktop`'s `dependencies` are `electron-log` and `electron-updater` only, so libvips is not in any distributed installer today. Adding anything to that list re-opens this. |
| `elkjs@0.11.1` (via `@prisma/studio-core`) | EPL-2.0 | Weak, file-level copyleft. Unmodified and not distributed, so it asks nothing today. Present only because the Prisma CLI is in the production closure (below); leaves with it. |
| `caniuse-lite@1.0.30001809` (via `next`) | CC-BY-4.0 | Browser-support data, not code. Attribution only — a NOTICE file discharges it. |
| `pako@1.0.11` (via `jszip`) | `(MIT AND Zlib)` | Both arms permissive. Listed only because the combined string is not on the permissive allowlist as written. |
| `seq-queue@0.0.5` | MIT, undeclared | See above. Must be added to NOTICE by hand. |

Keys are `name@version` on purpose: upstream can and does relicense, so a version
bump re-opens the question. The single wildcard, `@img/sharp-libvips-*`, exists
because the production closure is platform-dependent — a macOS arm64 laptop
resolves `-darwin-arm64` and ubuntu-latest resolves `-linux-x64` — and keying one
architecture failed the gate on every other machine.

## Why the Prisma CLI is in the production closure at all (supply-chain-04)

`pnpm-lock.yaml:3-4` sets `autoInstallPeers: true`. `@prisma/client` — a real
production dependency — declares `prisma` and `typescript` as **optional** peers;
pnpm resolves them anyway and records them as `optionalDependencies` of the
client snapshot, which is why they survive even `pnpm install --prod`. Measured
by walking the closure twice, the second time refusing to traverse those two
edges:

```
production closure as resolved today            477 packages   702.9 MiB
… with @prisma/client's auto-peers cut          349 packages   467.3 MiB

128 packages leave with that one edge. The ten largest:
  42.0 MiB @prisma/studio-core   41.8 prisma        25.8 effect      23.2 typescript
  23.1 MiB @prisma/engines       22.2 @electric-sql/pglite (WASM Postgres)
  18.1 MiB @prisma/dev            7.7 elkjs          4.9 @prisma/query-plan-executor
   3.1 MiB remeda
```

(Own bytes of each package directory, `node_modules` symlinks excluded so nothing
is counted twice. macOS arm64 tree; the platform binaries differ elsewhere.)

So a database-browsing UI, a MySQL driver and an embedded WASM Postgres sit in
the API image of a multi-tenant library SaaS. Nothing starts them — this is
surface, not an open door — and it is also where `elkjs`, `seq-queue` and the
tree's one open advisory come from.

**`autoInstallPeers: false` is deliberately NOT being flipped now.** It re-resolves
all nine workspaces and surfaces genuinely missing peers, which is the correct
thing to discover in the week after a launch and not the week of one. What holds
the line meanwhile is `AUTO_PEER_EDGES` in the check: the thirteen edges that
exist today are written down, and a fourteenth — a new subtree entering the
production image because pnpm chose it rather than because anyone asked — fails
the build.

## The one advisory this repo knowingly carries (supply-chain-09)

`deepmerge-ts@7.1.5`, GHSA-ggr8-5vv4-36mx / CVE-2026-40345, CWE-674 stack
exhaustion when merging recursive object graphs. Rated high. Patched in 8.0.0;
`@prisma/config` pins 7.1.5 and there is no route to 8.x without a Prisma
release. An override to `^8` would hand `@prisma/config` an API it was not built
against, so forcing one trades a dev-time advisory for a runtime break.

Reachability, checked rather than assumed, offline against the installed tree:

- exactly one copy in the store (`node_modules/.pnpm/deepmerge-ts@7.1.5`);
- its only parent is `@prisma/config`, whose only parent is `prisma`, the CLI;
- no file under `apps/*/src` or `packages/*/src` imports either name;
- the API's runtime entrypoint is `tsx` over `apps/api/src/main.ts`, which never
  loads `@prisma/config`. The CLI runs at image build (`prisma generate`) and in
  the compose `migrate` one-shot (`prisma migrate deploy`), over config files
  this repository owns.

An attacker would need to control the Prisma config file, at which point they
already control the build. That is why `verify.yml:178` gates
`pnpm audit --prod` at `--audit-level=critical` rather than `high`, with the full
report still printed non-blocking on every run.

The danger with any such exception is that it outlives its justification. So it
is not only a comment: `ADVISORY_EXCEPTIONS` in the check asserts both facts that
make it defensible, and fails if either stops holding — if the tree reaches
`deepmerge-ts` 8.x (exception stale, raise the gate back to `high`), or if
`deepmerge-ts` ever appears under a parent other than `@prisma/config` (the
"dev-only, config files only" argument has stopped being true and somebody has to
look again).

## Still owed, and outside what this file's owner can write

- **A `NOTICE` / third-party-attribution file.** There is no `LICENSE`, `NOTICE`
  or attribution file anywhere in the repository. MIT, Apache-2.0 and BSD all
  require their notice to accompany redistribution, and the desktop installers in
  `apps/desktop` **are** redistributed to users. Generating it is close to
  mechanical (`pnpm licenses list --prod --json`), with two hand-added lines:
  `seq-queue` (grant in a file the generator cannot see) and whatever the owner
  decides about `buffers`. It belongs at the repository root and inside the
  installer, linked from the app's About page.
- **The identity of the licensor.** Any NOTICE or licence file has to name a
  legal person: [PLACEHOLDER: the registered company name, GEMI number and
  registered address that will appear as copyright holder]. Nothing in this
  repository may invent one.
- **A dedicated CI step.** The check runs today because `check:pnpm-pins` chains
  it, so it executes inside a step named "pnpm pins match across package.json and
  the Dockerfiles" — which under-describes it. `verify.yml` belongs to another
  owner; when it is next opened, give `pnpm check:supply-chain` its own step.
