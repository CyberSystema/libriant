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

### Verify the tenancy layer

With both the API up and the demo `acme` tenant seeded into the control plane:

```sh
# 1. Resolved tenant context via path
curl -s http://localhost:3001/t/acme/info | jq

# 2. Same tenant, this time per-tenant DB query through TenantPrismaService
curl -s http://localhost:3001/t/acme/db-ping | jq

# 3. Subdomain resolution
curl -s -H "Host: acme.localhost" http://localhost:3001/t/acme/info | jq

# 4. Negative paths
curl -i http://localhost:3001/t/nope/info          # 404
curl -i http://localhost:3001/t/paused-lib/info    # 403
curl -i http://localhost:3001/t/archived-lib/info  # 410
curl -i http://localhost:3001/t/INVALID-SLUG/info  # 400 (slug shape rejected)
```

### Seed the demo tenants used by `/t/acme/...` probes

```sh
docker cp infra/seed/demo-tenants.sql libriant-postgres:/tmp/demo-tenants.sql
PGPASSWORD=libriant docker exec libriant-postgres \
  psql -U libriant -d libriant_control -f /tmp/demo-tenants.sql
```

### Verify auth (signup + login + cross-tenant defense)

```sh
JAR=/tmp/jar.txt && rm -f $JAR

# 1. Signup — creates the library DB + first owner user + session cookie
curl -s -c $JAR -H "Content-Type: application/json" \
  -d '{"libraryName":"My Library","slug":"my-library","fullName":"Me","email":"me@example.test","password":"a-very-long-secret-passphrase-123"}' \
  http://localhost:3001/auth/signup | jq

# 2. /me — returns current user + tenant snapshot
curl -s -b $JAR http://localhost:3001/auth/me | jq

# 3. Same tenant access works
curl -s -b $JAR http://localhost:3001/t/my-library/who-am-i | jq

# 4. Cross-tenant: accessing a *different* tenant with this cookie → 403
curl -i -b $JAR http://localhost:3001/t/acme/info     # 403

# 5. Logout + login + lockout drills
curl -X POST -b $JAR -c $JAR http://localhost:3001/auth/logout
curl -s -c $JAR -H "Content-Type: application/json" \
  -d '{"slug":"my-library","email":"me@example.test","password":"a-very-long-secret-passphrase-123"}' \
  http://localhost:3001/auth/login
# Five wrong attempts will lock the user out for 15 minutes:
for i in 1 2 3 4 5; do
  curl -s -X POST -H "Content-Type: application/json" \
    -d '{"slug":"my-library","email":"me@example.test","password":"WRONG-PASSWORD-but-long-enough"}' \
    http://localhost:3001/auth/login
done

# 6. Password reset stub — the link is logged to the API stdout; copy the token
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"slug":"my-library","email":"me@example.test"}' \
  http://localhost:3001/auth/password-reset/request
# Then look for "[PASSWORD RESET]" in the API log, copy the token, and:
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"token":"<paste-token-here>","newPassword":"new-passphrase-after-reset"}' \
  http://localhost:3001/auth/password-reset/complete
```

### Verify the plan / quota system

With a signed-in tenant (use the cookie jar from auth above):

```sh
# 1. Effective plan — every feature with `source` attribution
curl -s -b $JAR http://localhost:3001/t/my-library/plan | jq

# 2. Usage report — counts vs. limits side-by-side
curl -s -b $JAR http://localhost:3001/t/my-library/plan/usage | jq

# 3. Feature gate — Starter doesn't include reservations → 402
curl -i -b $JAR http://localhost:3001/t/my-library/demo/reservations   # 402

# 4. Override the gate; invalidate cache; retry
TENANT_ID=$(PGPASSWORD=libriant docker exec libriant-postgres psql -U libriant -d libriant_control -tAc \
  "SELECT id FROM tenants WHERE slug='my-library';")
PGPASSWORD=libriant docker exec libriant-postgres psql -U libriant -d libriant_control -c "
  INSERT INTO tenant_plan_overrides (id, \"tenantId\", \"featureKey\", \"valueBool\", note, \"updatedAt\")
  VALUES ('tpo-r', '$TENANT_ID', 'reservations_enabled', true, 'Pilot trial', NOW());
"
docker exec libriant-redis redis-cli DEL "lbr:plan:effective:$TENANT_ID"
curl -i -b $JAR http://localhost:3001/t/my-library/demo/reservations   # 200

# 5. Integer quota — cap max_books to 2, then post 3 books; 3rd → 402
PGPASSWORD=libriant docker exec libriant-postgres psql -U libriant -d libriant_control -c "
  INSERT INTO tenant_plan_overrides (id, \"tenantId\", \"featureKey\", \"valueInt\", note, \"updatedAt\")
  VALUES ('tpo-b', '$TENANT_ID', 'max_books', 2, 'Quota demo', NOW());
"
docker exec libriant-redis redis-cli DEL "lbr:plan:effective:$TENANT_ID"
for n in 1 2 3; do
  curl -s -b $JAR -w "\n  HTTP %{http_code}\n" -H "Content-Type: application/json" \
    -d "{\"title\":\"Book $n\"}" http://localhost:3001/t/my-library/demo/books
done
```

### Verify schema customization

```sh
JAR=/tmp/jar.txt  # cookie jar from auth section

# Layer 1 — per-entity custom fields
# 1. Define a short_text field on book
curl -s -b $JAR -H "Content-Type: application/json" \
  -d '{"fieldKey":"shelf_section","labelJson":{"en":"Shelf section","el":"Τομέας ραφιού"},"type":"short_text"}' \
  http://localhost:3001/t/my-library/data-model/fields/book | jq

# 2. Define a select_one with options
curl -s -b $JAR -H "Content-Type: application/json" \
  -d '{"fieldKey":"genre","labelJson":{"en":"Genre","el":"Είδος"},"type":"select_one","required":true,
       "optionsJson":{"options":[{"value":"fiction","label":{"en":"Fiction"}},{"value":"poetry","label":{"en":"Poetry"}}]}}' \
  http://localhost:3001/t/my-library/data-model/fields/book | jq

# 3. List, archive, restore — DELETE soft-archives; POST with same key restores
curl -s -b $JAR http://localhost:3001/t/my-library/data-model/fields/book | jq
curl -s -b $JAR -X DELETE http://localhost:3001/t/my-library/data-model/fields/book/shelf_section

# Layer 2 — custom collections (override the Starter limit first)
TENANT_ID=$(PGPASSWORD=libriant docker exec libriant-postgres psql -U libriant -d libriant_control -tAc \
  "SELECT id FROM tenants WHERE slug='my-library';")
PGPASSWORD=libriant docker exec libriant-postgres psql -U libriant -d libriant_control -c "
  INSERT INTO tenant_plan_overrides (id, \"tenantId\", \"featureKey\", \"valueInt\", note, \"updatedAt\")
  VALUES ('cust-c', '$TENANT_ID', 'max_custom_collections', 2, 'demo', NOW()),
         ('cust-r', '$TENANT_ID', 'max_records_per_collection', 100, 'demo', NOW());
"
docker exec libriant-redis redis-cli DEL "lbr:plan:effective:$TENANT_ID"

# Create a DVDs collection with two fields
curl -s -b $JAR -H "Content-Type: application/json" \
  -d '{"slug":"dvds","singularLabelJson":{"en":"DVD"},"pluralLabelJson":{"en":"DVDs"},"iconAssetRef":"icons/book"}' \
  http://localhost:3001/t/my-library/data-model/collections | jq

curl -s -b $JAR -H "Content-Type: application/json" \
  -d '{"fieldKey":"title","labelJson":{"en":"Title"},"type":"short_text","required":true}' \
  http://localhost:3001/t/my-library/data-model/collections/dvds/fields
curl -s -b $JAR -H "Content-Type: application/json" \
  -d '{"fieldKey":"runtime_minutes","labelJson":{"en":"Runtime"},"type":"number","validationJson":{"min":1,"max":600}}' \
  http://localhost:3001/t/my-library/data-model/collections/dvds/fields

# Insert records — dynamic validation against the field schema
curl -s -b $JAR -H "Content-Type: application/json" \
  -d '{"title":"Casablanca","runtime_minutes":102}' \
  http://localhost:3001/t/my-library/collections/dvds/records | jq

# Validation errors come back as a structured list
curl -i -b $JAR -H "Content-Type: application/json" \
  -d '{"runtime_minutes":9999}' \
  http://localhost:3001/t/my-library/collections/dvds/records

# Search records (accent-folded, so "καπετα" finds "Καπετάν")
curl -s -b $JAR -G --data-urlencode "q=καπετα" \
  http://localhost:3001/t/my-library/collections/dvds/records | jq
```

### Verify the storage layer

Per-tenant filesystem driver, MIME whitelist per resource type, signed-URL
downloads, quota enforcement against `max_storage_mb`, and a recompute
endpoint that walks the disk and overwrites the counter.

```sh
JAR=/tmp/jar.txt  # cookie jar from auth section
STORAGE_ROOT=/tmp/libriant-storage   # see .env.example

# 1. Make a tiny PNG, upload it as a book cover
python3 -c "import base64; open('/tmp/cover.png','wb').write(
  base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='))"
curl -s -b $JAR -F "file=@/tmp/cover.png;type=image/png" \
  http://localhost:3001/t/my-library/storage/covers | jq

# 2. Authenticated download (uses the cookie + tenant URL)
REF=$(ls $STORAGE_ROOT/<tenantId>/covers/ | head -1)   # find the generated cuid
curl -s -b $JAR -o /tmp/dl.png \
  http://localhost:3001/t/my-library/storage/covers/$REF

# 3. Signed URL — no cookie required to follow
SIGNED=$(curl -s -b $JAR \
  "http://localhost:3001/t/my-library/storage/covers/$REF/signed-url?ttlSec=300" | jq -r .url)
curl -s -o /tmp/dl-signed.png "http://localhost:3001$SIGNED"

# 4. Reject disallowed MIME for the resource → 415
echo hi > /tmp/x.txt
curl -i -b $JAR -F "file=@/tmp/x.txt;type=text/plain" \
  http://localhost:3001/t/my-library/storage/covers      # 415

# 5. Quota: override max_storage_mb=1, upload ~1.5 MB → 402
PGPASSWORD=libriant docker exec libriant-postgres psql -U libriant -d libriant_control -c "
  INSERT INTO tenant_plan_overrides (id, \"tenantId\", \"featureKey\", \"valueInt\", note, \"updatedAt\")
  VALUES ('s', '<tenantId>', 'max_storage_mb', 1, 'demo', NOW());
"
docker exec libriant-redis redis-cli DEL "lbr:plan:effective:<tenantId>"
python3 -c "import os; open('/tmp/big.png','wb').write(b'\x89PNG\r\n\x1a\n'+os.urandom(1_600_000))"
curl -i -b $JAR -F "file=@/tmp/big.png;type=image/png" \
  http://localhost:3001/t/my-library/storage/covers      # 402

# 6. Path traversal is refused at the driver
curl -i --path-as-is -b $JAR \
  "http://localhost:3001/t/my-library/storage/covers/..%2F..%2Fetc%2Fpasswd"   # 404

# 7. Recompute usage counter from disk
curl -s -b $JAR -X POST http://localhost:3001/t/my-library/storage-admin/recompute | jq
```

### Verify the catalog

Full CRUD for authors, books, copies, plus ISBN pre-fill via OpenLibrary
and cover uploads through the StorageService.

```sh
JAR=/tmp/jar.txt  # cookie jar from auth section

# Create two authors
A1=$(curl -s -b $JAR -H "Content-Type: application/json" \
  -d '{"fullName":"Νίκος Καζαντζάκης","birthYear":1883,"deathYear":1957}' \
  http://localhost:3001/t/my-library/catalog/authors | jq -r .id)
A2=$(curl -s -b $JAR -H "Content-Type: application/json" \
  -d '{"fullName":"Philip Sherrard"}' \
  http://localhost:3001/t/my-library/catalog/authors | jq -r .id)

# Define a custom field on book first (so we can attach it on create)
curl -s -b $JAR -H "Content-Type: application/json" \
  -d '{"fieldKey":"shelf_section","labelJson":{"en":"Shelf","el":"Τομέας"},"type":"short_text"}' \
  http://localhost:3001/t/my-library/data-model/fields/book

# Create a book with two authors + a custom field
BOOK=$(curl -s -b $JAR -H "Content-Type: application/json" \
  -d "{\"title\":\"Ο Καπετάν Μιχάλης\",\"isbn13\":\"978-960-04-2929-7\",
       \"publicationYear\":1953,\"language\":\"el\",
       \"authors\":[{\"authorId\":\"$A1\"},{\"authorId\":\"$A2\",\"role\":\"translator\"}],
       \"customFields\":{\"shelf_section\":\"A-3\"}}" \
  http://localhost:3001/t/my-library/catalog/books)
BOOK_ID=$(echo "$BOOK" | jq -r .id)

# Add two copies + search
curl -s -b $JAR -H "Content-Type: application/json" \
  -d '{"barcode":"KAL-0001","shelfLocation":"Section A · Shelf 3"}' \
  http://localhost:3001/t/my-library/catalog/books/$BOOK_ID/copies
curl -s -b $JAR -G --data-urlencode "q=καπετα" \
  http://localhost:3001/t/my-library/catalog/books | jq .items[].title

# ISBN lookup — Redis-cached for 30 days
curl -s -b $JAR http://localhost:3001/t/my-library/catalog/isbn-lookup/9780140447934 | jq

# Cover upload — book.coverAssetRef is set; old file is replaced atomically
python3 -c "import base64; open('/tmp/cover.png','wb').write(
  base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='))"
curl -s -b $JAR -F "file=@/tmp/cover.png;type=image/png" \
  http://localhost:3001/t/my-library/catalog/books/$BOOK_ID/cover | jq

# Status transitions on a copy — forbid `on_loan` (managed by Loans)
COPY_ID=$(curl -s -b $JAR "http://localhost:3001/t/my-library/catalog/books/$BOOK_ID" | jq -r '.copies[0].id')
curl -i -b $JAR -H "Content-Type: application/json" -X PATCH \
  -d '{"status":"on_loan"}' \
  http://localhost:3001/t/my-library/catalog/copies/$COPY_ID   # 400
```

### Verify the members module

CRUD for library members, auto-generated `M-YYYY-NNNN` numbers, status
transitions, archive (refuses if there are open loans/reservations), and
photo upload through the StorageService.

```sh
JAR=/tmp/jar.txt  # cookie jar from auth section

# Create a member — number auto-generated; Greek-folded sortName + searchText
M=$(curl -s -b $JAR -H "Content-Type: application/json" \
  -d '{"fullName":"Μαρία Καπετανάκη","email":"maria.k@example.gr","city":"Αθήνα"}' \
  http://localhost:3001/t/my-library/members)
MID=$(echo "$M" | jq -r .id)
echo "$M" | jq '{memberNumber, sortName}'   # → "M-2026-0001" / "μαρια καπετανακη"

# Greek-folded search — "καπετα" matches "Καπετανάκη"
curl -s -b $JAR -G --data-urlencode "q=καπετα" \
  http://localhost:3001/t/my-library/members | jq '.items[].fullName'

# Custom field validation — type=select_one with an invalid value
curl -s -b $JAR -H "Content-Type: application/json" \
  -d '{"fieldKey":"membership_tier","labelJson":{"en":"Tier","el":"Επίπεδο"},
       "type":"select_one",
       "optionsJson":{"options":[{"value":"bronze","label":{"en":"Bronze","el":"Χάλκινο"}},
                                  {"value":"gold","label":{"en":"Gold","el":"Χρυσό"}}]}}' \
  http://localhost:3001/t/my-library/data-model/fields/member
curl -s -b $JAR -H "Content-Type: application/json" \
  -d '{"fullName":"Bad","customFields":{"membership_tier":"platinum"}}' \
  http://localhost:3001/t/my-library/members   # 400 — "Pick one of: bronze, gold."

# Status transitions — append reason to staffNotes
curl -s -b $JAR -H "Content-Type: application/json" -X PUT \
  -d '{"status":"suspended","reason":"Lost card pending replacement"}' \
  http://localhost:3001/t/my-library/members/$MID/status
curl -i -b $JAR -H "Content-Type: application/json" -X PUT \
  -d '{"status":"archived"}' \
  http://localhost:3001/t/my-library/members/$MID/status   # 400 — DELETE only

# GET surfaces circulation counts
curl -s -b $JAR http://localhost:3001/t/my-library/members/$MID | jq .circulation

# Archive — refuses with open business; DELETE clears it; restore via PATCH
curl -i -b $JAR -X DELETE http://localhost:3001/t/my-library/members/$MID
curl -s -b $JAR -H "Content-Type: application/json" -X PATCH \
  -d '{"archived":false}' \
  http://localhost:3001/t/my-library/members/$MID | jq '{status, archivedAt}'

# Photo upload — atomic swap, deletes the prior file
curl -s -b $JAR -F "file=@/tmp/cover.png;type=image/png" \
  http://localhost:3001/t/my-library/members/$MID/photo | jq
curl -s -b $JAR -X DELETE http://localhost:3001/t/my-library/members/$MID/photo | jq

# Quota — `max_members` enforced via @RequiresQuota on POST /members
# (Set tenant_plan_overrides.max_members to a small N to test 402 quickly.)
```

### Verify the loans module

Lend / return / renew / mark-lost. State transitions run inside a Prisma
`$transaction` so a half-applied checkout (loan created but copy not flipped,
or vice versa) is impossible. Overdue fines are calculated from
`tenant_settings` (finePerDayCents × days, capped at fineCapCents).

```sh
JAR=/tmp/jar.txt  # cookie jar from auth section

# (Use the BOOK_ID + COPY_ID + MID from the catalog/members sections above.)

# 1) Checkout — copy flips to `on_loan`, dueAt = loanedAt + loanPeriodDays
LOAN_ID=$(curl -s -b $JAR -X POST http://localhost:3001/t/my-library/loans \
  -H "Content-Type: application/json" \
  -d "{\"copyId\":\"$COPY_ID\",\"memberId\":\"$MID\"}" | jq -r .loan.id)
curl -s -b $JAR "http://localhost:3001/t/my-library/catalog/books/$BOOK_ID" \
  | jq '.copies[].status'      # → "on_loan"

# 2) Refusals: double-checkout, suspended/archived member, transition shortcuts
curl -i -b $JAR -X POST http://localhost:3001/t/my-library/loans \
  -H "Content-Type: application/json" \
  -d "{\"copyId\":\"$COPY_ID\",\"memberId\":\"$MID\"}"             # 400
curl -i -b $JAR -X PATCH http://localhost:3001/t/my-library/catalog/copies/$COPY_ID \
  -H "Content-Type: application/json" -d '{"status":"available"}' # 400 (use return)

# 3) Renew — refused when there's a queued reservation on the same book,
#    or once renewedCount hits tenant_settings.maxRenewals
curl -s -b $JAR -X POST http://localhost:3001/t/my-library/loans/$LOAN_ID/renew \
  -H "Content-Type: application/json" -d '{"periods":1}' | jq '{dueAt, renewedCount}'

# 4) Return — overdue fine is auto-created. To force overdue, backdate both
#    `loanedAt` AND `dueAt` together so the `loans_due_after_loaned` CHECK
#    still holds:
#    UPDATE loans SET "loanedAt" = NOW() - INTERVAL '20 days',
#                     "dueAt"    = NOW() - INTERVAL  '5 days' WHERE id = '<LOAN_ID>';
curl -s -b $JAR -X POST http://localhost:3001/t/my-library/loans/$LOAN_ID/return \
  -H "Content-Type: application/json" -d '{}' | jq '{loan_status: .loan.status, fine}'
# → fine: { amountCents: 50, currency: "EUR", daysOverdue: 5 }   (5 × 10c)

# 5) Mark-lost — copy → `lost`, optional replacement fine
LOAN2=$(curl -s -b $JAR -X POST http://localhost:3001/t/my-library/loans \
  -H "Content-Type: application/json" \
  -d "{\"copyId\":\"$COPY_ID2\",\"memberId\":\"$MID\"}" | jq -r .loan.id)
curl -s -b $JAR -X POST http://localhost:3001/t/my-library/loans/$LOAN2/mark-lost \
  -H "Content-Type: application/json" -d '{"replacementCostCents":1500}' \
  | jq '{copy_status: .loan.copy.status, fine}'

# 6) List filters
curl -s -b $JAR "http://localhost:3001/t/my-library/loans?status=active"   | jq .items
curl -s -b $JAR "http://localhost:3001/t/my-library/loans?overdue=1"        | jq .items
curl -s -b $JAR "http://localhost:3001/t/my-library/loans?memberId=$MID"    | jq .items

# 7) Member circulation now reflects the active loan; archive refuses
curl -s -b $JAR "http://localhost:3001/t/my-library/members/$MID" | jq .circulation
curl -i -b $JAR -X DELETE "http://localhost:3001/t/my-library/members/$MID"  # 400
```

### Verify the reservations module

Hold queue, auto-promotion on return, ready-window expiry, and fulfillment
through the same Loans transaction (copy `reserved` → `on_loan` and
reservation `ready` → `fulfilled` atomically).

Requires a plan with `reservations_enabled` (Community or higher). On
Starter you'll see a 402 — that's the gate; upgrade via the admin UI
or directly:

```sh
# Promote tenant to Community (skip if already there)
TID=$(docker exec libriant-postgres psql -U libriant -d libriant_control -At \
  -c "SELECT id FROM tenants WHERE slug='my-library';")
COMMUNITY=$(docker exec libriant-postgres psql -U libriant -d libriant_control -At \
  -c "SELECT id FROM plans WHERE slug='community';")
docker exec libriant-postgres psql -U libriant -d libriant_control -At \
  -c "UPDATE subscriptions SET \"planId\" = '$COMMUNITY', \"updatedAt\" = NOW() WHERE \"tenantId\" = '$TID';"
docker exec libriant-redis redis-cli --no-raw EVAL \
  "for _,k in ipairs(redis.call('keys','lbr:plan:*')) do redis.call('del',k) end return 'ok'" 0
```

```sh
JAR=/tmp/jar.txt  # cookie jar from auth section
# Assumes BOOK_ID + a copy + two members from earlier sections.

# 1) Place hold with no copies available → joins the queue
H1=$(curl -s -b $JAR -X POST http://localhost:3001/t/my-library/reservations \
  -H "Content-Type: application/json" \
  -d "{\"bookId\":\"$BOOK_ID\",\"memberId\":\"$M1\"}" | jq -r .reservation.id)

# 2) Place hold with a copy AVAILABLE + no queue → auto-promotes to ready,
#    the chosen copy flips available → reserved
curl -s -b $JAR -X POST http://localhost:3001/t/my-library/reservations \
  -H "Content-Type: application/json" \
  -d "{\"bookId\":\"$BOOK_ID2\",\"memberId\":\"$M2\"}" | jq '{outcome, status: .reservation.status, copy: .reservation.fulfilledByCopy.barcode}'
# → { "outcome": "ready", "status": "ready", "copy": "..." }

# 3) Duplicate hold by same member is refused with a friendly Greek-aware msg
curl -i -b $JAR -X POST http://localhost:3001/t/my-library/reservations \
  -H "Content-Type: application/json" \
  -d "{\"bookId\":\"$BOOK_ID2\",\"memberId\":\"$M2\"}"  # 409

# 4) Return triggers auto-promotion. The response includes `promotedHold`
#    so the librarian's UI can route the book to the holds shelf instead
#    of general stacks.
curl -s -b $JAR -X POST http://localhost:3001/t/my-library/loans/$LOAN_ID/return \
  -H "Content-Type: application/json" -d '{}' | jq .promotedHold
# → { reservationId, memberId, memberFullName, expiresAt }

# 5) Pick up a ready hold — copy reserved → on_loan, reservation ready → fulfilled
curl -s -b $JAR -X POST http://localhost:3001/t/my-library/reservations/$H1/fulfill \
  -H "Content-Type: application/json" -d '{}' | jq .loan.id

# 6) Cancel a ready hold → frees the copy AND tries to promote next in queue
curl -s -b $JAR -X DELETE http://localhost:3001/t/my-library/reservations/$H2 | jq .status

# 7) Force-expire a ready hold (cron + admin path). Same promotion behavior
#    as cancel. Queued holds refuse expire — only ready ones expire.
curl -s -b $JAR -X POST http://localhost:3001/t/my-library/reservations/$H3/expire | jq .status

# 8) List filters
curl -s -b $JAR "http://localhost:3001/t/my-library/reservations"                | jq .items
curl -s -b $JAR "http://localhost:3001/t/my-library/reservations?status=ready"   | jq .items
curl -s -b $JAR "http://localhost:3001/t/my-library/reservations?includeResolved=1" | jq .items

# 9) Plan downgrade is graceful — list/get/cancel still work even after
#    `reservations_enabled` flips off; only POST /reservations and
#    POST /reservations/:id/fulfill return 402.
```

### Verify the custom collections module

A library admin defines their own entity types (DVDs, BoardGames, Events)
with their own field schemas (`/data-model/collections/...`), then records
of those collections are CRUD'd through generic endpoints
(`/collections/:cslug/records/...`).

Records validate against the collection's _active_ field definitions at
request time — so archiving a field instantly stops accepting it on
writes, while existing records remain readable.

Plan-gated: Starter has `max_custom_collections=0`, so it returns 402
until the tenant moves to Community (1) or higher.

```sh
JAR=/tmp/jar.txt  # cookie jar from auth section

# 1) Starter is gated — POST returns 402. Upgrade to Community:
TID=$(docker exec libriant-postgres psql -U libriant -d libriant_control -At \
  -c "SELECT id FROM tenants WHERE slug='my-library';")
COMMUNITY=$(docker exec libriant-postgres psql -U libriant -d libriant_control -At \
  -c "SELECT id FROM plans WHERE slug='community';")
docker exec libriant-postgres psql -U libriant -d libriant_control -At \
  -c "UPDATE subscriptions SET \"planId\" = '$COMMUNITY', \"updatedAt\" = NOW() WHERE \"tenantId\" = '$TID';"
docker exec libriant-redis redis-cli --no-raw EVAL \
  "for _,k in ipairs(redis.call('keys','lbr:plan:*')) do redis.call('del',k) end return 'ok'" 0

# 2) Create the `dvds` collection
curl -s -b $JAR -X POST http://localhost:3001/t/my-library/data-model/collections \
  -H "Content-Type: application/json" \
  -d '{"slug":"dvds","singularLabelJson":{"en":"DVD","el":"DVD"},"pluralLabelJson":{"en":"DVDs","el":"DVDs"},"iconAssetRef":"icons/book"}'

# 3) Add fields of every important type
curl -s -b $JAR -X POST http://localhost:3001/t/my-library/data-model/collections/dvds/fields \
  -H "Content-Type: application/json" \
  -d '{"fieldKey":"title","labelJson":{"en":"Title","el":"Τίτλος"},"type":"short_text","required":true}'
curl -s -b $JAR -X POST http://localhost:3001/t/my-library/data-model/collections/dvds/fields \
  -H "Content-Type: application/json" \
  -d '{"fieldKey":"runtime_minutes","labelJson":{"en":"Runtime","el":"Διάρκεια"},"type":"number"}'
curl -s -b $JAR -X POST http://localhost:3001/t/my-library/data-model/collections/dvds/fields \
  -H "Content-Type: application/json" \
  -d '{"fieldKey":"region","labelJson":{"en":"Region","el":"Περιοχή"},"type":"select_one","required":true,
       "optionsJson":{"options":[{"value":"r1","label":{"en":"R1","el":"R1"}},{"value":"r2","label":{"en":"R2","el":"R2"}}]}}'

# 4) Validation refusals — missing required, wrong type, invalid option, unknown field
curl -i -b $JAR -X POST http://localhost:3001/t/my-library/collections/dvds/records \
  -H "Content-Type: application/json" -d '{"runtime_minutes":120,"region":"r1"}'        # 400 missing title
curl -i -b $JAR -X POST http://localhost:3001/t/my-library/collections/dvds/records \
  -H "Content-Type: application/json" -d '{"title":"x","runtime_minutes":"long","region":"r1"}'  # 400 type
curl -i -b $JAR -X POST http://localhost:3001/t/my-library/collections/dvds/records \
  -H "Content-Type: application/json" -d '{"title":"x","region":"r9"}'                  # 400 option
curl -i -b $JAR -X POST http://localhost:3001/t/my-library/collections/dvds/records \
  -H "Content-Type: application/json" -d '{"title":"x","region":"r1","director":"x"}'   # 400 unknown

# 5) Happy path + Greek-aware search (writer + reader both normalize)
curl -s -b $JAR -X POST http://localhost:3001/t/my-library/collections/dvds/records \
  -H "Content-Type: application/json" \
  -d '{"title":"Πολίτης Κέιν","runtime_minutes":119,"region":"r1"}'
curl -s -b $JAR -G "http://localhost:3001/t/my-library/collections/dvds/records" \
  --data-urlencode "q=πολιτη" | jq '.items[].data.title'
# → "Πολίτης Κέιν"   (accent-folded match)

# 6) Partial PATCH merges into existing JSON — title + region survive
curl -s -b $JAR -X PATCH "http://localhost:3001/t/my-library/collections/dvds/records/$REC_ID" \
  -H "Content-Type: application/json" -d '{"runtime_minutes":120}' | jq .data

# 7) Archive collection → reads/writes 404. Restore via PATCH archived:false.
curl -s -b $JAR -X DELETE http://localhost:3001/t/my-library/data-model/collections/dvds
curl -s -b $JAR -X PATCH http://localhost:3001/t/my-library/data-model/collections/dvds \
  -H "Content-Type: application/json" -d '{"archived":false}' | jq '{slug, archivedAt}'

# 8) Field-level archive — writes that include the archived key 400 (unknown field);
#    records keep their pre-archive values readable. Re-POSTing the same key restores it.
curl -s -b $JAR -X DELETE http://localhost:3001/t/my-library/data-model/collections/dvds/fields/genres
curl -s -b $JAR -X POST http://localhost:3001/t/my-library/data-model/collections/dvds/fields \
  -H "Content-Type: application/json" \
  -d '{"fieldKey":"genres","labelJson":{"en":"Genres","el":"Είδη"},"type":"select_many",
       "optionsJson":{"options":[{"value":"drama","label":{"en":"Drama","el":"Δράμα"}}]}}'

# 9) Quotas — `max_custom_collections`, `max_custom_fields_per_entity`,
#    `max_records_per_collection` all return 402 with the friendly upgrade payload
#    when hit. (Use a per-tenant override on `max_records_per_collection` to test
#    quickly: INSERT INTO tenant_plan_overrides ...).

# 10) Pagination via cursor + includeArchived filter
curl -s -b $JAR "http://localhost:3001/t/my-library/collections/dvds/records?limit=2"           | jq '{items: .items[].data.title, nextCursor}'
curl -s -b $JAR "http://localhost:3001/t/my-library/collections/dvds/records?includeArchived=1" | jq '.items | length'
```

### Verify billing (Stripe + manual)

The billing layer routes through a `StripeDriver` interface. In development
the `fake` driver runs entirely in-memory (no network, no credentials);
in production set `STRIPE_DRIVER=real` plus `STRIPE_API_KEY` and
`STRIPE_WEBHOOK_SECRET`. Webhook signature verification, Redis SETNX
dedupe, and the durable `stripe_webhook_events` audit log all run under
either driver — the only difference is who signs the events.

```sh
JAR=/tmp/jar.txt           # cookie jar from auth section
SLUG=my-library
TID=$(docker exec libriant-postgres psql -U libriant -d libriant_control -At \
  -c "SELECT id FROM tenants WHERE slug='$SLUG';")
SECRET='fake-webhook-secret-for-dev'  # FakeStripeDriver default

# 1) Snapshot — Starter, status=active, driver=fake, no Stripe customer yet
curl -s -b $JAR "http://localhost:3001/t/$SLUG/billing" | jq

# 2) Start checkout for Community — creates Stripe customer + returns a URL
curl -s -b $JAR -X POST "http://localhost:3001/t/$SLUG/billing/checkout" \
  -H "Content-Type: application/json" -d '{"planSlug":"community"}' | jq

# 3) Simulate Stripe webhook for customer.subscription.created (signed)
node <<'NODE' > /tmp/stripe-sub.json
const { createHmac } = require("crypto");
const secret = "fake-webhook-secret-for-dev";
const cust = `cus_fake_${process.env.TID}`;
const now = Math.floor(Date.now()/1000);
const ev = {
  id: "evt_test_"+now, type: "customer.subscription.created",
  data: { object: { id: "sub_test_"+now, customer: cust, status: "active",
    current_period_start: now, current_period_end: now + 30*86400,
    cancel_at_period_end: false, canceled_at: null,
    items: { data: [{ price: { id: "price_seed_community" } }] } } },
};
const body = JSON.stringify(ev);
const sig = createHmac("sha256", secret).update(now + "." + body).digest("hex");
console.log(JSON.stringify({ header: `t=${now},v1=${sig}`, body }));
NODE
HEADER=$(jq -r .header /tmp/stripe-sub.json)
BODY=$(jq -r .body /tmp/stripe-sub.json)
curl -s -X POST http://localhost:3001/webhooks/stripe \
  -H "stripe-signature: $HEADER" -H "Content-Type: application/json" \
  --data-binary "$BODY"
# → {"received":true}

# Tenant is now on Community. Re-delivering the same event returns deduped:true.

# 4) Adversarial: bad signature → 400
curl -i -X POST http://localhost:3001/webhooks/stripe \
  -H "stripe-signature: t=1000000000,v1=deadbeef" \
  -H "Content-Type: application/json" --data-binary '{"id":"x","type":"x","data":{}}'

# 5) Grace flow — fire invoice.payment_failed, observe past_due + graceUntil,
#    confirm effective plan is still Community within grace, drops to defaults
#    once graceUntil < NOW().
#    (Build the signed event with the same Node snippet, replacing the event
#    shape with `invoice.payment_failed` and `data.object` of the invoice form.)

# 6) Cancel at period end (Stripe-mode only)
curl -s -b $JAR -X POST "http://localhost:3001/t/$SLUG/billing/cancel" | jq '{status, cancelAtPeriodEnd}'
curl -s -b $JAR -X POST "http://localhost:3001/t/$SLUG/billing/resume" | jq '{status, cancelAtPeriodEnd}'

# 7) Customer portal — returns the fake driver's URL with a #fake_portal fragment;
#    real Stripe returns a portal session URL with a single-use token.
curl -s -b $JAR -X POST "http://localhost:3001/t/$SLUG/billing/portal" \
  -H "Content-Type: application/json" -d '{}' | jq .url

# 8) Admin: force-set a plan + manual paid-until. Step 18 will gate this
#    controller under real admin auth; for now anyone with the URL can hit
#    it (intentional, temporary seam for the drill).
curl -s -X POST "http://localhost:3001/admin/billing/tenants/$TID/set-plan" \
  -H "Content-Type: application/json" -d '{"planSlug":"on-prem-enterprise"}' | jq '.plan.slug,.status'
FUTURE=$(node -e 'console.log(new Date(Date.now()+30*86400000).toISOString())')
curl -s -X POST "http://localhost:3001/admin/billing/tenants/$TID/set-paid-until" \
  -H "Content-Type: application/json" -d "{\"paidUntil\":\"$FUTURE\"}" | jq '.paidUntil,.status'

# 9) Cross-tenant defense: a cookie from one library cannot read another
#    library's billing snapshot.
curl -i -b $JAR "http://localhost:3001/t/acme/billing"   # 403
```

**Production wiring.** Set `STRIPE_DRIVER=real`, `STRIPE_API_KEY=sk_…`,
and `STRIPE_WEBHOOK_SECRET=whsec_…` (copy from the Stripe Dashboard or
`stripe listen`). Point Stripe webhook delivery at `POST /webhooks/stripe`.
Subscribe to: `customer.subscription.{created,updated,deleted}`,
`invoice.payment_{succeeded,failed}`, and `checkout.session.completed`.

### Verify the staff UI (auth + tenant shell + dashboard)

Step 17 ships the **foundation** of the staff UI — UI primitives package,
auth pages (login + signup), tenant shell layout with sidebar nav, and a
live-data dashboard. The data-screen UIs (catalog, members, loans,
reservations, collections, billing self-serve, schema editor, help
center) are deferred to a follow-up 17b.

```sh
# Start both services
pnpm --filter @libriant/api dev  # :3001
pnpm --filter @libriant/web dev  # :3000

# 1) Locale demo still works
open http://localhost:3000/en
open http://localhost:3000/el

# 2) Sign up — fills slug from library name, server-side validation maps
#    back onto specific fields ("email already taken" → email field).
open http://localhost:3000/en/signup
# Submit lands on /en/t/<slug> with the session cookie set same-origin.

# 3) Tenant shell layout — sidebar nav, library name, sign-out button.
#    Cross-tenant URL is bounced back to the user's home.
open http://localhost:3000/en/t/<your-slug>
open http://localhost:3000/en/t/acme       # → redirects to own home

# 4) Dashboard pulls counts in parallel from /catalog/books, /members,
#    /loans?status=active, /loans?overdue=1, /reservations?status=queued,
#    /billing. Any single endpoint that fails renders "—" in its tile
#    without breaking the page.

# 5) Sign out — POST to /lbr-api/auth/logout via Next's same-origin
#    rewrite. Cookie is cleared; subsequent tenant URL → /login.

# 6) Empty-state path: brand-new tenants see an illustration + "Add your
#    first book" CTA instead of the stat grid.
```

**Same-origin proxy.** Next's `rewrites()` maps `/lbr-api/*` to the API
host so the browser never crosses an origin. Session cookies are issued
by the API but stored against the web app's origin via this proxy —
that's what makes login + tenant-redirect flows work in dev without TLS
or Caddy gymnastics. In production, the same wiring lives behind Caddy.

**Deferred (17b).** Catalog table, members table, loans checkout flow,
reservations queue UI, billing self-serve (checkout + portal buttons),
data-model editor at `/settings/data-model`, in-product help center,
onboarding wizard. All API endpoints are already live — the work is
purely UI.

### Verify the staff data screens (Step 17b)

Step 17b ships the read-only data screens — catalog, members, loans —
each backed by a shared `<DataTable>` component (server-rendered first
page + client-side load-more + search box that pushes to the URL).
Plus the **billing self-serve** page with current-plan card,
plan-comparison grid, and Stripe checkout / customer-portal / cancel
action buttons.

```sh
# Start both services (API is :3001, web is :3000)
pnpm --filter @libriant/api dev &
pnpm --filter @libriant/web dev &

# 1) Sign up via the UI proxy + seed a couple of books/members
JAR=/tmp/jar.txt && rm -f $JAR
curl -s -c $JAR -X POST http://localhost:3000/lbr-api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"slug":"my-library","libraryName":"My Library","email":"me@x.test","password":"PrivatePass2026!","fullName":"Me","defaultLocale":"en"}'

AID=$(curl -s -b $JAR -X POST http://localhost:3000/lbr-api/t/my-library/catalog/authors \
  -H "Content-Type: application/json" -d '{"fullName":"Νίκος Καζαντζάκης"}' | jq -r .id)
curl -s -b $JAR -X POST http://localhost:3000/lbr-api/t/my-library/catalog/books \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"Ζορμπάς\",\"publicationYear\":1946,\"language\":\"el\",\"authors\":[{\"authorId\":\"$AID\"}]}"
curl -s -b $JAR -X POST http://localhost:3000/lbr-api/t/my-library/members \
  -H "Content-Type: application/json" -d '{"fullName":"Μαρία Παπαδοπούλου","email":"m@x.test"}'

# 2) Pages
open http://localhost:3000/en/t/my-library/catalog
open http://localhost:3000/en/t/my-library/members
open http://localhost:3000/en/t/my-library/loans
open http://localhost:3000/en/t/my-library/billing

# 3) Greek-aware search — typing "καπεταν" (no accent) matches "Καπετάν Μιχάλης".
#    Loan filter pills + "Overdue only" toggle push state into the URL so it's
#    bookmark-able. Status filter on members likewise.

# 4) Billing — see Starter card with "You are here", then "Switch to Community"
#    triggers POST /lbr-api/t/.../billing/checkout. With STRIPE_DRIVER=fake the
#    response URL is a fake — the verification probe just confirms the request
#    fires; real Stripe would redirect the user to Checkout.
#    "Open payment portal" + "Cancel subscription" / "Resume subscription"
#    actions are wired the same way and update via router.refresh().
```

**Architecture notes.**

- The shared [`<DataTable>`](apps/web/components/DataTable.tsx) takes a
  generic row type + a `columns` array (with optional `render` functions).
  Each table's column definitions live in their own client-component
  wrapper (`CatalogTable.tsx`, `MembersTable.tsx`, `LoansTable.tsx`,
  `PlanGrid.tsx`) because Next.js refuses to ship functions across the
  server→client boundary. The server page only passes the **plain data**
  - the slug + the catalog.
- The API gained one new endpoint:
  `GET /t/:slug/billing/plans` returns active+public plans plus the
  current-plan flag so the UI can render "You are here" without a
  second round-trip.
- The Greek-aware fuzzy search is already wired end-to-end: the server
  page reads `?q=` from the URL, forwards it to the API which normalizes
  to lowercase + NFD + diacritic-strip and runs against the GIN trigram
  index. The DataTable's search input pushes back into the URL so
  pagination + filtering compose naturally.

**Shipped in 17c.** Loans checkout flow, loan detail with return / renew
/ mark-lost actions, reservations list, place-hold form, and inline
cancel / fulfill row actions — see the verification block below.

**Deferred (17d).** Data-model editor at `/settings/data-model` (drag-drop
field editor + live form preview), in-product help center at `/help` with
Postgres FTS, onboarding wizard (multi-step welcome flow), add-book +
add-member forms with custom-field rendering. All API endpoints are
already live.

### Verify the staff circulation flows (Step 17c)

Step 17c wires the **action surface** for circulation — the librarian
can now run the whole "lend a book → return it → place a hold for the
next person → hand it over" cycle from the UI without touching the API
directly. Builds on top of the read tables shipped in 17b.

```sh
# Both services running (API :3001, web :3000)
# Reuse the cookie jar from Step 17b's signup, or sign in fresh.
JAR=/tmp/jar.txt
SLUG=my-library

# Make sure the tenant is on Community (or higher) — reservations are
# plan-gated and Starter has reservations_enabled=false.
TID=$(docker exec libriant-postgres psql -U libriant -d libriant_control -At \
  -c "SELECT id FROM tenants WHERE slug='$SLUG';")
COMMUNITY=$(docker exec libriant-postgres psql -U libriant -d libriant_control -At \
  -c "SELECT id FROM plans WHERE slug='community';")
docker exec libriant-postgres psql -U libriant -d libriant_control -At \
  -c "UPDATE subscriptions SET \"planId\" = '$COMMUNITY' WHERE \"tenantId\" = '$TID';"
docker exec libriant-redis redis-cli --no-raw EVAL \
  "for _,k in ipairs(redis.call('keys','lbr:plan:*')) do redis.call('del',k) end return 'ok'" 0

# 1) Checkout — open the form
open http://localhost:3000/en/t/$SLUG/loans/new
# Type a name in the Member picker → debounced search hits /members?q=…
# Type a title in the Book picker → /catalog/books?q=…
# After picking the book we fetch /catalog/books/:id and show the
# available copies as a dropdown (any non-`available` status is hidden).
# Pick due date (defaults to today+14 from tenant_settings), optional
# notes, submit → POSTs to /loans → router.push to the loan detail page.

# 2) Loan detail — three action modals
open http://localhost:3000/en/t/$SLUG/loans/<LOAN_ID>
# "Mark returned" modal: condition (Good / Damaged) + notes.
# "Renew" modal: how many periods (each = loanPeriodDays). API enforces
# the maxRenewals cap + refuses when a hold is queued.
# "Mark lost" modal (red alertdialog): optional replacement cost in
# the tenant's currency. Creates a Fine row tied to the loan.
# All three show a success toast and refresh the page on completion.

# 3) Reservations list
open http://localhost:3000/en/t/$SLUG/reservations
# Filter pills: All active, queued, ready, fulfilled, expired, canceled,
# plus "Show / Hide resolved". Each row shows queue position (★ when ready)
# + "Hand over" (for ready) and "Cancel hold" (for queued / ready).

# 4) Place a hold
open http://localhost:3000/en/t/$SLUG/reservations/new
# Book picker + Member picker (both via the shared <Combobox>). On submit,
# toast surfaces the outcome ("Held at position N" vs "A copy was
# available — this hold is ready to pick up").

# 5) Full lifecycle drill via the UI proxy
# (a) place hold on a book that's currently on loan → outcome: queued
# (b) return that loan → API auto-promotes the hold to `ready` and the
#     row's status flips in the list (router.refresh() re-fetches)
# (c) click "Hand over" → API creates the loan from the held copy + marks
#     the reservation fulfilled — the row disappears from the default
#     (active-only) view; visible again with ?includeResolved=1.
```

**Architecture notes.**

- The shared [`<Combobox>`](apps/web/components/Combobox.tsx) is the
  workhorse: debounced API search + keyboard nav (↑/↓/Enter/Esc) + ARIA
  combobox/listbox/option roles. Both pickers in the checkout form and
  the place-hold form use it, plus any future "find an X" UI.
- All action endpoints use `router.refresh()` after success so the
  server-rendered detail / list pages re-fetch with the new state. No
  client-side cache to invalidate.
- Modals are accessible via the native `<dialog>` element — Esc handling,
  backdrop click, and focus trap are all platform-provided. The mark-lost
  modal uses `role="alertdialog"` because it's a destructive action.

### Verify add-book + add-member + onboarding (Step 17d)

Step 17d ships the **creation forms** that close the loop on the read +
action flows from 17b/17c, plus a 3-step welcome wizard that hand-holds
a fresh library through their first member and first book.

```sh
# Both services running (API :3001, web :3000)

# 1) Fresh signup — onboarding starts empty
rm -f /tmp/jar.txt
curl -s -c /tmp/jar.txt -X POST http://localhost:3000/lbr-api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"slug":"my-library","libraryName":"My Library","email":"me@x.test","password":"PrivatePass2026!","fullName":"Me","defaultLocale":"en"}'

# 2) Page sanity check
open http://localhost:3000/en/t/my-library                              # empty-state w/ onboarding CTA
open http://localhost:3000/en/t/my-library/onboarding                   # step=welcome
open http://localhost:3000/en/t/my-library/onboarding?step=member       # step=member with MemberForm
open http://localhost:3000/en/t/my-library/onboarding?step=book         # step=book with BookForm
open http://localhost:3000/en/t/my-library/onboarding?step=done         # step=done recap
open http://localhost:3000/en/t/my-library/members/new                  # standalone add-member
open http://localhost:3000/en/t/my-library/catalog/new                  # standalone add-book

# 3) Standalone forms (the wizard reuses these)
# Member form: identity / contact / custom fields blocks. Server-side
# validation errors map back onto specific inputs (email → email field).
curl -s -b /tmp/jar.txt -X POST http://localhost:3000/lbr-api/t/my-library/members \
  -H "Content-Type: application/json" \
  -d '{"fullName":"Άννα Δημητρίου","email":"anna@example.test"}' | jq '{id,memberNumber}'

# Book form: ISBN lookup pre-fills title/authors/year/publisher from
# OpenLibrary; missing authors are auto-created via the AuthorPicker
# (it also exposes inline "+ Add new author" when nothing matches).
AID=$(curl -s -b /tmp/jar.txt -X POST http://localhost:3000/lbr-api/t/my-library/catalog/authors \
  -H "Content-Type: application/json" -d '{"fullName":"Νίκος Καζαντζάκης"}' | jq -r .id)
curl -s -b /tmp/jar.txt -X POST http://localhost:3000/lbr-api/t/my-library/catalog/books \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"Ζορμπάς\",\"publicationYear\":1946,\"language\":\"el\",\"authors\":[{\"authorId\":\"$AID\",\"order\":0}]}" \
  | jq '{id,title}'

# 4) Onboarding nudge banner on dashboard
# - 0 books + 0 members → EmptyState with "Let's start" CTA
# - 0 books + ≥1 member OR ≥1 book + 0 members → blue nudge banner
# - ≥1 book + ≥1 member → no banner; stat grid renders normally
# Verified via grep on the rendered HTML — 0 lbr-banner instances when
# both present; 1 instance with the memberMissing copy when only book
# present.

# 5) Custom fields render dynamically
# Define a custom select_one field on `member` first:
curl -s -b /tmp/jar.txt -X POST http://localhost:3000/lbr-api/t/my-library/data-model/fields/member \
  -H "Content-Type: application/json" \
  -d '{"fieldKey":"membership_tier","labelJson":{"en":"Membership tier","el":"Επίπεδο μέλους"},
       "type":"select_one","required":false,
       "optionsJson":{"options":[{"value":"gold","label":{"en":"Gold","el":"Χρυσό"}},
                                   {"value":"silver","label":{"en":"Silver","el":"Ασημί"}}]}}'
# /members/new now shows that field below the standard inputs, with the
# Greek option label visible when the locale is el.
```

**Architecture notes.**

- [`<DynamicFields>`](apps/web/components/DynamicFields.tsx) is the
  workhorse that renders any custom field from the `FieldDefinitions`
  the library has set up. Each of the 10 supported types maps to an
  appropriate native input (Input, Textarea, checkbox, select, date,
  datetime-local, etc.). Labels use the locale-matched string from
  `labelJson` with sensible fallbacks. The renderer doesn't coerce
  values — it surfaces whatever the user typed so the server-side
  `validateRecordOrThrow` is the single source of truth.
- The same `<MemberForm>` and `<BookForm>` components power both the
  standalone `/members/new` + `/catalog/new` pages AND the onboarding
  wizard's individual steps. The wizard passes `returnTo` so success
  redirects back into the next wizard step instead of the entity's
  detail page.
- [`<AuthorPicker>`](apps/web/components/AuthorPicker.tsx) wraps the
  shared `<Combobox>` to deliver a "find or create author" affordance:
  the inline "+ Add `Foo`" button appears whenever the typed text doesn't
  match an existing author, POSTs to `/catalog/authors`, and immediately
  adds the new row to the selection.
- The wizard is **server-rendered with URL state** — `?step=welcome`,
  `?step=member`, `?step=book`, `?step=done`. Refresh / back-button work
  naturally, and the wizard's "done" check is computed from API counts
  rather than tracked per-user, so re-running the wizard after the fact
  shows the correct ✓ ticks.

**Shipped in 17e.** The data-model editor — see the next section.

**Deferred (17f+).** In-product help center at `/help` with Postgres FTS,
member/book detail pages with edit affordances. All API endpoints are
live; the work is purely UI.

### Verify the data-model editor (Step 17e)

Step 17e ships the **schema editor** at `/settings/data-model` — the
headline "customize your library" feature that lets a non-technical
admin add custom fields to any built-in entity (book, copy, member,
loan, reservation, fine) without ever touching the API. Two-pane layout:
the field list with drag-drop reorder + edit/archive controls on the
left, and a live `<DynamicFields>` preview of the form a librarian
would fill in on the right.

```sh
# Both services running (API :3001, web :3000)
JAR=/tmp/jar.txt
SLUG=my-library

# 1) Pages
open http://localhost:3000/en/t/$SLUG/settings                          # settings index
open http://localhost:3000/en/t/$SLUG/settings/data-model               # default tab: book
open http://localhost:3000/en/t/$SLUG/settings/data-model?entity=member # ?entity= picks the tab
open http://localhost:3000/el/t/$SLUG/settings/data-model               # full Greek translation

# 2) Add a select_one field (the typical CTA path)
# Click "+ Add a field" → label in English + Greek → type = Pick one →
# OptionsEditor adds rows {gold, silver, …} with localized labels.
# Live preview re-renders the moment you tab out of the label input.

# 3) Reorder
# Drag a row by its ⋮⋮ handle to swap with another row, OR use the
# ↑/↓ arrow buttons (keyboard-accessible alternative). Each move
# pushes a sortOrder PATCH per affected row.

# 4) Edit — fieldKey + type are intentionally read-only (safety rail
# from the plan: changing the type would invalidate existing records).
# You can still rename labels, toggle required, edit options.

# 5) Archive / restore
# DELETE archives. Archived fields hide by default; toggle the footer
# button to reveal them and click "Restore" to bring one back.
# Existing records keep their old values either way — the dynamic
# validator only enforces ACTIVE fields on writes.

# 6) End-to-end via the same proxy the UI uses
curl -s -b $JAR -X POST "http://localhost:3000/lbr-api/t/$SLUG/data-model/fields/member" \
  -H "Content-Type: application/json" \
  -d '{"fieldKey":"membership_tier",
       "labelJson":{"en":"Membership tier","el":"Επίπεδο μέλους"},
       "type":"select_one","required":false,"sortOrder":10,
       "optionsJson":{"options":[
         {"value":"gold","label":{"en":"Gold","el":"Χρυσό"}},
         {"value":"silver","label":{"en":"Silver","el":"Ασημί"}}]}}'

# Now /members/new (and the onboarding wizard's member step) shows this
# field below the standard inputs. POST a member with the new field
# populated — it round-trips through the dynamic validator and lands
# in `members.customFields`.
```

**Architecture notes.**

- The editor is a server-rendered page with a single client component
  ([`FieldEditor.tsx`](apps/web/app/[locale]/t/[slug]/settings/data-model/FieldEditor.tsx))
  that holds the field-list state. Modals (Add / Edit) live in sibling
  files and call back through `onCreated` / `onUpdated` so the parent
  list stays in sync without a full page refresh.
- Field type uses **plain-language labels** everywhere the user sees it:
  `short_text` → "Short text", `select_one` → "Pick one", `boolean` →
  "Yes / No", etc. The internal SQL/JS type only shows up in the URL
  payloads.
- The right-hand preview reuses the exact `<DynamicFields>` component
  that powers the real member/book forms. Whatever the librarian sees
  here is, byte-for-byte, what their staff sees when adding a record.
- Drag-drop uses native HTML5 events with up/down arrow buttons as the
  accessibility fallback. Reorder is optimistic — the local list moves
  instantly, then a `sortOrder` PATCH per row hits the API. On failure,
  the page refreshes to roll back.
- The fieldKey is auto-slugified from the English label until the user
  edits it manually (same pattern as the signup form's library slug).
  Server-side validation rejects collisions and bad shapes; we map
  field-specific errors back onto the right input.

### Verify member + book detail pages (Step 17f)

Step 17f closes the read+edit gap. Clicking a row in the members or
catalog tables (Step 17b) now lands on a detail page with the full
record, an "Edit" button that re-uses the existing forms in edit mode,
and per-entity action panels (status changes, archive/restore, photo
or cover upload, add-copy).

```sh
# Both services running (API :3001, web :3000)
JAR=/tmp/jar.txt
SLUG=my-library

# 1) Pages — rows on the list tables route to these
open http://localhost:3000/en/t/$SLUG/members/<MEMBER_ID>
open http://localhost:3000/en/t/$SLUG/catalog/<BOOK_ID>
open http://localhost:3000/el/t/$SLUG/members/<MEMBER_ID>   # Greek

# 2) Member detail — left pane is summary + custom fields. Right pane is
# photo, circulation (active loans / reservations / outstanding fines)
# and the actions card (Suspend / Reactivate / Archive). Each link in
# Circulation deep-links to the filtered list page.

# 3) Member edit — "Edit" swaps the page into the existing MemberForm
# pre-filled with the row's values. Empty strings round-trip as null
# (so the librarian can clear a field). Cancel link returns here.

# 4) Status actions via the same UI proxy
curl -s -b $JAR -X PUT "http://localhost:3000/lbr-api/t/$SLUG/members/$MID/status" \
  -H "Content-Type: application/json" -d '{"status":"suspended","reason":"Test"}'
curl -s -b $JAR -X PUT "http://localhost:3000/lbr-api/t/$SLUG/members/$MID/status" \
  -H "Content-Type: application/json" -d '{"status":"active"}'

# 5) Archive + restore (member)
curl -s -b $JAR -X DELETE "http://localhost:3000/lbr-api/t/$SLUG/members/$MID"        # archive
curl -s -b $JAR -X PATCH "http://localhost:3000/lbr-api/t/$SLUG/members/$MID" \
  -H "Content-Type: application/json" -d '{"archived":false}'                          # restore

# 6) Photo upload (multipart through the same-origin proxy)
curl -s -b $JAR -X POST "http://localhost:3000/lbr-api/t/$SLUG/members/$MID/photo" \
  -F "file=@/tmp/test.png;type=image/png"
# Returns { photoAssetRef: 'members/<file>.png' }. The UI renders it from
# /lbr-api/t/<slug>/storage/<ref> through the storage controller.

# 7) Book detail — bibliographic summary, custom fields, **copies table**,
# right-side cover upload + archive actions. "+ Add a copy" opens a modal
# (barcode + shelf location) that POSTs to /catalog/books/:id/copies.

# 8) Book edit — full BookForm reused in edit mode, including ISBN lookup,
# AuthorPicker and the same custom-fields renderer.

# 9) Cover upload (same shape as photo) → POST + DELETE multipart paths.

# 10) Archive + restore (book) — same DELETE → archive, PATCH archived:false
# → restore. Archive shows a friendly modal warning.
```

**Architecture notes.**

- Both `MemberForm` and `BookForm` from 17d now take an optional
  `initial` prop. When set, the form flips to **edit mode**: state inits
  from the row, submit PATCHes instead of POSTs, and cleared fields
  round-trip as `null` so the API knows to wipe them. A new `onSaved`
  callback lets the detail page swap back to view mode without a
  full page navigation. `cancelHref` overrides the default cancel link.
- Detail pages are server-rendered for the initial fetch; a single
  client component (`MemberDetail` / `BookDetail`) owns the view↔edit
  state machine and the action handlers (suspend, archive, restore,
  add-copy). Optimistic local updates plus `router.refresh()` keep the
  server-rendered shell in sync.
- Photo + cover upload bypass the typed `api()` helper because multipart
  needs the browser to set the Content-Type with its own boundary; we
  hand off `FormData` to `fetch()` with `credentials: 'include'` so the
  same-origin proxy carries the session cookie. Errors are wrapped in
  the same `ApiError` class for consistent toast handling.
- Asset URLs go through `/lbr-api/t/:slug/storage/:resourceType/:filename`
  — the existing storage controller. The same-origin proxy keeps the
  cookie travelling so a librarian without a public photo URL still
  sees the file in their browser.
- Friendly archive refusal: when DELETE on a member returns 400 with
  `{ activeLoans, activeReservations }` (Step 12's safety check), the
  toast surfaces the count rather than the raw message. Suspended /
  archived states each show their own info-banner at the top of the
  detail page so the librarian knows why they can't lend.

### Verify the in-product help center (Step 17g)

Step 17g ships the help center the plan called for: a bundled markdown
knowledge base indexed via Postgres FTS, with accent-insensitive search
for Greek and a clean reader view inside the tenant shell.

```sh
# Authors write Markdown files with YAML frontmatter:
#   locales/<lang>/help/01-getting-started.md
# Leading digits in the filename become the sortOrder (×10).

# 1) Ingest — idempotent, hashes file bytes to skip no-ops, archives the
#    DB row when the source file is removed.
pnpm ingest:help
# [help:en] upserted=4 archived=0
# [help:el] upserted=4 archived=0

# 2) API smoke
curl -s "http://localhost:3001/help/articles?locale=en" | jq '.items[].slug'
curl -s -G "http://localhost:3001/help/articles" \
  --data-urlencode "locale=el" --data-urlencode "q=κρατησεις" | jq '.items[].title'
# → "Κρατήσεις και αναμονή" first, etc. — accents not required.
curl -s "http://localhost:3001/help/articles/lending-books?locale=en" | jq '{title, locale}'

# 3) UI — sidebar gains a "Help" link; pages live under the tenant shell
open http://localhost:3000/en/t/my-library/help
open http://localhost:3000/el/t/my-library/help?q=κρατησεις
open http://localhost:3000/en/t/my-library/help/lending-books

# 4) Locale fallback: when an article is missing in your locale, the UI
#    surfaces the English version with a "we haven't translated this yet"
#    banner. Try by archiving an el row and re-fetching it as el.
docker exec libriant-postgres psql -U libriant -d libriant_control -c \
  "UPDATE help_articles SET \"archivedAt\" = NOW() WHERE slug='reservations' AND locale='el';"
curl -s "http://localhost:3001/help/articles/reservations?locale=el" | jq '{locale, title}'
# → { locale: "en", title: "Holds and reservations" }
```

**Architecture notes.**

- Articles are stored in the control-plane `help_articles` table, one row
  per (slug × locale). Markdown is converted to sanitized HTML at ingest
  time (`marked`, no user input involved), so SSR is fast and there's
  zero markdown JS in the browser bundle.
- Full-text search runs through a generated `tsvector` column populated
  by an expression on `title`/`summary`/`bodyMarkdown`/`tags`. The
  search config is **`english` for `en` rows, `simple` for everything
  else** (Postgres has no Greek dictionary), wrapped through an
  `immutable_unaccent` helper so accent-stripped queries (`κρατησεις`)
  match accented content (`Κρατήσεις`). A GIN index on the column makes
  it instant for thousands of articles.
- The `setweight` calls in the generated column put `title` at weight A,
  `summary` and `tags` at B, body at C — so a title hit ranks ahead of
  a body hit when both contain the term.
- Ingest is **idempotent**: hashes the source bytes, only upserts changed
  rows. Files that disappear between runs stamp `archivedAt = now()` so
  a librarian's bookmark gets a friendly "this article was retired"
  page rather than a 404. Re-adding the file un-archives the row.
- The UI's article search-bar pushes `?q=…` into the URL so the
  server-rendered page re-fetches against the FTS endpoint — same
  pattern as the catalog / members search inputs.

## Where we are in the plan

| Step | Description                                                                                               | Status                         |
| ---- | --------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 0    | Design system + i18n + assets foundation                                                                  | ✅ done                        |
| 1    | Repo scaffold (pnpm/turbo/tsconfig/prettier)                                                              | ✅ done                        |
| 2    | **Control-plane Prisma schema + idempotent seed**                                                         | ✅ done                        |
| 3    | Feature key catalog                                                                                       | ✅ done (in `packages/shared`) |
| 4    | **Tenant Prisma schema (catalog/members/loans/customization/audit)**                                      | ✅ done                        |
| 5    | NestJS API skeleton (health endpoints)                                                                    | ✅ done                        |
| 6    | **Tenancy layer (resolver + Prisma LRU + middleware + guard)**                                            | ✅ done                        |
| 7    | **Auth (signup with tenant provisioning + login + sessions + reset)**                                     | ✅ done                        |
| 8    | **Plan/quota system (EffectivePlan + PlanGuard + QuotaInterceptor)**                                      | ✅ done                        |
| 9    | **Schema customization (per-entity fields + custom collections + records)**                               | ✅ done                        |
| 10   | **Storage layer (driver pattern + signed URLs + quota + recompute)**                                      | ✅ done                        |
| 11   | **Catalog (authors + books + copies + ISBN lookup + covers)**                                             | ✅ done                        |
| 12   | **Members (CRUD + auto member-number + status + archive + photos)**                                       | ✅ done                        |
| 13   | **Loans (checkout / return / renew / mark-lost + overdue fines)**                                         | ✅ done                        |
| 14   | **Reservations (holds queue + auto-promote + ready-pickup + fulfill)**                                    | ✅ done                        |
| 15   | **Custom collections (records CRUD + dynamic validation + restore + search)**                             | ✅ done                        |
| 16   | **Billing (Stripe + manual + grace + webhooks + idempotency)**                                            | ✅ done                        |
| 17   | **Staff UI foundation (UI primitives + auth + tenant shell + dashboard)**                                 | ✅ done                        |
| 17b  | **Staff data screens (catalog / members / loans tables + billing self-serve)**                            | ✅ done                        |
| 17c  | **Staff circulation flows (loans checkout + return/renew/mark-lost + reservations place/cancel/fulfill)** | ✅ done                        |
| 17d  | **Add-book + add-member forms (custom-field rendering) + 3-step onboarding wizard**                       | ✅ done                        |
| 17e  | **Data-model editor (drag-drop fields + live form preview + plain-language types)**                       | ✅ done                        |
| 17f  | **Member + book detail pages (view + edit + status actions + photo/cover upload + add-copy)**             | ✅ done                        |
| 17g  | **In-product help center (markdown KB + Postgres FTS + accent-insensitive search + sidebar link)**        | ✅ done                        |
| 18   | Internal admin (plans, support, system mode, announcements)                                               | ⏳                             |
| 19   | Infra (Caddy, prod compose, GH Actions deploy)                                                            | ⏳                             |
| 20   | Tenant provisioning + relocation scripts                                                                  | ⏳                             |
