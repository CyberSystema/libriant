# Libriant

Multi-tenant SaaS for library management. Path-based tenants (`libriant.app/t/<slug>/…`),
DB-per-tenant, per-tenant storage, Stripe + manual billing, fully bilingual (Greek + English)
from day one, hot-swappable graphic assets, designed end-to-end for non-technical librarians.

Full design plan: see [the plan](./.claude/plan.md) (also kept at
`~/.claude/plans/i-want-to-create-enumerated-corbato.md`).

## Repo layout

```
apps/
├── api/        NestJS API + worker (health endpoints; tenancy/auth wired in later steps)
└── web/        Next.js staff UI (locale-aware, asset/theme-driven)
packages/
├── ui/         Design system: <Asset>, <Button>, <Banner>, <EmptyState>, <Skeleton>, tokens helpers
├── i18n/       Locale registry, translator, ICU-style plural/format helpers
├── shared/     Feature key catalog + shared enums (FeatureKey, BillingMode, SystemMode)
├── db-control/ Control-plane Prisma schema + client + idempotent seed
└── db-tenant/  Tenant Prisma schema (catalog, members, loans, customization) + client factory + smoke test
assets/        Hot-swappable graphic assets (replace files → look changes, no rebuild)
locales/       Translation catalogs (en, el — equally first-class)
infra/         Docker compose, pgbouncer, caddy (later), deploy scripts (later)
scripts/       CI gates (check-translations, check-assets) + provisioning later
.github/       CI workflow (static checks + DB migration + seed idempotency)
```

## Prerequisites

- Node 20+ (`.nvmrc` pins it)
- pnpm 9+ (`packageManager` in `package.json` pins it)
- Docker + Docker Compose

## First-time setup

```sh
# 1. Install deps
pnpm install

# 2. Bring up data services (Postgres, PgBouncer, Redis)
pnpm db:up

# 3. Copy env defaults
cp .env.example .env.local

# 4. Apply control-plane migration + seed
pnpm db:migrate:deploy
pnpm db:seed

# 5. Apply tenant schema to the demo tenant DB + seed defaults
TENANT_DATABASE_URL=postgresql://libriant:libriant@localhost:5432/libriant_demo pnpm tenant:migrate:deploy
TENANT_DATABASE_URL=postgresql://libriant:libriant@localhost:5432/libriant_demo pnpm tenant:seed:defaults

# 6. Run CI gates locally to confirm everything is intact
pnpm check:all          # typecheck + translations + assets + lint
pnpm format:check
TENANT_DATABASE_URL=postgresql://libriant:libriant@localhost:5432/libriant_demo pnpm tenant:smoke   # full end-to-end DB invariants drill
```

After steps 4–5 you'll have:

- 21 tables in `libriant_control` (cells, tenants, users, plans, …, support_keys, system_mode_events)
- 1 default cell (`eu-1`), 15 feature rows, 5 starter plans, 75 plan-feature values
- 14 tables in `libriant_demo` (the tenant schema: authors, books, copies, members, loans, reservations, fines, field_definitions, collections, collection_records, audit_log, tenant_settings, …)
- A `tenant_settings` singleton row with sensible library defaults (14-day loans, 2 renewals, €0.10/day fines, 48h hold pickup)

### Common db commands

```sh
pnpm db:up                 # boot postgres/pgbouncer/redis
pnpm db:psql               # interactive psql into libriant_control
pnpm db:studio             # Prisma Studio (web UI for the DB)
pnpm db:generate           # generate both Prisma clients
pnpm db:migrate:deploy     # apply control-plane migrations
pnpm db:seed               # idempotent seed (cells + features + plans)
pnpm db:reset              # nuke + recreate DB + reseed (dev only!)
pnpm db:down               # stop containers

# Tenant DB lifecycle (provide TENANT_DATABASE_URL):
pnpm tenant:migrate:deploy   # apply tenant migrations to a tenant DB
pnpm tenant:seed:defaults    # write the tenant_settings singleton
pnpm tenant:smoke            # full end-to-end DB invariants drill
```

## Running the app

```sh
# Web (Next.js, port 3000) — visit http://localhost:3000
pnpm --filter @libriant/web dev

# API (NestJS, port 3001) — visit http://localhost:3001/healthz
pnpm --filter @libriant/api dev
```

Open <http://localhost:3000> — Next.js negotiates a locale from your `Accept-Language`
header and bounces you to `/el` or `/en`. The page demonstrates the whole Step 0
foundation: design tokens from `assets/theme/tokens.json`, icons from `assets/icons/*`,
strings from `locales/<lang>/*.json`.

### Verify hot-swap

While the app is running:

- Change `colors.primary` in `assets/theme/tokens.json` from `#1f6feb` to e.g. `#1a7f37` and reload.
  Every primary-coloured element should flip green.
- Replace `assets/brand/logo.svg` with any other SVG and reload — the header logo updates.
- Edit `locales/el/common.json`: change `app.tagline` to anything, reload `/el`, see it appear.
  No restart, no rebuild.

## Where we are in the plan

| Step  | Description                                                          | Status                         |
| ----- | -------------------------------------------------------------------- | ------------------------------ |
| 0     | Design system + i18n + assets foundation                             | ✅ done                        |
| 1     | Repo scaffold (pnpm/turbo/tsconfig/prettier)                         | ✅ done                        |
| 2     | **Control-plane Prisma schema + idempotent seed**                    | ✅ done                        |
| 3     | Feature key catalog                                                  | ✅ done (in `packages/shared`) |
| 4     | **Tenant Prisma schema (catalog/members/loans/customization/audit)** | ✅ done                        |
| 5     | NestJS API skeleton (health endpoints)                               | ✅ done                        |
| 6     | Tenancy middleware (path → tenant; per-tenant Prisma)                | ⏳                             |
| 7     | Auth (passport-local + sessions)                                     | ⏳                             |
| 8     | Plan/quota system + EffectivePlanService                             | ⏳                             |
| 9     | Schema customization (field defs + collections)                      | ⏳                             |
| 10    | Storage driver layer                                                 | ⏳                             |
| 11–15 | Catalog / Members / Loans / Reservations / Collections               | ⏳                             |
| 16    | Billing (Stripe + manual)                                            | ⏳                             |
| 17    | Staff UI (onboarding, help center, billing)                          | ⏳                             |
| 18    | Internal admin (plans, support, system mode, announcements)          | ⏳                             |
| 19    | Infra (Caddy, prod compose, GH Actions deploy)                       | ⏳                             |
| 20    | Tenant provisioning + relocation scripts                             | ⏳                             |
