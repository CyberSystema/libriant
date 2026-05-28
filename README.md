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

### Verify the internal admin (Step 18 core)

Step 18 ships the **admin core** the plan called for: admin auth (separate
from tenant auth), a tenant list (metadata-only — actual library data
requires a redeemed support key, that's 18a), a plan editor, and a
per-tenant override editor. Support sessions, announcements, and
system-mode subsystems are 18a/18b/18c.

```sh
# 1) Bootstrap an admin (idempotent — re-running just updates fields)
CONTROL_DATABASE_URL=postgresql://libriant:libriant@localhost:5432/libriant_control \
ADMIN_BOOTSTRAP_EMAIL=owner@libriant.app \
ADMIN_BOOTSTRAP_PASSWORD=AdminBootstrapPw2026! \
ADMIN_BOOTSTRAP_NAME="Libriant Owner" \
ADMIN_BOOTSTRAP_ROLE=owner \
pnpm admin:bootstrap

# 2) API smoke — admin login, tenant list, plan + override editing
JAR=/tmp/admin-jar.txt && rm -f $JAR
curl -i http://localhost:3001/admin/tenants                                  # 401 anonymous
curl -s -c $JAR -X POST http://localhost:3001/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@libriant.app","password":"AdminBootstrapPw2026!"}'
curl -s -b $JAR http://localhost:3001/admin/auth/me                           # admin profile
curl -s -b $JAR http://localhost:3001/admin/tenants | jq '.tenants | length'
curl -s -b $JAR http://localhost:3001/admin/plans | jq '.plans[].slug'

# Bump a plan feature value — cache invalidated for every tenant on the plan
curl -s -b $JAR -X PUT http://localhost:3001/admin/plans/community/features \
  -H "Content-Type: application/json" \
  -d '{"featureKey":"max_books","valueInt":6000}'

# Set a per-tenant override
TID=$(docker exec libriant-postgres psql -U libriant -d libriant_control -At \
  -c "SELECT id FROM tenants WHERE slug='my-library';")
curl -s -b $JAR -X PUT "http://localhost:3001/admin/tenants/$TID/overrides" \
  -H "Content-Type: application/json" \
  -d '{"featureKey":"max_books","valueInt":999,"note":"Beta libraries get extras"}'

# 3) BillingAdminController is now gated — anonymous 401, with cookie 200.
curl -i http://localhost:3001/admin/billing/tenants/$TID                      # 401
curl -i -b $JAR http://localhost:3001/admin/billing/tenants/$TID              # 200

# 4) UI
open http://localhost:3000/en/admin/login          # admin sign-in
open http://localhost:3000/en/admin/tenants        # tenant list (filterable)
open http://localhost:3000/en/admin/tenants/<id>   # subscription + overrides + billing actions
open http://localhost:3000/en/admin/plans          # plan list
open http://localhost:3000/en/admin/plans/community # feature value editor
```

**Architecture notes.**

- **Auth surface is fully disjoint from the tenant flow.** A dedicated
  `AdminSessionService` signs JWTs with its own secret
  (`ADMIN_SESSION_SECRET`); the cookie is `__Host-libriant_admin` with
  `SameSite=Strict` (vs `Lax` for tenants); session TTL is 1h (vs 7d).
  A leaked tenant cookie cannot be turned into an admin cookie even if
  both secrets shared a code path.
- **AdminAuthGuard re-validates against `admin_users` on every request**
  so a disabled / locked admin is logged out instantly, not at next
  sign-in. Failed logins increment a counter and lock the account once
  it hits `MAX_FAILED_LOGINS` (15-min lockout).
- **Plan + override edits invalidate the EffectivePlan cache** for every
  affected tenant — otherwise existing tenants would keep seeing the
  old values until their cache row expires. Plan edits walk
  `subscriptions` to find every tenant on the plan; override edits hit
  the single tenant directly.
- **BillingAdminController** (the Step 16 "light-touch" admin surface)
  is now gated behind `AdminAuthGuard`. Anonymous calls 401 instead of
  mutating tenant state.
- **The admin UI lives at `/[locale]/admin/*`** with its own shell — no
  tenant sidebar, no tenant cookie. The `(authed)` route group enforces
  the auth gate so paths stay clean (`/admin/tenants` rather than
  `/admin/(authed)/tenants`). The login page is the only admin URL
  reachable without a session; it redirects authed users straight to
  `/admin/tenants`.

**Deferred (18b, 18c).**

- **18b — Announcements.** Composer + audience filters (all / by plan /
  by tag / by tenant) + in-app banners + email delivery + scheduling +
  dismissal/ack tracking.
- **18c — System mode.** Maintenance / read-only / out-of-order /
  under-construction takeover pages, scheduled windows, Caddy static
  fallback.

### Verify support access (Step 18a)

Step 18a ships the **only** path by which a Libriant admin can see a
tenant's data: the library issues a one-time `SUPPORT-XXXXXX` code with a
1h TTL; the admin redeems it with code + TOTP MFA; a 4h `SupportSession`
opens; every request during the session is audit-logged; the library can
revoke at any time and the admin's next request 401s.

```sh
# 1) Bootstrap an admin (idempotent)
CONTROL_DATABASE_URL=postgresql://libriant:libriant@localhost:5432/libriant_control \
ADMIN_BOOTSTRAP_EMAIL=owner@libriant.app \
ADMIN_BOOTSTRAP_PASSWORD=AdminBootstrapPw2026! \
pnpm admin:bootstrap

# 2) Sign the admin in and enroll MFA
JAR=/tmp/admin.txt
curl -s -c $JAR -X POST http://localhost:3001/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@libriant.app","password":"AdminBootstrapPw2026!"}'

SECRET=$(curl -s -b $JAR -X POST http://localhost:3001/admin/mfa/setup \
  -H "Content-Type: application/json" -d '{}' | jq -r .secret)
# Compute a TOTP using otplib (or paste $SECRET into any authenticator app)
TOTP=$(cd apps/api && node -e "
import('otplib').then(({generateSync})=>console.log(generateSync({secret:'$SECRET'})))")
curl -s -b $JAR -X POST http://localhost:3001/admin/mfa/verify \
  -H "Content-Type: application/json" -d "{\"code\":\"$TOTP\"}"
# → { mfaEnabled: true }

# 3) As a librarian, generate a one-time support code
LIB=/tmp/lib.txt
curl -s -c $LIB -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"lib@step18a.test","password":"librarian-pass-1234"}'
CODE=$(curl -s -b $LIB -X POST http://localhost:3001/t/step18a/support/keys \
  -H "Content-Type: application/json" -d '{}' | jq -r .code)
# Code looks like SUPPORT-7HX29P — share with the admin out-of-band.

# 4) Admin redeems with the code + a fresh TOTP
IMP=/tmp/imp.txt
TOTP=$(cd apps/api && node -e "
import('otplib').then(({generateSync})=>console.log(generateSync({secret:'$SECRET'})))")
curl -s -b $JAR -c $IMP -X POST http://localhost:3001/admin/support/redeem \
  -H "Content-Type: application/json" \
  -d "{\"code\":\"$CODE\",\"totp\":\"$TOTP\"}"
# → { session: {...}, tenant: { slug: "step18a", name: "..." } }

# 5) The impersonation cookie now grants admin access to that one tenant.
# Strip the libriant_admin cookie to prove the impersonation cookie alone
# is the credential downstream:
grep -v libriant_admin $IMP > /tmp/imp-only.txt
curl -s -b /tmp/imp-only.txt http://localhost:3001/t/step18a/catalog/books  # 200
curl -s -b /tmp/imp-only.txt http://localhost:3001/t/acme/catalog/books     # 403 — wrong tenant
curl -s http://localhost:3001/t/step18a/catalog/books                       # 401 — no cookie

# 6) Plan + quota are bypassed under impersonation. Confirm by forcing a
# tenant override of max_books=0 then creating one under each identity.
docker exec libriant-postgres psql -U libriant -d libriant_control -c "
INSERT INTO tenant_plan_overrides (id, \"tenantId\", \"featureKey\", \"valueInt\",
  note, \"createdAt\", \"updatedAt\")
VALUES (gen_random_uuid()::text,
  (SELECT id FROM tenants WHERE slug='step18a'),
  'max_books', 0, 'Drill', now(), now())
ON CONFLICT (\"tenantId\", \"featureKey\") DO UPDATE
  SET \"valueInt\"=EXCLUDED.\"valueInt\", \"updatedAt\"=now();"
docker exec libriant-redis redis-cli FLUSHDB  # bust EffectivePlan cache

curl -s -b $LIB           -X POST http://localhost:3001/t/step18a/catalog/books \
  -H "Content-Type: application/json" -d '{"title":"Blocked"}'      # 402
curl -s -b /tmp/imp-only.txt -X POST http://localhost:3001/t/step18a/catalog/books \
  -H "Content-Type: application/json" -d '{"title":"Bypassed"}'     # 201

# 7) Library revokes the active session → admin is kicked.
curl -s -b $LIB -X DELETE http://localhost:3001/t/step18a/support/sessions/active
curl -s -b /tmp/imp-only.txt http://localhost:3001/t/step18a/catalog/books  # 401

# 8) Audit log lists every action during the session, with reason on end.
curl -s -b $LIB http://localhost:3001/t/step18a/support/sessions/log | jq '.sessions[0] | {endedReason, actions: .actions[:3]}'
```

**Architecture notes.**

- **Three separate cookies, three separate secrets, three separate
  `SameSite` policies.** `__Host-libriant_session` (tenant, `Lax`, 7d),
  `__Host-libriant_admin` (admin, `Strict`, 1h), and
  `__Host-libriant_imp` (impersonation, `Strict`, 4h). The impersonation
  JWT carries an `imp: true` sentinel claim that distinguishes it from
  the admin JWT, and it's signed with `IMPERSONATION_SECRET` — distinct
  from both tenant and admin secrets — so a leaked admin cookie cannot
  be turned into an impersonation cookie.
- **MFA is mandatory for redemption.** Each admin's TOTP secret is
  AES-256-GCM-encrypted with a 32-byte master key (`MFA_MASTER_KEY`,
  64 hex chars); the DB columns are `mfaSecretCipher` (ciphertext + 16-byte
  auth tag), `mfaNonce` (12-byte GCM nonce per row, never reused), and
  `mfaKeyId` (label for future key rotation). Enroll is a two-step
  setup→verify dance; we only persist + flip `mfaEnabled=true` once the
  admin's authenticator has typed back a correct code.
- **Support codes are bcrypt-hashed.** Format `SUPPORT-XXXXXX` (4-char
  prefix + 6-char body) from a 32-char alphabet that excludes
  visually-ambiguous chars (no `O`, `0`, `I`, `1`). The prefix is stored
  in plaintext to narrow the bcrypt search to a tiny candidate set; the
  body is bcrypt(cost 12). Plaintext is returned **once** on generate,
  never persisted, never logged, never echoed in audit entries.
- **One pending key, one active session per tenant.** Generating a new
  key revokes the previous pending one in the same transaction; opening
  a new session ends any existing active one for the tenant.
- **Library revoke is instant.** `ImpersonationMiddleware` doesn't trust
  the JWT alone — it loads the `SupportSession` row on every impersonated
  request and only attaches `req.impersonation` when `endedAt IS NULL`,
  `expiresAt > now()`, and the cookie's `(adminId, tenantId, sessionId)`
  matches the row. So `DELETE /t/:slug/support/sessions/active` flips
  the row and the admin's next request 401s — no token revocation list,
  no race window.
- **TenantGuard + PlanGuard + QuotaInterceptor all short-circuit when
  `req.impersonation` is set.** `TenantGuard` checks the URL slug
  matches the impersonation's tenant (else 403); `PlanGuard` returns
  `true`; `QuotaInterceptor` skips the usage check. The `Customization`
  module's `QuotaService` (called directly from collection/custom-field
  services) is **not** bypassed at MVP — the per-tenant override editor
  is the documented escape hatch there.
- **SupportAuditInterceptor is a global APP_INTERCEPTOR.** It only writes
  a `supportActionLog` row when `req.impersonation` is set, so normal
  requests pay no audit cost. Writes are non-blocking — a failed audit
  row never fails the request ("prefer 'request completed but no audit
  row' over 'request failed because audit row failed'").
- **Out of MVP, hooks in place.** Email notifications, before/after
  diffs (needs Prisma middleware), redemption rate limiting (schema
  `SupportRedemptionAttempt` already records every attempt), and an
  auto-expiry sweeper job are all deferred with TODOs in code.

### Verify announcements (Step 18b)

Step 18b ships the platform-wide announcements subsystem: admin composes

- targets a message, libraries receive it as in-app banners (and email
  through an outbox stub), users dismiss or acknowledge, admin sees live
  delivery stats. Audience filter supports four shapes: **all**, specific
  **tenant_ids**, **plan_slugs**, and tenant **tags** (a `tags TEXT[]`
  column on tenants, editable from the admin tenant detail page).

```sh
# 1) Admin login (re-using the 18a admin)
JAR=/tmp/admin.txt
curl -s -c $JAR -X POST http://localhost:3001/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@libriant.app","password":"AdminBootstrapPw2026!"}'

# 2) Librarian login (any signed-in user under a tenant works)
LIB=/tmp/lib.txt
curl -s -c $LIB -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"slug":"step18a","email":"lib@step18a.test","password":"librarian-pass-1234"}'

# 3) Empty by default
curl -s -b $LIB http://localhost:3001/t/step18a/announcements/active
# → {"announcements":[]}

# 4) Create an info announcement targeting all active libraries
ID=$(curl -s -b $JAR -X POST http://localhost:3001/admin/announcements \
  -H "Content-Type: application/json" \
  -d '{
    "title":"Welcome", "bodyMarkdown":"Click dismiss when done.",
    "severity":"info", "audience":{"all":true},
    "deliverInApp":true, "deliverEmail":false,
    "dismissible":true, "requiresAck":false
  }' | jq -r .announcement.id)

# 5) Librarian now sees it; the delivery row gets materialized on first fetch
curl -s -b $LIB http://localhost:3001/t/step18a/announcements/active | jq '.announcements[0] | {title, severity, deliveryScope}'
# → { "title": "Welcome", "severity": "info", "deliveryScope": "tenant" }

# 6) Stats are computed live: targetTenantCount is the audience-match count
#    against current tenant rows; deliveryCount is the historical materialized rows.
curl -s -b $JAR http://localhost:3001/admin/announcements/$ID/stats | jq .stats

# 7) Tag a tenant from the admin side + target by tag.
TID=$(docker exec libriant-postgres psql -U libriant -d libriant_control -At \
  -c "SELECT id FROM tenants WHERE slug='step18a';")
curl -s -b $JAR -X PUT http://localhost:3001/admin/tenants/$TID/tags \
  -H "Content-Type: application/json" -d '{"tags":["beta"]}'
# → tags saved AND TenantResolver cache invalidated so the next request
#   sees the new tags array (otherwise the 5-min tenant context cache
#   would mask the update).

curl -s -b $JAR -X POST http://localhost:3001/admin/announcements \
  -H "Content-Type: application/json" \
  -d '{
    "title":"Beta cohort note", "bodyMarkdown":"Beta-only message.",
    "severity":"warning", "audience":{"tags":["beta"]},
    "deliverInApp":true, "deliverEmail":false,
    "dismissible":true, "requiresAck":false
  }'

# 8) Critical announcement that requires ack — per-user delivery row, modal-blocked UI.
ACK=$(curl -s -b $JAR -X POST http://localhost:3001/admin/announcements \
  -H "Content-Type: application/json" \
  -d "{
    \"title\":\"Action required\", \"bodyMarkdown\":\"Please review.\",
    \"severity\":\"critical\", \"audience\":{\"tenant_ids\":[\"$TID\"]},
    \"deliverInApp\":true, \"deliverEmail\":true,
    \"dismissible\":false, \"requiresAck\":true
  }" | jq -r .announcement.id)

# Library can't dismiss it — must acknowledge.
curl -s -b $LIB -X POST http://localhost:3001/t/step18a/announcements/$ACK/dismiss \
  -H "Content-Type: application/json" -d '{}'
# → {"message":"This announcement cannot be dismissed.","statusCode":404}
curl -s -b $LIB -X POST http://localhost:3001/t/step18a/announcements/$ACK/ack \
  -H "Content-Type: application/json" -d '{}'
# → {"acknowledgedAt":"..."}

# 9) Adversarial — empty audience and unknown shape are rejected at the API.
curl -s -b $JAR -X POST http://localhost:3001/admin/announcements \
  -H "Content-Type: application/json" \
  -d '{"title":"x","bodyMarkdown":"x","severity":"info",
       "audience":{"tags":[]},"deliverInApp":true,"deliverEmail":false,
       "dismissible":true,"requiresAck":false}'
# → 400 "Pick at least one tag when targeting by tag."

# 10) Lifecycle — expire, archive, list each tab.
curl -s -b $JAR -X POST http://localhost:3001/admin/announcements/$ID/expire \
  -H "Content-Type: application/json" -d '{}'
curl -s -b $JAR -X DELETE http://localhost:3001/admin/announcements/$ID
curl -s -b $JAR 'http://localhost:3001/admin/announcements?status=archived' | jq '.announcements | length'

# 11) UI
open http://localhost:3000/en/admin/announcements           # list, severity-filtered
open http://localhost:3000/en/admin/announcements/new       # composer (audience picker)
open http://localhost:3000/en/admin/announcements/$ACK      # detail + stats + actions
open http://localhost:3000/en/admin/tenants/$TID            # tag editor card
open http://localhost:3000/en/t/step18a                     # banner + critical-ack modal
```

**Architecture notes.**

- **Audience is a typed discriminated union** stored in the DB as
  `audience_filter JSONB`. Four shapes — `{ all: true }`, `{ tenant_ids
}`, `{ plan_slugs }`, `{ tags }` — match the plan verbatim. Adding a
  fifth (e.g. `{ regions }`) is a switch-arm change in
  `audience.ts:audienceFromJson` plus a corresponding case in the
  service's resolver / matcher.
- **Lazy delivery materialization** rather than an upfront scheduled
  worker. The first time a user on a matching tenant fetches the active
  set, we INSERT the `announcement_deliveries` row with
  `deliveredInAppAt` (and `deliveredEmailAt` if `deliverEmail`). That
  gives accurate "delivered to N" stats without standing up a BullMQ
  job; the trade-off is the stats lag until the first paint per tenant.
  An upfront materializer can be bolted on later with no API changes.
- **`(announcementId, tenantId) WHERE userId IS NULL` partial unique
  index** added in a follow-up migration. The base
  `(announcementId, tenantId, userId)` constraint doesn't prevent
  duplicate tenant-wide rows because Postgres BTREE treats NULL userIds
  as distinct. Without the partial unique, two concurrent first-fetches
  by different users on the same tenant could race-create duplicate
  rows. The service additionally race-tolerates via lookup-then-insert
  with re-read on conflict.
- **Per-(tenant, user) Redis cache for the active set**, 60 s TTL — as
  the plan called for. Cache key:
  `lbr:announcements:active:<tenantId>:<userId>`. The admin endpoints
  (create / update / expire / archive) resolve the live audience and
  bust each matched tenant's keys via SCAN; the tag editor also busts
  the TenantResolver cache so a freshly-tagged tenant sees newly-matching
  announcements without waiting for the 5-min tenant context TTL.
- **Severity → behavior is enforced server-side AND client-side.**
  Server: dismiss endpoint 404s when the announcement is not
  `dismissible`; ack endpoint 404s when it doesn't require ack. Client:
  `info` / `warning` render as dismissible banners; `critical` without
  ack is sticky no-dismiss; `critical + requiresAck` renders as a
  full-screen modal blocking the rest of the UI until the current user
  acknowledges. Per-user delivery rows for ack so each user sees + acks
  their own copy.
- **Banner is gated on `session && !impersonation`.** Admins viewing a
  tenant via support session don't fetch or render announcements — they
  hold the impersonation cookie, not a librarian session, and the
  delivery model is keyed on `users.id` which doesn't exist for
  `admin_users`.
- **Email delivery is a stub** (`EmailOutboxService.enqueue`) — logs
  what _would_ go out but never opens a connection. Drop in a real
  Postmark / SES / SMTP driver later by replacing one file. The
  `deliveredEmailAt` column is set regardless when the stub returns
  success, so stats look correct end-to-end.
- **Tag changes invalidate two caches.** The PUT /tags endpoint busts
  (a) the TenantResolver cache, since `tags` is baked into the
  `TenantContext` attached by `TenantMiddleware`; and (b) the
  per-tenant announcement active set, since the new tag set can pull
  the tenant into or out of an audience. Single endpoint, both buckets.
- **Out of MVP, hooks in place.** Upfront delivery materialization
  worker (BullMQ + cron at `publishAt`), real email driver, per-user
  notification-panel "previously dismissed" view, and a pre-window
  announcement auto-suggester linked from 18c are deferred with TODOs
  in code.

### Verify system mode (Step 18c)

Step 18c ships a first-class **system-mode** state controlled from the
admin UI: `maintenance` (full takeover), `read_only` (mutations 503),
`out_of_order` (emergency outage takeover), and `under_construction`
(banner only). Scope is **global** or **per-tenant**; per-tenant wins
when stricter. Scheduling resolves at read-time — no BullMQ worker
needed, no flapping. Caddy ships with a static `maintenance.html`
fallback so the edge can serve a polished page even when the API is
fully down.

```sh
# 1) Admin login (re-using the 18a admin)
JAR=/tmp/admin.txt
curl -s -c $JAR -X POST http://localhost:3001/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@libriant.app","password":"AdminBootstrapPw2026!"}'

# 2) Librarian login
LIB=/tmp/lib.txt
curl -s -c $LIB -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"slug":"step18a","email":"lib@step18a.test","password":"librarian-pass-1234"}'

# 3) Public + always-allowed routes
curl -i http://localhost:3001/system-mode/current   # 200 — always allowed
curl -i http://localhost:3001/healthz               # 200 — always allowed
# Every response carries x-system-mode + x-system-mode-source headers
# (and x-system-mode-ends-at when set) — useful for SSR layouts that
# want to render banners without a second fetch.

# 4) read_only — GETs pass, mutations 503
EID=$(curl -s -b $JAR -X POST http://localhost:3001/admin/system-mode/global \
  -H "Content-Type: application/json" \
  -d '{"mode":"read_only","messageMarkdown":"DB migration."}' | jq -r .event.id)
curl -i -b $LIB http://localhost:3001/t/step18a/catalog/books   # 200
curl -i -b $LIB -X POST http://localhost:3001/t/step18a/catalog/books \
  -H "Content-Type: application/json" -d '{"title":"Blocked"}'
# → 503 { reason: "read_only", message: "...", expectedEndsAt: null, mode, source }
curl -s -b $JAR -X POST http://localhost:3001/admin/system-mode/events/$EID/end -d '{}'

# 5) maintenance — full block, admin paths still work, healthz still works
EID=$(curl -s -b $JAR -X POST http://localhost:3001/admin/system-mode/global \
  -H "Content-Type: application/json" \
  -d '{"mode":"maintenance"}' | jq -r .event.id)
curl -i -b $LIB http://localhost:3001/t/step18a/catalog/books         # 503
curl -i -b $LIB http://localhost:3001/auth/me                         # 503
curl -i      http://localhost:3001/healthz                            # 200
curl -i      http://localhost:3001/system-mode/current                # 200
curl -i -b $JAR http://localhost:3001/admin/tenants                   # 200 (bypass on)
curl -s -b $JAR -X POST http://localhost:3001/admin/system-mode/events/$EID/end -d '{}'

# 6) out_of_order WITH allowAdminBypass=false — lockout test.
# Normal admin endpoints are blocked, but /admin/system-mode/* is in
# ALWAYS_PASS so the operator can never lock themselves out of the lever
# they need to recover.
EID=$(curl -s -b $JAR -X POST http://localhost:3001/admin/system-mode/global \
  -H "Content-Type: application/json" \
  -d '{"mode":"out_of_order","allowAdminBypass":false}' | jq -r .event.id)
curl -i -b $JAR http://localhost:3001/admin/tenants            # 503 — blocked
curl -i -b $JAR http://localhost:3001/admin/system-mode/current # 200 — escape hatch
curl -s -b $JAR -X POST http://localhost:3001/admin/system-mode/events/$EID/end -d '{}'

# 7) Per-tenant — isolate one library without touching global state.
TID=$(docker exec libriant-postgres psql -U libriant -d libriant_control -At \
  -c "SELECT id FROM tenants WHERE slug='step18a';")
EID=$(curl -s -b $JAR -X POST http://localhost:3001/admin/system-mode/tenants/$TID \
  -H "Content-Type: application/json" \
  -d '{"mode":"read_only","messageMarkdown":"Migrating cells."}' | jq -r .event.id)
curl -s 'http://localhost:3001/system-mode/current?slug=step18a' | jq '.mode.mode,.mode.source'
# → "read_only", "tenant"
curl -s 'http://localhost:3001/system-mode/current?slug=acme'    | jq '.mode.mode,.mode.source'
# → "normal", "default"
curl -i -b $LIB -X POST http://localhost:3001/t/step18a/catalog/books \
  -H "Content-Type: application/json" -d '{"title":"Blocked per-tenant"}'   # 503
curl -s -b $JAR -X POST http://localhost:3001/admin/system-mode/events/$EID/end -d '{}'

# 8) Stricter-wins — global read_only + tenant maintenance → tenant wins.
GID=$(curl -s -b $JAR -X POST http://localhost:3001/admin/system-mode/global \
  -H "Content-Type: application/json" -d '{"mode":"read_only"}' | jq -r .event.id)
TENT=$(curl -s -b $JAR -X POST http://localhost:3001/admin/system-mode/tenants/$TID \
  -H "Content-Type: application/json" -d '{"mode":"maintenance"}' | jq -r .event.id)
curl -s 'http://localhost:3001/system-mode/current?slug=step18a' | jq '.mode'
# → mode: maintenance, source: tenant
curl -s 'http://localhost:3001/system-mode/current?slug=acme' | jq '.mode'
# → mode: read_only, source: global
curl -s -b $JAR -X POST http://localhost:3001/admin/system-mode/events/$GID/end -d '{}'
curl -s -b $JAR -X POST http://localhost:3001/admin/system-mode/events/$TENT/end -d '{}'

# 9) Active support session bypasses maintenance (admin debugging the outage).
# (see Step 18a verification for the full key/redeem flow)

# 10) Scheduling — future window, list scheduled, cancel
FUTURE=$(date -u -v +2H +"%Y-%m-%dT%H:%M:%SZ")  # macOS
EID=$(curl -s -b $JAR -X POST http://localhost:3001/admin/system-mode/global \
  -H "Content-Type: application/json" \
  -d "{\"mode\":\"maintenance\",\"startsAt\":\"$FUTURE\"}" | jq -r .event.id)
curl -s 'http://localhost:3001/system-mode/current' | jq '.mode.mode'  # → "normal"
curl -s -b $JAR 'http://localhost:3001/admin/system-mode/scheduled' | jq '.scheduled | length'
curl -s -b $JAR -X DELETE http://localhost:3001/admin/system-mode/events/$EID   # 204

# 11) Adversarial — mode=normal rejected, unknown mode rejected
curl -i -b $JAR -X POST http://localhost:3001/admin/system-mode/global \
  -H "Content-Type: application/json" -d '{"mode":"normal"}'              # 400
curl -i -b $JAR -X POST http://localhost:3001/admin/system-mode/global \
  -H "Content-Type: application/json" -d '{"mode":"super-broken"}'        # 400

# 12) UI
open http://localhost:3000/en/admin/system-mode            # admin panel
open http://localhost:3000/en/admin/tenants/$TID           # tenant mode panel
# Then open a global maintenance window from the panel above and visit:
open http://localhost:3000/en/t/step18a                    # branded takeover page
```

**Architecture notes.**

- **Resolution is read-time, not scheduled.** The active query is
  `endedAt IS NULL AND startsAt <= now() AND (endsAt IS NULL OR endsAt > now())`.
  Scheduled windows automatically become active when the clock rolls
  past their `startsAt`. No worker means no race (worker dies → mode
  never flips), no flapping at the boundary, and windows can be planned
  hours / days / weeks in advance with zero standing infrastructure.
- **Severity ordering for "stricter wins":** `normal (0) < under_construction (1) < read_only (2) < out_of_order (3) = maintenance (3)`.
  When both a global and a per-tenant event are active, the higher
  severity wins; equal severities tie-break to the per-tenant event
  (more specific). `out_of_order` and `maintenance` share enforcement
  but ship different branded copy.
- **Middleware order matters.** `SystemModeMiddleware` runs **after**
  Session / Admin / Impersonation (so it can trust `req.impersonation`)
  but **before** TenantMiddleware (so a maintenance event stops the
  request before any tenant DB pool warms up). `forRoutes('*')` rewrites
  Express's `req.path` to `/`, so the middleware reads `req.originalUrl`
  for path matching — this is exactly the kind of NestJS detail that
  silently misroutes a wildcard middleware if you don't know about it.
- **Two layers of always-allowed paths.** `ALWAYS_PASS` (no gate at all)
  covers `/healthz`, `/readyz`, `/metrics`, `/system-mode/*`,
  **`/admin/system-mode/*`**, and `/admin/auth/*` — the operator can
  never lock themselves out of the lever they need to recover, even if
  they set `allowAdminBypass=false`. `ADMIN_BYPASS` (gated by the
  event's flag) covers the rest of `/admin/*` and `/auth/admin/*` for
  the normal case.
- **Active support sessions bypass.** A Libriant admin holding a live
  impersonation cookie (validated against the DB by
  `ImpersonationMiddleware`) gets through maintenance / read_only /
  out_of_order — they're the person debugging the outage and need the
  library reachable. Cutting them off would be hostile.
- **Redis cache per scope, 30 s TTL, busted on admin writes.** Cache
  keys: `lbr:system_mode:global` and `lbr:system_mode:tenant:<id>`.
  Every admin mutation (open / end / cancel) busts the relevant key
  immediately; the short TTL is belt-and-braces if the bust call ever
  drops a key. Reads survive a control-plane DB blip for up to 30 s.
- **Per-request response headers** (`x-system-mode`, `x-system-mode-source`,
  optionally `x-system-mode-ends-at`) on every API response. SSR layouts
  that already fetched something can read the header without a second
  round-trip; the dedicated `GET /system-mode/current` endpoint stays
  for cold loads and the public takeover-page case.
- **Caddy static fallback.** [`infra/caddy/maintenance.html`](infra/caddy/maintenance.html)
  is the brand-aware page Caddy can serve directly when the NestJS app
  is fully down (envvar toggle in the Caddyfile, to land with Step 19).
  Inline CSS, no external assets, dark-mode aware — works as a 502
  fallback even without ACME running.
- **Out of MVP, hooks in place.** BullMQ window-boundary worker for
  side effects (e.g. announce-on-start), pre-window auto-suggestion of
  an 18b announcement at scheduling time, "Notify me when it's back"
  email capture on the takeover page, and i18n of the takeover copy
  are all deferred with TODOs.

### Verify the production infra (Step 19)

Step 19 ships the production topology: Caddy at the edge (TLS via ACME),
api + web + worker behind it on a private docker network, Postgres +
PgBouncer + Redis on the same network, the hot-swap `/assets/` bind
mount, and a static `maintenance.html` fallback that survives a full
app outage. GitHub Actions builds + pushes images to GHCR and rolls them
to every host in [`infra/deploy/fleet.yml`](infra/deploy/fleet.yml); a
nightly [`scripts/backup.sh`](scripts/backup.sh) captures Postgres +
storage to disk and optionally rclone-syncs them off-host.

```sh
# 1) Build images locally to validate the Dockerfiles end-to-end.
docker build -f apps/api/Dockerfile -t libriant-api:test .
docker build -f apps/web/Dockerfile -t libriant-web:test .

# 2) Boot the prod stack against an isolated env file. Compose's variable
# interpolation refuses to start if any required secret is missing, so
# `:?` errors here mean the .env.prod is incomplete — that's by design.
cp .env.prod.example /srv/libriant/.env.prod    # then fill in the blanks
( set -a; source /srv/libriant/.env.prod; set +a; \
  docker compose -f infra/compose/docker-compose.prod.yml up -d )

# 3) Health probes (every service has the same contract):
curl -fs https://libriant.app/healthz              # Caddy → web
curl -fs https://libriant.app/lbr-api/healthz      # Caddy → api
docker compose -f infra/compose/docker-compose.prod.yml \
  exec worker wget -qO- http://localhost:3002/healthz
# Readiness fans out: web /api/readyz round-trips to api /readyz, which
# pings Redis + the control DB. Either dependency down → 503.
curl -is https://libriant.app/api/readyz
curl -is https://libriant.app/lbr-api/readyz

# 4) Prometheus metrics (text exposition; same contract on all three).
curl -s https://libriant.app/api/metrics      | head -6
curl -s https://libriant.app/lbr-api/metrics  | head -6
docker compose -f infra/compose/docker-compose.prod.yml \
  exec worker wget -qO- http://localhost:3002/metrics | head -6

# 5) Static-page fallback. Flip MAINTENANCE_HARD=true and reload caddy;
# even with api + web killed, Caddy serves the brand-aware page.
MAINTENANCE_HARD=true docker compose -f infra/compose/docker-compose.prod.yml \
  up -d --force-recreate caddy
curl -is https://libriant.app/ | head -8     # 200 with X-Maintenance: hard
# /healthz still passes through so the load balancer doesn't pull the host.
curl -is https://libriant.app/healthz | head -4

# 6) Asset hot-swap (still works under prod compose — the assets/ folder
# is bind-mounted into Caddy + web + api as a single read-only volume).
echo "<svg ...>...</svg>" > assets/brand/logo.svg
curl -I https://libriant.app/_assets/brand/logo.svg     # ETag updates

# 7) Backup drill. Runs against the live compose project; idempotent on
# the same day.
COMPOSE_PROJECT_NAME=libriant ./scripts/backup.sh
ls /srv/libriant/backups/$(date +%Y%m%d)/
# → postgres.sql.gz storage.tar.gz caddy-logs.tar.gz manifest.txt

# 8) Deploy drill — push to GHCR + roll the fleet. The workflow runs
# from CI, but you can dry-run locally with `act`:
act push -W .github/workflows/deploy.yml --container-architecture linux/amd64
```

**Architecture notes.**

- **Caddy is the only service with host ports.** 80 + 443 + UDP 443
  (HTTP/3). Everything else lives on the internal `app` docker network;
  Postgres / Redis / API / worker are unreachable from outside the host.
  When this graduates to multi-host (Stage 2), the LB takes over the
  edge role and Caddy moves to per-node.
- **`tsx` in production.** The API runs under `tsx` instead of compiled
  JavaScript because pnpm workspace packages export their TypeScript
  source directly (`main: ./src/index.ts`). The trade-off is a ~30 MB
  larger image; the win is a build pipeline that mirrors `pnpm dev`
  exactly, and zero per-request compile cost after warm-up.
- **Worker is the same image as api, different command.** Adding
  background jobs is a code change, not an ops change. The current
  worker is intentionally minimal — its `/healthz`, `/readyz`, and
  Prometheus `/metrics` endpoints exist so the contract is stable while
  the BullMQ queues (18a sweeper, 18b email outbox, 18c window-boundary
  effects) land over the next steps.
- **Same health contract across all three.** `/healthz` (liveness),
  `/readyz` (dependency check; for api → DB + Redis, for web →
  round-trip to api, for worker → liveness), `/metrics` (Prometheus
  text exposition). One probe shape no matter which service or which
  orchestrator picks it up.
- **`assets/` and `locales/` are bind-mounted read-only into multiple
  services.** Designers can replace `assets/brand/logo.svg` on the host
  and every container sees the change instantly — same hot-swap drill
  as the Step 0 release gate, just inside the prod stack now.
- **Belt-and-braces static maintenance.** [`infra/caddy/maintenance.html`](infra/caddy/maintenance.html)
  ships in the Caddyfile via a host bind-mount, gated by
  `$MAINTENANCE_HARD`. Even if the entire NestJS app is down, browsers
  get a polished page (and Caddy's 502 templates never surface to
  users).
- **Deploy targets a "fleet," not a host.** [`infra/deploy/fleet.yml`](infra/deploy/fleet.yml)
  lists hosts; the workflow fans out across them with `fail-fast: false`
  so one cell failing doesn't roll back others — the cells are
  independent by design. Today the list has one entry; growth = append.
- **Backups are atomic per-day.** [`scripts/backup.sh`](scripts/backup.sh)
  writes everything under `$BACKUP_ROOT/YYYYMMDD/`, prunes anything
  older than `$BACKUP_KEEP_DAYS` (default 14), and optionally
  rclone-mirrors off-host. Re-running on the same day is a no-op
  (idempotent overwrite), so a missed cron + manual catch-up is safe.
- **Out of MVP, hooks in place.** Wildcard TLS for `*.libriant.app`
  (commented Caddyfile block with a DNS-01 challenge — needs a provider
  plugin), multi-region cell routing, OpenTelemetry traces, and a real
  Prometheus + Grafana stack are all deferred. The metrics endpoints
  already exist so a scraper can attach to today's deployment.

### Verify provisioning + relocation (Step 20)

Step 20 ships the operator tooling for the tenant lifecycle: provision a
brand-new library outside the self-serve signup, fan migrations out
across every existing tenant DB, move a tenant's DB between cells with
read-only-mode + cache bust, and move a tenant's files between storage
backends. All four scripts live under [`scripts/`](scripts/) and shell
in via pnpm.

```sh
# 1) Admin provisioning — full control over plan, billing mode, cell,
# initial owner. Idempotent on slug; rolls back the physical DB if the
# control-plane TX fails after CREATE DATABASE.
CONTROL_DATABASE_URL=postgresql://libriant:libriant@localhost:5432/libriant_control \
PG_SUPERUSER_URL=postgresql://libriant:libriant@localhost:5432/libriant_control \
STORAGE_ROOT=/srv/libriant/storage \
  pnpm tenant:create \
    --slug=step20test \
    --name='Step 20 Test Lib' \
    --owner-email=ops@step20.test \
    --owner-name='Step 20 Owner' \
    --owner-password='change-me-please-12' \
    --plan=starter \
    --billing-mode=manual \
    --dry-run                       # validate inputs without provisioning
# → [tenant-create] plan="starter" billingMode=manual cell=cell-eu-1 dryRun=true
# → [tenant-create] dry run: validation passed; not provisioning.

# Drop --dry-run to actually create. Output ends with:
#   [tenant-create] done. tenant.id=… slug=step20test
#   [tenant-create]   dbUrl=postgresql://libriant:***@localhost:5432/tenant_…
#   [tenant-create]   storageUrl=file:///srv/libriant/storage/…
#   [tenant-create]   ⚠  generated owner password (record it now): …   (if --owner-password omitted)

# Adversarial — every refusal exits non-zero:
pnpm tenant:create --slug=step20test ...   # slug already used → 1
pnpm tenant:create --slug='Bad-Slug-!' ... # slug regex fails → 1
pnpm tenant:create --plan=nonexistent ...  # unknown plan → 1
pnpm tenant:create --owner-password=short  # < 12 chars → 1

# 2) Fan-out migrations across every tenant. Default --concurrency=1, but
# go higher when you have lots of tenants — local 15-tenant drill drops
# from ~10s @ 1 to ~3s @ 4.
pnpm tenant:migrate                          # all active tenants
pnpm tenant:migrate -- --only=acme,step18a   # specific slugs
pnpm tenant:migrate -- --include-archived    # also migrate archived
pnpm tenant:migrate -- --dry-run             # list, don't migrate
pnpm tenant:migrate -- --concurrency=4
# Per-row outcomes printed at the end:
#   [tenant-migrate]   acme         ✓ up to date
#   [tenant-migrate]   step18a      ✓ 1 applied
#   [tenant-migrate]   broken       ✗ P3009 — database not reachable
#   [tenant-migrate] done. 14 ok, 1 failed.    (exit 2 when any failed)

# 3) Cell-to-cell DB relocation. Dry-run prints the plan; the real run
# opens a per-tenant `read_only` window, pg_dumps the source, pg_restores
# to the destination, verifies, updates tenants.db_url + cell_id, busts
# the TenantResolver Redis cache, and closes the window. Failures leave
# the tenant on the source DB and the read_only window open for inspection.
REDIS_URL=redis://localhost:6379 \
  pnpm tenant:relocate -- \
    --tenant=acme \
    --to-db-url='postgresql://libriant:pw@cell-02.lan:5432/' \
    --to-cell=cell-02 \
    --dry-run
# After verifying the new home is healthy, drop the old database:
pnpm tenant:relocate -- --tenant=acme --drop-source

# 4) Storage migration. Same lifecycle — read_only window + verify + cache
# bust. Today: file:// ↔ file:// only; s3:// / smb:// throw "not
# implemented" with the wiring already in place.
pnpm storage:migrate -- \
  --tenant=acme \
  --to-storage-url='file:///srv/libriant-2/storage/<tenant-id>' \
  --dry-run
# Real run reports:
#   [storage-migrate] opened read_only window event=…
#   [storage-migrate] rsync -a → destination…
#   [storage-migrate] verifying byte counts match…
#   [storage-migrate] updating control plane (storage_url)…
#   [storage-migrate] busting TenantResolver cache…
#   [storage-migrate] closing read_only window…
```

**Architecture notes.**

- **Standalone scripts, not API endpoints.** Each script imports
  `@libriant/db-control` directly and uses `pg` for raw superuser DDL
  (`CREATE DATABASE`, `pg_terminate_backend`). They don't boot Nest's
  DI graph — they're sysadmin tools, runnable from a fleet jump host or
  cron, with no app process required.
- **Same Prisma migrate path as runtime provisioning.** All three of
  `tenant-create`, `tenant-migrate`, and `tenant-relocate` shell out
  through `pnpm exec prisma migrate deploy` against the target's
  `TENANT_DATABASE_URL` — exact same code path the API's
  `TenantProvisioningService` runs at signup. No drift between
  signup-time and admin-time schema state.
- **Two-phase commit, with rollback.** `tenant-create` creates the
  physical DB first, then runs the control-plane TX. If the TX fails
  after `CREATE DATABASE` succeeded, the script drops the orphan DB.
  No half-states. The same shape governs `tenant-relocate`: the source
  DB stays intact until the operator runs `--drop-source` after a
  post-cutover probe.
- **Reuses 18c's system mode as the "downtime window."** Both
  `tenant-relocate` and `storage-migrate` open a per-tenant `read_only`
  event before they touch any data, then close it on success. Failures
  leave the window open so a human can investigate while users see a
  clean 503-with-explanation rather than 500s or stale reads.
- **Cache invalidation is part of the contract.** Both migration
  scripts bust `lbr:tenant:slug:<slug>` (and `lbr:tenant:sub:<sub>` for
  tenants with a custom subdomain) before closing the read-only window
  — the next request through `TenantMiddleware` picks up the new
  `db_url` / `storage_url` from the control DB rather than the
  5-minute-cached old value.
- **`pg_dump --format=custom --no-owner --no-acl` + matching
  `pg_restore --clean --if-exists`.** Custom format lets pg_restore
  parallelize. `--no-owner` / `--no-acl` mean the dump is portable
  across cells with different role names — Prisma manages schema, so
  per-tenant ownership doesn't need to follow. `--clean --if-exists`
  makes the restore re-runnable on a freshly-created destination DB.
- **Storage today is `file://` only.** The script parses the URL scheme
  and dies cleanly on anything else (`s3://`, `smb://`), so the
  storage-driver swap drill stays paper-testable today: the wiring is
  here, only the per-scheme sync command is missing. Plugging in
  `s3 sync` or `aws s3 cp --recursive` is a switch-arm in
  `storage-migrate.ts`.
- **Out of MVP, hooks in place.** Per-tenant Postgres roles + GRANTs
  (today every tenant DB uses the superuser; the per-cell `libriant`
  role is enough at the pilot scale), live-replication-based zero-
  downtime relocation (pg_dump/restore is the simple workhorse for the
  pilot), and an admin-UI runner for these scripts (today they're
  CLI-only, which matches the on-call operator surface anyway).

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
| 18   | **Internal admin core (auth + tenant list + plan editor + per-tenant override editor + gated billing)**   | ✅ done                        |
| 18a  | **Support sessions (MFA + one-time keys + impersonation + audit log + library revoke)**                   | ✅ done                        |
| 18b  | **Announcements (composer + audience filters + in-app banners + outbox email + tag editor)**              | ✅ done                        |
| 18c  | **System mode (maintenance / read-only / out-of-order / under-construction + per-tenant + scheduling)**   | ✅ done                        |
| 19   | **Infra (Caddy + prod compose + GH Actions deploy + worker + health/metrics + backups)**                  | ✅ done                        |
| 20   | **Tenant provisioning + fleet migrate + DB relocate + storage migrate scripts**                           | ✅ done                        |
