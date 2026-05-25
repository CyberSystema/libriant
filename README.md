# Libriant

Multi-tenant SaaS for library management. Path-based tenants (`libriant.app/t/<slug>/…`),
DB-per-tenant, per-tenant storage, Stripe + manual billing, fully bilingual (Greek + English)
from day one, hot-swappable graphic assets, designed end-to-end for non-technical librarians.

Full design plan: see [the plan](./.claude/plan.md) (also kept at
`~/.claude/plans/i-want-to-create-enumerated-corbato.md`).

## Repo layout

```
apps/
├── api/        NestJS API + worker
└── web/        Next.js staff UI (locale-aware, asset/theme-driven)
packages/
├── ui/         Design system: <Asset>, <Button>, <Banner>, <EmptyState>, <Skeleton>, tokens helpers
├── i18n/       Locale registry, translator, ICU-style plural/format helpers
└── shared/     Feature key catalog + shared enums
assets/        Hot-swappable graphic assets (replace files → look changes, no rebuild)
locales/       Translation catalogs (en, el — equally first-class)
infra/         Docker compose, pgbouncer, caddy (later), deploy scripts (later)
scripts/       CI gates (check-translations, check-assets) + provisioning later
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
docker compose -f infra/compose/docker-compose.dev.yml up -d

# 3. Copy env defaults
cp .env.example .env.local

# 4. Run CI gates locally to confirm the foundation is intact
pnpm check:translations
pnpm check:assets
pnpm typecheck
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

## What's NOT here yet (intentionally, per the plan)

This is the **Step 0 foundation** only. The next steps from the approved plan:

1. Control-plane Prisma schema (tenants, users, plans, plan_features, …)
2. Tenant Prisma schema (books, members, loans, reservations, customization layer)
3. Tenancy middleware (path-based `/t/<slug>/…`, with subdomain fallback)
4. Auth (passport-local + cookie sessions)
5. Plan/quota guards
6. Storage driver layer
7. Catalog / Members / Loans / Reservations modules
8. Custom collections module
9. Stripe + manual billing
10. Onboarding wizard, help center, contextual help drawers
11. Internal admin (plans editor, tenant detail, support-redeem, system-mode, announcements)
12. Caddy + prod compose + GH Actions deploy

We're at step 0 of 17 from the plan's build sequence. Everything above this line
is the substrate the rest stands on.
