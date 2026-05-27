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

## Where we are in the plan

| Step | Description                                                                 | Status                         |
| ---- | --------------------------------------------------------------------------- | ------------------------------ |
| 0    | Design system + i18n + assets foundation                                    | ✅ done                        |
| 1    | Repo scaffold (pnpm/turbo/tsconfig/prettier)                                | ✅ done                        |
| 2    | **Control-plane Prisma schema + idempotent seed**                           | ✅ done                        |
| 3    | Feature key catalog                                                         | ✅ done (in `packages/shared`) |
| 4    | **Tenant Prisma schema (catalog/members/loans/customization/audit)**        | ✅ done                        |
| 5    | NestJS API skeleton (health endpoints)                                      | ✅ done                        |
| 6    | **Tenancy layer (resolver + Prisma LRU + middleware + guard)**              | ✅ done                        |
| 7    | **Auth (signup with tenant provisioning + login + sessions + reset)**       | ✅ done                        |
| 8    | **Plan/quota system (EffectivePlan + PlanGuard + QuotaInterceptor)**        | ✅ done                        |
| 9    | **Schema customization (per-entity fields + custom collections + records)** | ✅ done                        |
| 10   | **Storage layer (driver pattern + signed URLs + quota + recompute)**        | ✅ done                        |
| 11   | **Catalog (authors + books + copies + ISBN lookup + covers)**               | ✅ done                        |
| 12   | **Members (CRUD + auto member-number + status + archive + photos)**         | ✅ done                        |
| 13   | **Loans (checkout / return / renew / mark-lost + overdue fines)**           | ✅ done                        |
| 14   | **Reservations (holds queue + auto-promote + ready-pickup + fulfill)**      | ✅ done                        |
| 15   | Collections                                                                 | ⏳                             |
| 16   | Billing (Stripe + manual)                                                   | ⏳                             |
| 17   | Staff UI (onboarding, help center, billing)                                 | ⏳                             |
| 18   | Internal admin (plans, support, system mode, announcements)                 | ⏳                             |
| 19   | Infra (Caddy, prod compose, GH Actions deploy)                              | ⏳                             |
| 20   | Tenant provisioning + relocation scripts                                    | ⏳                             |
