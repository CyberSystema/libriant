# LIBRIANT 2.0 — MASTER ARCHITECTURE AND ROADMAP

**Status:** Plan of record. Supersedes the eight domain specifications where they conflict.
**Constraint:** one phase per session; `pnpm check:all` green, tests green, migrations applied, app working at every phase boundary.
**Rule of this document:** where the specs disagreed, one option is chosen and the loser is deleted, not deferred.

> **AMENDED AFTER BUILDING PHASES 1–20b-i.** This document was written before any
> of it existed, and building it proved parts of it wrong. Corrections are marked
> **_Amended_** inline, next to the text they correct, rather than collected at
> the end — a reader acting on a paragraph needs the correction in that
> paragraph. The measurement behind each one is in the divergence log,
> `README.md`, which is the running record; this file is the plan.
>
> Two classes of correction recur and are worth knowing before reading. **The
> plan described files and gates that were never created** under the names it
> gives — the upgrade is not `v1_to_v2.sql`, the search document is not
> `search-document.ts`, `check:dsar-coverage` does not exist. And **it stated
> acceptance criteria that the named instrument cannot measure** — an
> `EXPLAIN (ANALYZE, BUFFERS)` assertion about TOAST reads, a statement-count
> bound needing an extension the cluster cannot load, a `COLLATE` comparison in
> a test file that has no database. Both classes pass silently, which is why
> they survived so long.

---

## 1. Target architecture

**Shape: a modular monolith with three sidecars, one Postgres database per library, and one optional search cluster.** FOLIO's 60-module topology is rejected outright — it needs a platform team, and owner decision 8 requires a village library to self-host on one box.

### Services and physical topology

| Container          | Ports                        | Network     | Profile     | Purpose                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ---------------------------- | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `caddy`            | 80, 443 (host)               | edge        | always      | The only host-published HTTP ports. Terminates Cloudflare origin TLS; every backend route sits behind `import origin_guard` (`check:caddy`).                                                                                                                                                                                                     |
| `api`              | 3001 (internal)              | edge + data | always      | NestJS 11 modular monolith: catalogue, circulation, patrons, notices, reports, public REST v1, OPAC data plane.                                                                                                                                                                                                                                  |
| `worker`           | 3002 (internal, health only) | data        | always      | BullMQ consumer. _Amended: the port is **3002**, not 3005 — and §1 also assigns 3002 to the unbuilt `opac`, which must move. The queue list here was aspirational; the shipped set is smaller and none of it carries an `acquisitions` or `webhook` name yet._                                                                                   |
| `web`              | 3000 (internal)              | edge        | always      | Next.js staff app at `app.libriant.com`.                                                                                                                                                                                                                                                                                                         |
| `opac`             | 3002 (internal)              | edge        | always      | Next.js public app at `opac.libriant.com` and per-tenant custom hostnames. **Separate origin, non-negotiable** — the `__Host-lbr_session` prefix is a browser guarantee that patron-authored review HTML can never reach the staff cookie.                                                                                                       |
| `site`             | —                            | edge        | n/a         | _Amended: there is no `site` container and there is a recorded decision not to have one._ The marketing site is rendered at build time and baked into the Caddy image at `/srv/libriant/site`; `apps/site/dist` is gitignored, so nothing serves it at runtime.                                                                                  |
| `postgres`         | 5432 (internal)              | data        | always      | Control DB + one `tenant_<cuid>` database per library.                                                                                                                                                                                                                                                                                           |
| `pgbouncer`        | 6432 (internal)              | data        | cloud       | Transaction pooling in front of tenant DBs. Migrations connect direct (Prisma takes a session advisory lock).                                                                                                                                                                                                                                    |
| `redis`            | 6379 (internal)              | data        | always      | Sessions, rate limits, policy-snapshot versions, BullMQ, caches. Never the source of truth for anything.                                                                                                                                                                                                                                         |
| `opensearch`       | 9200 (internal)              | data        | `search`    | Per-tenant indices `lbr-t-<tenantId>-{bib,auth,browse}`; consortium `lbr-c-<id>-union`.                                                                                                                                                                                                                                                          |
| `protocol-gateway` | 210, 2100, 6443 (host)       | edge + data | `protocols` | Z39.50 and SIP2 raw-TCP servers. **No database credentials** — reaches data only through `/internal/*` with a per-protocol service account. Its own image, its own lego TLS sidecar, DNS-only hostnames. This is the one documented exception to the "only Caddy publishes ports" compose invariant, and it is written into the compose comment. |
| `plugin-host`      | —                            | data        | `plugins`   | Rust + wasmtime WASI-P2 compute plugins. Deferred until a vendor pays.                                                                                                                                                                                                                                                                           |
| `otel-collector`   | 4318 (internal)              | data        | `tracing`   | Off by default; refused on the air-gapped profile.                                                                                                                                                                                                                                                                                               |

### Data stores

- **Control DB** — tenants, cells, users, plans/modules, identity providers, licences, migration ledger, consortium membership, plugin registry, AI settings and provider keys. AI keys live here specifically because `export-processors.ts` dumps every tenant table on librarian request.
- **Tenant DB (one per library)** — everything the library owns. Opened with a per-tenant Postgres role (`tenant_<id>_app`, `NOSUPERUSER`, `CONNECTION LIMIT 40`, `statement_timeout=15s`) whose sealed password lives in the already-modelled-but-unused `tenant_db_credentials`. `assertUrlBelongsToTenant` is unchanged and never relaxed; the role is the second wall.
- **OpenSearch (optional)** — index per tenant, never a shared index with a tenant filter.
- **pgvector (optional)** — semantic vectors inside the tenant DB, never in the shared search cluster.

### Protocol endpoints

Public HTTP: `/api/v1/*` (REST, OpenAPI 3.1, API key or OAuth bearer), `/api/v1/graphql` (read-only reporting), `/t/:slug/sru`, `/t/:slug/oai`, `/t/:slug/resolve` (OpenURL), `/t/:slug/ncip`, `/t/:slug/iso18626`, `/t/:slug/scim/v2/*`, `/t/:slug/sync/*` (device), `/opac/:slug/*` (public catalogue data plane). Raw TCP: Z39.50 on 210 (plaintext, public database only) and 2100 (TLS), SIP2 on 6443 (TLS; 6001 plaintext only under an explicit on-prem flag).

### Clients

`apps/web` (staff, Next.js) · `apps/opac` (public + patron, Next.js) · `apps/desktop` (Tauri 2 shell over a Rust core owning storage/transport/hardware/OS integration, with the encrypted SQLite replica; Electron continues to serve until the Tauri client lands in M8) · self-check and returns kiosks (the same Tauri binary in a boot mode) · third-party clients through `/api/v1` and the protocol endpoints.

### How it degrades for a small self-hosted install

`docker-compose.selfhost.yml` starts **caddy, api, worker, web, opac, postgres, redis** — seven containers, ~2 GB RAM, one VPS. `SEARCH_DRIVER=postgres` selects the `PostgresSearchBackend` behind the same `SearchBackend` interface (tsvector + pg_trgm + `browse_terms`); relevance is worse and the product says so. No pgbouncer (one library, one pool), no OpenSearch, no protocol gateway, no plugin host, no tracing, no broker. `docker-compose.airgap.yml` adds a no-egress network policy: every outbound fetch goes through `platform/outbound-http.ts`, which refuses on that profile, so AI, cover lookups, authority reconciliation and update checks all fail closed and the rest of the system is unaffected. Licence verification is offline Ed25519 against a public key embedded in the build. **An expired licence never stops a library lending a book** — administrative creation blocks, circulation continues.

---

## 2. The bibliographic core decision

**The MARC record is stored as an ordered JSONB array in a 1:1 side table, with a full-snapshot version history and a relational projection recomputed by a pure function inside the same transaction as every write.**

```sql
-- Identity. Narrow, hot, never carries the document.
CREATE TABLE marc_records (
  id                    text        PRIMARY KEY,              -- cuid
  public_no             bigint      NOT NULL,                 -- per-tenant monotonic; the printable id
  kind                  marc_record_kind    NOT NULL,         -- bibliographic|authority|holdings|classification
  schema                marc_schema         NOT NULL,         -- marc21|unimarc
  status                marc_record_status  NOT NULL,         -- draft|in_process|complete|suppressed|deleted
  leader                char(24)    NOT NULL,
  content_hash          bytea       NOT NULL,                 -- sha256 over canonical NFC JSON, EXCLUDING 005
  current_version       integer     NOT NULL DEFAULT 1,
  row_version           bigint      NOT NULL DEFAULT nextval('record_version_seq'),
  record_status_code    char(1)     NOT NULL,                 -- Leader/05  n|c|d|a|p   DERIVED
  record_type_code      char(1),                              -- Leader/06
  bib_level_code        char(1),                              -- Leader/07
  encoding_level        char(1),                              -- Leader/17
  charset_code          char(1)     NOT NULL DEFAULT 'a',     -- Leader/09  ' '=MARC-8, 'a'=UCS
  control_number        text,                                 -- 001
  control_number_source text,                                 -- 003
  date_entered          char(6),                              -- 008/00-05  NEVER rewritten after creation
  merged_into_id        text        REFERENCES marc_records(id) ON DELETE SET NULL,
  needs_review          boolean     NOT NULL DEFAULT false,
  created_by_user_id    text, updated_by_user_id text,        -- control-plane cuids, no FK (house rule)
  created_at            timestamptz(3) NOT NULL DEFAULT now(),
  updated_at            timestamptz(3) NOT NULL,
  deleted_at            timestamptz(3),
  CONSTRAINT marc_leader_len   CHECK (length(leader) = 24),
  CONSTRAINT marc_hash_len     CHECK (octet_length(content_hash) = 32)
);
CREATE UNIQUE INDEX marc_records_public_no_key ON marc_records (public_no);
CREATE UNIQUE INDEX marc_records_control_number_unique_active
  ON marc_records (kind, control_number)
  WHERE control_number IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX marc_records_kind_status_updated_idx
  ON marc_records (kind, status, updated_at DESC, id DESC);
CREATE INDEX marc_records_type_idx   ON marc_records (kind, record_type_code, bib_level_code);
CREATE INDEX marc_records_merged_idx ON marc_records (merged_into_id) WHERE merged_into_id IS NOT NULL;
CREATE INDEX marc_records_deleted_idx ON marc_records (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX marc_records_row_version_idx ON marc_records (row_version);

-- The document. Deliberately 1:1, deliberately not a column on marc_records.
CREATE TABLE marc_record_contents (
  record_id            text  PRIMARY KEY REFERENCES marc_records(id) ON DELETE CASCADE,
  content              jsonb NOT NULL,          -- ordered array; shape below
  source_format        marc_source_format NOT NULL,
  source_encoding      text,                    -- 'utf-8'|'marc-8'|'windows-1253'|'iso-8859-7'
  source_normalization text,                    -- 'NFC'|'NFD'|'mixed'|'unknown'
  source_blob          bytea,                   -- ORIGINAL BYTES, verbatim. NULLed on first edit.
  source_blob_sha256   bytea,
  source_roundtrips    boolean NOT NULL DEFAULT true,
  anomalies            jsonb NOT NULL DEFAULT '[]',
  updated_at           timestamptz(3) NOT NULL
);

-- Append-only full snapshots. bigserial, not cuid: high-volume, ordered, never user-facing.
CREATE TABLE marc_record_versions (
  id             bigserial PRIMARY KEY,
  record_id      text    NOT NULL REFERENCES marc_records(id) ON DELETE CASCADE,
  version        integer NOT NULL,
  leader         char(24) NOT NULL,
  content        jsonb   NOT NULL,
  content_hash   bytea   NOT NULL,
  change_kind    marc_change_kind NOT NULL,
  change_summary text,
  changed_tags   text[]  NOT NULL DEFAULT '{}',
  batch_job_id   text,
  actor_kind     audit_actor_kind NOT NULL,
  actor_id       text,
  created_at     timestamptz(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX marc_record_versions_key ON marc_record_versions (record_id, version);
CREATE INDEX marc_record_versions_desc_idx  ON marc_record_versions (record_id, version DESC);
CREATE INDEX marc_record_versions_sweep_idx ON marc_record_versions (created_at DESC, id DESC);
CREATE INDEX marc_record_versions_batch_idx ON marc_record_versions (batch_job_id)
  WHERE batch_job_id IS NOT NULL;
```

`content` is a compact superset of MARC-in-JSON. Single-character keys because at 5M records the key names are ~15 % of the JSONB:

```json
[
  { "t": "001", "v": "lbr-ckq81…" },
  { "t": "005", "v": "20260905141207.0" },
  { "t": "008", "v": "260905s1946    gr |||||||||||000 0 gre d" },
  {
    "t": "245",
    "i": "10",
    "s": [{ "a": "Βίος και πολιτεία του Αλέξη Ζορμπά /" }, { "c": "Νίκος Καζαντζάκης." }]
  },
  {
    "t": "700",
    "i": "1 ",
    "s": [{ "a": "Καζαντζάκης, Νίκος," }, { "d": "1883-1957" }, { "0": "(VIAF)12345678" }]
  }
]
```

`t` tag, `i` the two indicator bytes as a literal 2-char string (spaces preserved), `s` an **ordered array of single-key objects** (a map would silently destroy repeated subfields and subfield order), `v` for control fields, optional `x` for preserved structural anomalies.

**Leader write rules, corrected.** The bibliographic spec had these backwards and would have emitted records that Koha, Alma, Voyager and `yaz-marcdump` reject. The rule is asymmetric: **on read**, honour whatever /20-23 declares and use those widths to slice the directory, recording an anomaly if it is not `4500`; **on write**, always emit `/10='2'`, `/11='2'`, `/20-23='4500'`, and recompute `/00-04` and `/12-16`. `/09` is set from the export encoding, not from the source — a UTF-8 record emitted with a blank `/09` is mojibake at the far end. The original leader bytes survive only in `source_blob`. `005` is stamped inside the write transaction on every content change and excluded from `content_hash`, so a save that changes nothing writes no version but an export always carries a current transaction timestamp. `Leader/05` is derived from status (`n` on create, `c` on edit, `d` on delete/merge). `008/00-05` is derived from `created_at` and never rewritten — every "titles added this year" statistic and the ISO 2789 return depend on it.

### Defence against the five stress cases

**Single-subfield edit.** A 2 KB JSONB rewrite: one Postgres UPDATE, HOT-eligible, no join maintenance. The normalized alternative — `marc_fields` + `marc_subfields` — is 5M × 25 × 2.5 ≈ **300M subfield rows**, 7 GB of tuple headers before indexes, a two-level join on every record read, and `ordinal` maintenance on every insert that costs the same as rewriting the whole document anyway.

**5M-record indexing.** Nothing that scans reads the document. The projection (`bib_records`, `bib_identifiers`, `bib_heading_links`, `bib_classifications`) is plain relational and is what facets, reports, OPAC and OpenSearch read. TOAST keeps a fat JSONB off the heap page — _provided nothing selects it_, and Prisma's default `findMany` selects every scalar column. The 1:1 split makes that mistake unrepresentable and keeps `source_blob bytea` out of `SELECT *` forever. Bulk load bypasses the per-row write path via COPY into staging plus one set-based projection pass (≥2,000 rec/s vs ~80), and is initial-load-only, refuses a non-empty catalogue, and is followed by a mandatory full `catalog-verify`.

**Format validation.** Data-driven from committed Avram definitions, not code: mandatory fields, field and subfield repeatability, indicator legality, positional value lists per Leader/06+/07 discriminant (007 alone has 15 layouts). `validateDelta(before, after)` blocks **only errors this edit introduced** — without that asymmetry a legacy AACR2 record with an illegal indicator becomes permanently uneditable, which is how real catalogues freeze and how cataloguers learn to switch validation off.

**Byte-exact re-export.** Two distinct promises. An _unedited imported_ record re-exports its original bytes from `source_blob` at `?fidelity=source`, and `source_roundtrips` records at import time whether `serialize(parse(blob)) === blob`, with the anomaly naming why when it does not. _Any_ record, edited or not, re-exports through a round-trip-idempotent serializer — `parse(serialize(r)) ≡ r` — proved by a property test over a ≥5,000-record corpus of LC samples plus real ABEKT, Koha, Aleph and Evergreen exports.

**Version diffing.** Full snapshots, not diff chains: a MARC record averages 1.6 KB and LZ4-compresses ~4:1 (`default_toast_compression=lz4` on tenant clusters), "restore version N" is a copy rather than a replay, and it cannot be subtly wrong the way a chain can. Diffing two ordered documents is a field alignment plus a subfield diff; diffing two row sets would require reconstructing the order first. Retention defaults to **5** snapshots plus everything under 90 days plus every `migration`/`merge` forever — the specs' 20 was sized against a 5M-record catalogue that will not exist for years.

The one query the normalized table would win — "every record with `650$a` = X" — is served by the search index, and on air-gapped installs by `bib_heading_links` plus an optional `GIN (content jsonb_path_ops)` created by script with `CONCURRENTLY`, never by a migration.

---

## 3. The 2.0 tenant schema

Conventions, enforced by `check:schema-conventions`: **snake_case physical columns** via Prisma `@map` (1.0's quoted camelCase forces double-quoting in every raw statement, every psql session and every report query); **`timestamptz(3)`** for instants, `date`/`time` for civil values; **`bigint` minor units + `char(3)` currency** for all patron-facing money; `id text` cuid, never re-keyed; `archived_at` soft delete with partial uniques scoped `WHERE archived_at IS NULL`; bare text cuids across the control-plane boundary with no FK; every function call in migration SQL `pg_catalog.`- or `extensions.`-qualified.

Extensions: existing `pgcrypto, citext, pg_trgm, unaccent` plus **`btree_gist`** (booking and calendar exclusion constraints) and **`btree_gin`** (composite scalar+trigram). `ltree` and `vector` are added only by the phases that use them.

### Platform (owner: Platform)

`_libriant_schema_state` · `_libriant_online_migrations` · **`branches`** · `service_points` · `shelving_locations` · `roles` · `role_permissions` · `staff_profiles` · `staff_role_grants` · `staff_permission_overrides` · `audit_log` (partitioned monthly) · **`change_events`** · `change_consumers` · `devices` · **`sync_client_changes`** · `custom_field_values` · `field_definitions` · `collections` · `collection_fields` · `collection_records` · `plugin_installations` · `plugin_grants` · `tenant_settings`

```sql
CREATE TABLE branches (
  id text PRIMARY KEY,
  code text NOT NULL, name text NOT NULL, name_i18n jsonb NOT NULL DEFAULT '{}',
  isil text,                        -- ISO 15511. GR-prefixed, assigned by EKT.
  marc_org_code text,               -- 040$a / 852$a
  parent_branch_id text REFERENCES branches(id) ON DELETE RESTRICT,
  depth smallint NOT NULL DEFAULT 0,
  kind branch_kind NOT NULL DEFAULT 'branch',
  timezone text NOT NULL,           -- IANA, validated against Intl.supportedValuesOf. THE circ-5 fix.
  currency char(3) NOT NULL DEFAULT 'EUR',
  default_locale text NOT NULL DEFAULT 'el',
  calendar_id text, address_* text, geo_lat numeric(9,6), geo_lon numeric(9,6),
  circulates boolean NOT NULL DEFAULT true,
  pickup_location boolean NOT NULL DEFAULT true,
  is_floating_member boolean NOT NULL DEFAULT false,
  opac_visible boolean NOT NULL DEFAULT true,
  staff_only boolean NOT NULL DEFAULT false,
  ill_supplier boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}', custom_fields jsonb NOT NULL DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL,
  archived_at timestamptz(3),
  CONSTRAINT branches_no_self_parent CHECK (parent_branch_id <> id)
);
CREATE UNIQUE INDEX branches_code_unique_active ON branches (code) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX branches_isil_unique_active ON branches (isil)
  WHERE isil IS NOT NULL AND archived_at IS NULL;
-- Cycles cannot be a CHECK: branches_guard_cycle() walks parents (max 16 hops) and maintains depth.
```

```sql
CREATE TABLE change_events (                 -- the ONE feed. Written by TRIGGERS, never by app code.
  seq         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz(3) NOT NULL DEFAULT now(),
  entity_kind text NOT NULL, entity_id text NOT NULL,
  op          text NOT NULL CHECK (op IN ('insert','update','delete','archive','restore')),
  branch_id   text,
  row_version bigint NOT NULL,               -- from record_version_seq; the total order
  payload     jsonb,                         -- projection for indexers; NULL on delete
  actor_kind  audit_actor_kind NOT NULL, actor_id text,
  device_id   text, client_change_id uuid
);
CREATE INDEX change_events_kind_seq_idx   ON change_events (entity_kind, seq);
CREATE INDEX change_events_branch_seq_idx ON change_events (branch_id, seq);

CREATE TABLE change_consumers (              -- 'search','opac-cache','webhook:<id>','device:<id>','union'
  consumer text PRIMARY KEY, last_seq bigint NOT NULL DEFAULT 0,
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);
```

```sql
CREATE TABLE sync_client_changes (           -- durable, transactional, exactly-once. Kills A7-02.
  device_id        text NOT NULL,
  client_change_id uuid NOT NULL,
  device_seq       bigint NOT NULL,
  request_hash     text NOT NULL,            -- mismatch on replay ⇒ 409, never a silent re-apply
  response_json    jsonb NOT NULL,
  server_event_seq bigint,
  applied_at       timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, client_change_id)
);
CREATE INDEX sync_client_changes_applied_idx ON sync_client_changes (applied_at);
```

Written **inside the same transaction as the effect**, retained 180 days. `apps/web/lib/offline-queue.ts`'s `MAX_QUEUE_AGE_MS = 18h` (_amended: still live at `offline-queue.ts:69`; the 2.0 work that was to retire it has not_) — chosen with 6 h of margin under `IdempotencyInterceptor.RESULT_TTL_SEC = 24h` in Redis — is deleted. The Redis interceptor stays for the interactive HTTP path and gains a **fail-closed** variant for money-moving routes; its fail-open default is defensible for a checkout and indefensible for an approved payment.

### Bibliographic (owner: Cataloguing)

`marc_records` · `marc_record_contents` · `marc_record_versions` · `marc_record_locks` · `bib_records` · `bib_identifiers` · `bib_heading_links` · `bib_classifications` · `bib_duplicate_candidates` · `bib_record_aliases` · `work_clusters` · `work_cluster_overrides` · `catalog_templates` · `marc_field_definition_overrides` · `marc_overlay_rules` · `marc_batch_jobs` · `marc_batch_job_items` · `oai_record_state` · `catalog_settings`

```sql
CREATE TABLE bib_records (
  bib_id text PRIMARY KEY REFERENCES marc_records(id) ON DELETE CASCADE,
  title text NOT NULL, title_nonfiling_skip smallint NOT NULL DEFAULT 0,
  sort_title text NOT NULL, statement_of_resp text,
  main_entry_display text, main_entry_norm text,
  edition text, publisher text, publication_place text,
  publication_year smallint, publication_year_end smallint,
  language_code char(3), language_codes char(3)[] NOT NULL DEFAULT '{}',  -- ISO 639-2/B: Greek is 'gre'
  country_code char(3),
  material_type_id text REFERENCES material_types(id),
  content_type_code text, media_type_code text, carrier_type_code text,   -- RDA 336/337/338
  extent text, physical_description text, series_statement text, summary text,
  work_cluster_id text REFERENCES work_clusters(id) ON DELETE SET NULL,
  match_key text NOT NULL,
  search_text text NOT NULL,     -- Greek-folded (final sigma!), GIN trigram
  browse_author text, cover_asset_ref text,
  custom_fields jsonb NOT NULL DEFAULT '{}',
  suppressed_from_opac boolean NOT NULL DEFAULT false,
  item_count integer NOT NULL DEFAULT 0, available_count integer NOT NULL DEFAULT 0,
  legacy_json jsonb,             -- the 1.0 flat row, verbatim, for provenance
  created_at timestamptz(3) NOT NULL, updated_at timestamptz(3) NOT NULL
);
```

**ISBN is deliberately not unique in 2.0.** `books_isbn13_unique_active` is dropped. Identity is 001+003 (`marc_records_control_number_unique_active`) with 035 secondary; a set and its volumes, a reprint, and endemic publisher ISBN reuse in small Greek presses all legitimately share an ISBN, and the 1.0 constraint would refuse the exact catalogues this product exists to import. An ISBN collision becomes a `bib_duplicate_candidates` row and a merge offer.

`bib_heading_links` decomposes 6XX into a main heading plus an ordered subdivision list (`main_heading_norm`, `subdivisions jsonb` carrying subfield code per element) — matching an assembled `650 $a Libraries $z Greece $x History` string against a single authority record fails on nearly every real LCSH heading, and would put the entire subject vocabulary in the "unlinked headings" work queue. The table is created in the authority phase, not the baseline, and `CATALOG_HEADING_LINKS=controlled-only` is the default.

`marc_overlay_rules` (per source: protect | replace | merge | add-if-absent per tag, plus an encoding-level guard refusing a weaker Leader/17 over a stronger one) is the single most-requested cataloguing feature in every ILS and was absent from all eight specs. Without it the first Z39.50 overlay destroys a decade of local 9XX/852/590 notes and the feature is switched off permanently. Defaults: protect 9XX, 852, 590, 856 with local `$x`.

### Holdings and items (identity/description: Cataloguing; circulation state: Circulation)

`holdings_records` · `items` · `item_types` · `material_types` · `item_status_reasons` · `item_status_history` · `item_notes` · `item_transfers` · `floating_rules`

```sql
CREATE TABLE items (
  id text PRIMARY KEY,
  holdings_record_id text NOT NULL REFERENCES holdings_records(record_id) ON DELETE RESTRICT,
  bib_id             text NOT NULL REFERENCES marc_records(id) ON DELETE RESTRICT,  -- tx-synced
  barcode text, barcode_norm text,
  item_type_id     text NOT NULL REFERENCES item_types(id),      -- POLICY. Drives the rules matrix.
  temporary_item_type_id text REFERENCES item_types(id),         -- course reserves, "new books"
  material_type_id text REFERENCES material_types(id),           -- RDA carrier. Display/facets only.
  owning_branch_id   text NOT NULL REFERENCES branches(id),
  current_branch_id  text NOT NULL REFERENCES branches(id),      -- floating collections move this
  permanent_location_id text NOT NULL REFERENCES shelving_locations(id),
  temporary_location_id text REFERENCES shelving_locations(id),
  call_number_prefix text, call_number_base text, call_number_suffix text, copy_number text,
  call_number_sort text,        -- PURE ASCII fixed-width. Non-negotiable: see below.
  call_number_scheme call_number_scheme NOT NULL DEFAULT 'ddc',
  enumeration text, chronology text,
  status item_status NOT NULL DEFAULT 'available',
  status_since timestamptz(3) NOT NULL DEFAULT now(), status_reason_id text,
  not_for_loan_code text, damaged_code text, lost_code text, withdrawn_at timestamptz(3),
  restricted_access boolean NOT NULL DEFAULT false,
  holdable boolean NOT NULL DEFAULT true, bookable boolean NOT NULL DEFAULT false,
  price_cents bigint, replacement_cost_cents bigint,
  acquired_at date, accession_number text, public_note text, staff_note text,
  rfid_tag_uid text, rfid_afi smallint, rfid_written_at timestamptz(3),
  inventoried_at timestamptz(3), last_seen_at timestamptz(3), last_seen_at_branch_id text,
  checkout_count integer NOT NULL DEFAULT 0, renewal_count integer NOT NULL DEFAULT 0,
  custom_fields jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz(3) NOT NULL, updated_at timestamptz(3) NOT NULL, archived_at timestamptz(3),
  CHECK (price_cents IS NULL OR price_cents >= 0)
);
ALTER TABLE items ADD COLUMN is_shelf_available boolean GENERATED ALWAYS AS (
  status = 'available'::item_status AND not_for_loan_code IS NULL AND damaged_code IS NULL
  AND lost_code IS NULL AND withdrawn_at IS NULL AND archived_at IS NULL) STORED;
CREATE INDEX items_shelf_available_idx ON items (bib_id, current_branch_id) WHERE is_shelf_available;
CREATE UNIQUE INDEX items_barcode_unique_active ON items (barcode_norm)
  WHERE barcode_norm IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX items_rfid_uid_unique ON items (rfid_tag_uid)
  WHERE rfid_tag_uid IS NOT NULL AND archived_at IS NULL;
CREATE INDEX items_shelf_order_idx ON items (current_branch_id, call_number_sort, id);
```

Three decisions carried in that DDL. `item_types` (policy) is **split from** `material_types` (RDA carrier) — conflating them is the most common ILS data-model mistake and is why "reference copy of a book" needs a hack in Koha. `holdings_record_id` is `NOT NULL`, made costless by auto-creating a default holdings record on first item, which is how a village library and a university share one schema. `is_shelf_available` is a **generated boolean** rather than a `status = 'available'` predicate: Prisma emits `status = CAST($1::text AS item_status)` and `enum_in` is only STABLE, so the planner can never prove an enum-predicate partial index — the exact reason `loans_active_dueAt_idx` had to be dropped in 1.0.

`call_number_sort` is produced by `@libriant/shared/callnumber` and is **pure ASCII, fixed-width, zero-padded** (`"005.13300000|KER|2019|C02"`). Tenant databases are created `el_GR.UTF-8`; a non-ASCII sort key reorders under that collation — the same trap as perf-13 — and shelf order must be byte-identical in Postgres, in the browser and in the offline Rust wand.

### Circulation (owner: Circulation)

`calendars` · `calendar_hours` · `calendar_exceptions` · `loan_policies` · `overdue_fine_policies` · `lost_item_fee_policies` · `hold_policies` · `notice_policies` · `fixed_due_date_sets` · `fixed_due_date_ranges` · **`circulation_rules`** · `patron_category_limits` · `circulation_policy_version` · **`loans`** · `loan_events` · `override_reasons` · `circulation_overrides` · `override_permissions` · `circulation_statistics` (partitioned) · **`holds`** · `hold_groups` · `cancellation_reasons` · `hold_ratio_alerts` · `patron_reading_history` · `inventory_sessions` · `inventory_scans` · `inventory_session_actions` · `terms` · `courses` · `course_reserves`

```sql
CREATE TABLE circulation_rules (
  id text PRIMARY KEY, name text NOT NULL, notes text,
  -- SELECTORS. NULL = wildcard.
  patron_category_id text, item_type_id text, owning_branch_id text,
  shelving_location_id text, checkout_branch_id text, pickup_branch_id text,
  -- PAYLOAD. Winner takes all — no per-field merge across rules, ever.
  loan_policy_id text NOT NULL, overdue_fine_policy_id text NOT NULL,
  lost_item_fee_policy_id text NOT NULL, hold_policy_id text NOT NULL, notice_policy_id text NOT NULL,
  max_loans_for_rule integer, max_holds_for_rule integer, age_restriction_min_years integer,
  specificity smallint GENERATED ALWAYS AS (
      (CASE WHEN patron_category_id   IS NOT NULL THEN 32 ELSE 0 END)
    + (CASE WHEN item_type_id         IS NOT NULL THEN 16 ELSE 0 END)
    + (CASE WHEN owning_branch_id     IS NOT NULL THEN  8 ELSE 0 END)
    + (CASE WHEN shelving_location_id IS NOT NULL THEN  4 ELSE 0 END)
    + (CASE WHEN checkout_branch_id   IS NOT NULL THEN  2 ELSE 0 END)
    + (CASE WHEN pickup_branch_id     IS NOT NULL THEN  1 ELSE 0 END)) STORED,
  priority integer NOT NULL DEFAULT 0,
  effective_from timestamptz(3), effective_to timestamptz(3),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz(3) NOT NULL, updated_at timestamptz(3) NOT NULL
);
CREATE UNIQUE INDEX circulation_rules_scope_unique ON circulation_rules (
  COALESCE(patron_category_id,''), COALESCE(item_type_id,''), COALESCE(owning_branch_id,''),
  COALESCE(shelving_location_id,''), COALESCE(checkout_branch_id,''), COALESCE(pickup_branch_id,''))
  WHERE enabled AND effective_to IS NULL;
CREATE UNIQUE INDEX circulation_rules_default_singleton
  ON circulation_rules ((true)) WHERE specificity = 0 AND enabled;
CREATE INDEX circulation_rules_resolve_idx
  ON circulation_rules (priority DESC, specificity DESC, id) WHERE enabled;
```

Rank is `priority DESC, specificity DESC, id ASC`. The `id` tiebreak makes it a **total order** — without it two equally-specific rules resolve non-deterministically across pods, which is how ILS policy bugs become unreproducible. The bit weights encode the precedence Koha librarians already carry in their heads, and are deliberately **not configurable**: `priority` exists for the one-off exception, and a configurable precedence order makes every support conversation start from scratch.

```sql
CREATE TABLE loans (
  id text PRIMARY KEY,
  item_id text NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  patron_id text REFERENCES patrons(id) ON DELETE RESTRICT,   -- NULLABLE: anonymised on return
  anonymised_at timestamptz(3),
  proxy_patron_id text, bib_id text NOT NULL,
  checkout_branch_id text NOT NULL, checkout_service_point_id text, checked_out_by_user_id text,
  loaned_at timestamptz(3) NOT NULL DEFAULT now(),
  due_at timestamptz(3) NOT NULL, original_due_at timestamptz(3) NOT NULL,
  grace_period_ends_at timestamptz(3),
  returned_at timestamptz(3), return_branch_id text, returned_by_user_id text,
  closed_at timestamptz(3),                                   -- DISTINCT from returned_at
  status loan_status NOT NULL DEFAULT 'active',
  renewal_count integer NOT NULL DEFAULT 0 CHECK (renewal_count >= 0),
  auto_renew_count integer NOT NULL DEFAULT 0, auto_renew_fail_reason text,
  recalled_at timestamptz(3), recall_due_at timestamptz(3), recalled_by_hold_id text,
  declared_lost_at timestamptz(3), claimed_returned_at timestamptz(3),
  -- POLICY PINNING
  loan_policy_id text NOT NULL, overdue_fine_policy_id text NOT NULL,
  lost_item_fee_policy_id text NOT NULL, applied_rule_id text NOT NULL,
  policy_snapshot jsonb NOT NULL,          -- the resolved VALUES, frozen at checkout
  item_type_id_applied text NOT NULL, patron_category_id_applied text NOT NULL,
  -- statistical buckets survive anonymisation
  patron_category_code text, patron_age_band text, patron_home_branch_id text,
  source event_source NOT NULL DEFAULT 'desk',
  device_id text, client_change_id uuid,
  created_at timestamptz(3) NOT NULL, updated_at timestamptz(3) NOT NULL,
  CONSTRAINT loans_due_after_loaned CHECK (due_at > loaned_at)
);
ALTER TABLE loans ADD CONSTRAINT loans_closed_consistency CHECK (
  (closed_at IS NULL) = (status IN ('active','claims_returned','claims_never_borrowed','recalled')));
CREATE UNIQUE INDEX loans_one_open_per_item ON loans (item_id) WHERE closed_at IS NULL;
CREATE INDEX loans_status_due_id_idx ON loans (status, due_at, id);   -- NOT partial: enum_cast reason
CREATE INDEX loans_patron_open_idx   ON loans (patron_id) WHERE closed_at IS NULL;
```

Splitting `closed_at` from `returned_at` fixes a real 1.0 dead end: a `lost` loan keeps `returned_at IS NULL` forever, so the partial unique pins the copy out of circulation permanently and a lost-then-found item can never be returned without violating a constraint. In 2.0 `lost` sets `closed_at` (the item is gone, a fee stands) and `markFound` can later set `returned_at` on that closed loan and issue a refund. `claims_returned` deliberately keeps the loan **open** — the item is unaccounted for and must not be re-lendable.

`policy_snapshot` is the frozen resolution. Editing a rule can never retroactively re-price an open loan; correcting a policy is an explicit, audited `POST /circulation/loans/repolicy` writing a `loan_event` per loan.

Holds are title / volume / item level with `hold_policy_id` + `policy_snapshot` pinned identically, `holds_one_assignment_per_item` making a double-assigned item impossible, and a **targeted** queue rebalance (`WHERE queue_position > <vacated>`). The 1.0 blanket `> 0` decrement is correct only because the head always leaves; with suspended holds being skipped it corrupts positions, and a named regression test must fail under the old form.

### Patrons — record (owner: Circulation) and identity (owner: Patron Services)

`patrons` · `patron_categories` · `patron_number_counters` · `patron_cards` · `patron_identifiers` · `patron_addresses` · `patron_relationships` · `patron_blocks` · `patron_messages` · `patron_notes` · `patron_merges` · `reading_history_policy` — **record side**.
`patron_identities` · `patron_sessions` · `patron_auth_providers` · `patron_registrations` · `patron_privacy_settings` · `patron_contact_endpoints` · `patron_channel_preferences` · `patron_households` — **identity side**.

`patron_blocks` gets the analogue of `fines_one_outstanding_per_loan`:

```sql
CREATE UNIQUE INDEX patron_blocks_one_auto_per_code ON patron_blocks (patron_id, code)
  WHERE auto_generated AND cleared_at IS NULL;
```

so block recalculation is an `INSERT … ON CONFLICT DO UPDATE` and a sweep racing a desk transaction settles in Postgres instead of aborting the librarian's checkout — the DATA-1 lesson applied to blocks.

**Reading history is anonymised on return by default.** `reading_history_policy.mode` defaults to `anonymised`, school libraries to `none`, and `patron_privacy_settings.keep_loan_history` defaults false. `loans.patron_id` is nulled and `anonymised_at` stamped in the same transaction as the return; `patron_category_code`, `patron_age_band` and `patron_home_branch_id` are retained so statistics are unaffected. This is an IFLA/NISO professional obligation and a Greek DPA answer, and it is a default rather than a setting someone forgot to turn on.

### Fees — the ledger (owner: Circulation)

`fee_types` · `patron_accounts` · **`fees`** · `account_transactions` · `account_entries` · `fee_allocations` · `payment_methods` · `cash_drawer_sessions` · `cash_drawer_movements` · `receipts` · `receipt_number_counters` · `fee_payment_intents` · `payment_terminals` · `ledger_discrepancies`

```sql
CREATE TABLE fees (
  id text PRIMARY KEY, account_id text NOT NULL, patron_id text NOT NULL,
  fee_type_id text NOT NULL, currency char(3) NOT NULL,
  loan_id text, item_id text, hold_id text, booking_id text, branch_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  tax_cents bigint NOT NULL DEFAULT 0,
  paid_cents bigint NOT NULL DEFAULT 0, waived_cents bigint NOT NULL DEFAULT 0,
  written_off_cents bigint NOT NULL DEFAULT 0,
  outstanding_cents bigint GENERATED ALWAYS AS
    (amount_cents + tax_cents - paid_cents - waived_cents - written_off_cents) STORED,
  status fee_status NOT NULL DEFAULT 'outstanding',
  is_accruing boolean NOT NULL DEFAULT false,
  accrual_policy jsonb, accrued_through timestamptz(3),
  reason text NOT NULL, created_at timestamptz(3) NOT NULL, closed_at timestamptz(3),
  CHECK (paid_cents + waived_cents + written_off_cents <= amount_cents + tax_cents)
);
CREATE UNIQUE INDEX fees_one_open_accrual_per_loan ON fees (loan_id)
  WHERE loan_id IS NOT NULL AND is_accruing AND closed_at IS NULL;
```

That partial unique preserves the 1.0 `INSERT … ON CONFLICT … DO UPDATE` upsert verbatim (DATA-1), which is why a return racing the accrual sweep does not abort the librarian's transaction — and with `timestamptz` the `NOW() AT TIME ZONE 'UTC'` workaround finally becomes a plain `now()`. Payments are a real double-entry ledger (`SUM(debit) = SUM(credit)` per transaction) reconciled nightly with `libriant_circ_ledger_drift_total`, which **alerts rather than self-heals** — a self-healing reconciler hides the bug that caused the drift.

### Notices (owner: Patron Services)

`notice_policies` (Circulation-owned config) · `notice_triggers` · `notice_templates` · **`notice_queue`** · `notice_deliveries` · `notice_suppressions`

`notice_queue.dedupe_key UNIQUE` (`'due_soon:<loanId>:<dueAtIso>'`) _is_ the idempotency of the whole platform. `notice_suppressions` keys on `sha256(lower(address))` so a bounce or unsubscribe survives GDPR erasure of the address itself. Patron notice bodies live in the **tenant** database, not the shared control-plane `email_outbox` — correcting privacy-legal-04, and an answer to a DPIA question no competitor can give. Email hands off to `EmailService.enqueue()` and stores the returned `outbox_id`.

### Discovery & community (owner: Patron Services)

`opac_settings` · `opac_branding` · `reviews` · `review_reports` · `patron_lists` · `patron_list_items` · `saved_searches` · `patron_tags` · `reading_challenges` · `event_series` · `events` · `event_registrations` · `spaces` · `equipment_units` · **`bookings`** · `booking_recurrences` · `digital_objects` · `digital_object_files` · `premis_events` · `digital_titles` · `digital_loans` · `reading_positions`

```sql
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap_space
  EXCLUDE USING gist (space_id WITH =, blocked WITH &&) WHERE (status IN ('pending','confirmed'));
```

Double-booking is **impossible**, not unlikely. No advisory lock, no read-modify-write race, no "sorry, someone else got that room" after the confirmation email went out. Circulation touches this in exactly one place: checkout of an item backing a bookable resource consults `bookings` for a conflicting confirmed booking.

### Search & analytics (owner: Search)

`bib_search_projection` · `browse_terms` · `search_index_state` · `bib_embeddings` (M9) · `item_text` · `analytics.dim_*` · `analytics.fact_circulation` (partitioned monthly) · `analytics.fact_holdings_snapshot` · `analytics.fact_search` · `analytics.fact_finance` · **`analytics.manual_statistics`**

`analytics.dim_patron.patron_key` is `HMAC-SHA256(tenant pepper, patron_id)` truncated to 128 bits. A leaked analytics extract is not a patron list. `manual_statistics` holds the ISO 2789 elements no ILS can derive — staff FTE, floor area, expenditure, seats, survey satisfaction — and is what makes a national return filable rather than a spreadsheet exercise.

### Acquisitions / serials / ERM / ILL (owner: Acquisitions) — M7, all `acq_`/`ser_`/`erm_`/`usage_`/`ill_` prefixed

`acq_fiscal_years` · `acq_ledgers` · `acq_funds` · `acq_budgets` · **`acq_fund_transactions`** (append-only, immutability trigger, `acq_fund_tx_one_encumbrance_per_line` partial unique) · `acq_budget_balances` · `acq_vendors` · `acq_suggestions` · `acq_orders` · `acq_order_lines` · `acq_order_line_funds` · `acq_receipts` · `acq_claims` · `acq_invoices` · `acq_invoice_lines` · `edi_messages` · `ser_subscriptions` · `ser_patterns` · `ser_pattern_exceptions` · `ser_issues` · `ser_routing_*` · `ser_bound_volumes` · `erm_*` · `usage_*` · `ill_settings` · `ill_partners` · `ill_requests` · `ill_request_rota` · `ill_messages` · `ill_costs`

Money inside this ledger only is `numeric(19,4)` + currency + `base_amount` + `exchange_rate` captured at posting time; per-line VAT splits and 8-dp FX cannot survive integer cents. **One crossing point** to the `bigint` world, in `ill-costs.service.ts`, with `@libriant/shared/money` owning the conversion and an ESLint rule banning arithmetic across the boundary.

### Control DB additions

_Amended: of the six `tenants.*` columns named next, **only `schema_major` exists**, and it lives on `tenant_schema_state` rather than on `tenants`. `timezone`, `deployment_profile`, `consortium_id`, `isil` and `marc_org_code` are absent from the control schema — which also makes §5's `tenants.isil` row half-false, since `branches.isil` shipped and the tenant-level one never did._

`tenants.timezone|deployment_profile|consortium_id|isil|marc_org_code|schema_major` · `tenant_schema_state` · `migration_runs` · `migration_run_tenants` · `identity_providers` · `federated_identities` · `webauthn_credentials` · `scim_tokens` · `api_keys` · `oauth_*` · `webhook_endpoints` · `webhook_deliveries` · `feature_modules` · `plan_modules` · `tenant_module_overrides` · `tenant_resource_limits` · `sync_devices` · `station_profiles` · `desktop_releases` · `licences` · `licence_activations` · `consortia` · `consortium_members` · `consortium_service_tokens` · `tenant_ai_settings` · `ai_audit_log` · `ai_usage_windows` · `opac_domains` · `plugins` · `plugin_versions`

### Dropped by the cutover

`books` · `authors` · `book_authors` · `book_copies` · `members` · `loans` (1.0) · `reservations` · `fines` · `member_number_counters` — and with them `books_isbn13_unique_active` and `authors_sortname_unique_active`.

_Amended._ "Dropped" is the wrong word and the list is short. The cutover RENAMES the 1.0 schema to `v1_archive` and drops nothing; the archive is what the rollback restores from, and it holds **23** tables, not nine. Besides those above it carries `tenant_settings`, `field_definitions`, `collections`, `collection_fields`, `collection_records`, `audit_log`, `roles`, `role_permissions`, `staff_profiles`, `staff_role_grants`, `staff_permission_overrides`, and the three migration-ledger tables. Several have 2.0 equivalents already; the customization trio and the import engine's write path do not, which is what phase 20b-ii exists to settle. Dropping `v1_archive` is a separate, later decision, and it is only safe once the six extensions have been rehomed into the promoted `public` (§8 risk 3).

---

## 4. Cross-cutting contracts

Nine interfaces. **Exactly one owner each.** Duplicates named in the specs are deleted before implementation starts.

### 4.1 Policy resolution — owner: **Circulation** (`packages/circ-policy`)

Zero-dependency, pure, synchronous, no `Date.now()` — every function takes an explicit instant.

```ts
resolveCirculationPolicy(snapshot: PolicySnapshot, ctx: {
  patronCategoryId, itemTypeId, owningBranchId, shelvingLocationId,
  checkoutBranchId, pickupBranchId?, at: Date
}): ResolvedPolicy & { trace: RuleTrace }
```

`trace` always returns `{ matchedRuleId, beatenRuleIds[], selectorsUsed, wildcardsUsed, calendarRolls[] }`, which powers `GET /t/:slug/circulation/explain` and the "Why is this due 19 Sep?" tooltip. `PolicySnapshotService` caches process-locally, versioned by the trigger-maintained `circulation_policy_version` counter, invalidated over Redis pub/sub with a 30 s TTL backstop, and **never fails open to a default policy** — a wrong loan period is a wrong receipt. The same ranking function resolves notice templates (branch 2, category 1). Consumers: circulation, holds, fees, notices, OPAC, SIP2, NCIP, the offline Rust core (pinned to `fixtures/resolution-vectors.json`, run by both `node --test` and `cargo test`).

### 4.2 Changelog / outbox — owner: **Platform** (`change_events`)

**Trigger-written, not application-emitted.** A forgotten `emit()` silently breaks replicas and the search index forever; a trigger is unforgettable. `scripts/gen-changelog-triggers.mjs` generates one `AFTER INSERT OR UPDATE OR DELETE` trigger per replicated table from the Prisma schema, and `check:changelog-coverage` asserts every model in `REPLICATED_TABLES` has one and vice versa. Consumers keep cursors in `change_consumers` and read with a commit watermark so no late-committing transaction is skipped:

```sql
SELECT * FROM change_events
WHERE seq > $1 AND row_version < pg_snapshot_xmin(pg_current_snapshot())
-- AMENDED: as written this statement CANNOT RUN. `pg_snapshot_xmin()` returns
-- `xid8` and `row_version` is `bigint`, so Postgres refuses it outright:
--   ERROR:  operator does not exist: bigint < xid8
-- Casting would make it run and still be wrong, because a sequence value and a
-- transaction id are not the same ordering. The shipped watermark is whatever
-- `change_events` actually implements; this line is a design sketch that was
-- never executed, and the phase that builds a second consumer owes it a real one.
  AND (branch_id IS NULL OR branch_id = ANY($2::text[]))
ORDER BY seq LIMIT $3;
```

**Deleted:** `bib_index_outbox`, `search_outbox`, `webhook_events`, `item_availability_events`. Consumers: search indexer, OPAC cache invalidation, webhook relay, device sync, union index. Pruned at `min(last_seq)` and never younger than `2 × max(devices.max_offline_hours)`.

### 4.3 Search-index document — owner: **Cataloguing**

```ts
buildSearchDocument(record: MarcRecord, projection: BibProjection): BibSearchDocument
buildEmbeddingText(record: MarcRecord): string
```

Exported from `packages/marc/src/bib-projection.ts` as `projectBib`. _Amended: `search-document.ts` was never created, and neither `buildSearchDocument` nor `buildEmbeddingText` exists. `projectBib` is the single projection function everything reads, which is what this contract asked for under a different name._ Cataloguing owns _what a field means_ (leader/008-derived material type and audience, nonfiling-aware sort titles, RDA 336/337/338, nested holdings, the debounced `avail` object); Search owns the _analysis, relevance, facets and browse_ over it. One projection function serves the incremental indexer, the full-rebuild streamer, the OPAC record page, the OAI `oai_dc` rendition and the report builder, which is why they cannot disagree. Consumers: Search (both backends), OPAC, Interop, AI.

### 4.4 Notification engine — owner: **Patron Services**

```ts
NoticeQueueService.enqueue({
  kind,
  patronId,
  contextJson,
  dedupeKey,
  notBefore,
  expiresAt,
  branchId,
});
```

Producers (circulation, acquisitions, ILL, events, ERM) emit **intents only** and never pick a channel, render a template or talk to a provider. The engine owns channel resolution against `patron_channel_preferences`, suppressions, quiet hours in the branch's timezone, digest grouping, GSM-7 segment counting, the monthly SMS budget with degradation to email, RFC 8058 one-click unsubscribe, and the `notices` BullMQ queue. Circulation owns `notice_policies`/`notice_triggers` configuration and template selection through the shared specificity resolver.

### 4.5 Permission model — owner: **Platform**

`packages/shared/src/permissions.ts` — a catalog of **68** keys, each `{ key, kind: 'action'|'limit', module }`, namespaced `cat.*` (8), `circ.*` (23), `patron.*` (9), `admin.*` (15), `data.*` (7), `support.*` (3), `billing.*` (2), `report.*` (1). _Amended from "~180 keys": the four namespaces this line also promised — `acq.*`, `ill.*`, `opac.*`, `search.*` — do not exist, because the modules they belong to are not built. They arrive with their phases._ Enforced by `@RequirePermission('circ.fine.waive', { limitFrom: 'amountCents' })` + `PermissionGuard`, with **numeric limits** (`role_permissions.limit_num`) and branch scoping. `check:permissions` fails the build when any tenant-scoped controller method lacks `@RequirePermission` or an explicit `@PublicWithinTenant()`. Built-in role templates map 1:1 onto today's owner/admin/librarian/volunteer so behaviour is unchanged the day it lands; `support` is strictly narrower and loses `patron.pii.export`, `admin.staff.manage`, `admin.identity.manage`, `plugin.install`. OAuth scopes (M10) are a **projection of** permission keys, never a parallel vocabulary. Patron authorization is a separate plane entirely (§4 below, `PatronGuard` + `PATRON_SESSION_SECRET`).

### 4.6 ILL state machine — owner: **Acquisitions/ILL**

Two calls, and neither side crosses the line:

```ts
Iso18626Transport.send(peerId, message): Promise<Confirmation>   // Interop provides
on('iso18626.message.received', (msg: ParsedMessage, peer: Peer) => …)  // ILL consumes
```

**Interop** owns `packages/protocols/src/iso18626` (codec), `packages/ncip`, `iso18626_peers`, both inbound endpoints, retry and confirmation semantics, and the loopback transport for consortium peers. **ILL** owns `ill_requests`, `ill_request_rota`, `ill_costs`, `ill_settings` and the reducer. The requester's own actions are a strict FSM; **inbound supplier statuses are accept-and-record and permissive by default** — ISO 18626 lets a supplier move the request to most statuses at its discretion, and rejecting a legitimate `StatusChange` as an illegal transition produces exactly the interop failures ILL staff cannot debug. `ill_partners` loses `protocol`, `endpoint_url` and `credential_ciphertext`; they live in `iso18626_peers`.

### 4.7 AI provider interface — owner: **Search/AI** (`packages/ai`)

```ts
interface AiProvider {
  chat(req): Promise<Completion>;
  stream(req): AsyncIterable<Chunk>;
  embed(texts): Promise<Vector[]>;
  rerank(q, docs): Promise<Ranked[]>;
  vision(req): Promise<Completion>;
  capabilities(): ModelCapabilities;
}
```

Four hand-rolled providers (anthropic, openai, google, openai-compatible) plus `null`, all on the `platform/outbound-http.ts` guard. **Three independent off switches**: `AI_ENABLED=false` (module not registered, routes 404), the platform setting, and `tenant_ai_settings.enabled`. `data_egress_allowed=false` restricts host pinning to the tenant's own `self_hosted_base_url` — the guard is "pinned to a configured host" (which may legitimately be RFC1918), never "not private", which is what makes an air-gapped Ollama work while SSRF to the metadata service does not. **`AiCataloguingSuggestion` is an array of MARC path ops with per-op confidence, never a whole record**, so an accepted suggestion runs down the identical write path, is versioned, diffable, undoable and filterable by `change_kind='ai_accept'`.

### 4.8 Plugin capability model — owner: **Platform**

Two tiers. **Declarative** (v1): notice templates, report definitions, field mappings, dashboard widgets — validated against a manifest schema, **no code execution**, no capabilities required, covers ~90 % of what libraries actually ask a plugin to do. **UI lane**: a `connect-src 'none'` iframe on `plugins.{$SITE_HOST}` — a separate origin, which is a real capability boundary — driven by a `postMessage` bridge with short-lived scope-narrowed capability tokens. **Compute tier** (deferred): `apps/plugin-host`, Rust + wasmtime WASI-P2, fuel metering and memory caps, out of process. `plugin_capability_grants` records what a named human at that library _granted_, separately from what the manifest _requests_, and a version upgrade that widens the manifest re-enters consent. Four kill switches: per-tenant disable, version yank over Redis pub/sub, publisher key revocation, per-hook circuit breaker; plus `PLUGINS_ENABLED=false` as a supported (and air-gapped) configuration.

### 4.9 OpenAPI contract — owner: **Platform** (`apps/api/src/public-api/registry.ts`)

`@nestjs/swagger` is unusable here: `tsx`/esbuild does not emit `design:paramtypes`, which is exactly why `main.ts` abandoned the global `ValidationPipe`. Instead `defineEndpoint({ method, path, summary, scopes, requestDto, responseDto, examples, deprecation })` is **simultaneously** the validation wiring the controller uses and the source of the OpenAPI 3.1 document; JSON Schema is derived from `class-validator`'s own `getMetadataStorage()`, which needs no parameter metadata. Served at `GET /api/v1/openapi.json`, committed to `docs/api/openapi.v1.json`, and **`check:openapi` fails the build when they diverge** — a stale spec is the defining flaw of every incumbent ILS API and the fix is a build failure, not a review checklist. RFC 9457 `problem+json` on `/api/v1` only; the internal `/t/:slug/*` envelope is unchanged. Consumers: `packages/api-client-ts`, the OPAC, the Tauri client, third parties, plugins.

---

## 5. Standards compliance matrix

Role: **P** provider · **C** consumer · **B** both · **F** format only. Phase refers to §6.

### Bibliographic

| Standard                              | Version                               | Role | Phase | Note                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------- | ---- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MARC 21 Bibliographic                 | Update 39 (2026)                      | B    | 7–11  | System of record. Update number in the Avram file, surfaced as `tenants.catalog_schema_version`.                                                                                                                                                                                                       |
| MARC 21 Authority                     | current                               | B    | 45    | 1XX/4XX/5XX with `$w`; **cross-references generated by indexing 4XX/5XX**, no separate reference records. Project 008/32 (undifferentiated — never auto-link) and 008/33 (level of establishment); `is_provisional` derives from /33, not stored independently.                                        |
| MARC 21 Holdings (MFHD)               | current                               | B    | 9, 11 | 852/853-855/863-868/876-878. **Holdings 008 is mandatory** and projected: receipt status /06, retention /12, completeness /20, lending policy /25, reproduction /26 — this is what an ILL partner reads.                                                                                               |
| MARC 21 Classification                | current                               | C    | —     | Enum slot only; DDC/UDC schedules are licensed and are not shipped.                                                                                                                                                                                                                                    |
| ISO 2709                              | 2008                                  | B    | 7     | Reader honours the declared entry map; **writer always emits /10='2', /11='2', /20-23='4500'**, recomputes /00-04 and /12-16, refuses >99,999 bytes naming MARCXML.                                                                                                                                    |
| MARCXML                               | LC MARC21slim                         | B    | 7     | Input via `fast-xml-parser` (already a dependency); output is a hand-rolled writer with explicit escaping — a generic builder cannot guarantee subfield order and escaping is the injection surface.                                                                                                   |
| MARC-in-JSON                          | Ross Singer                           | B    | 7     | Interchange only. The compact `t/i/s/v` shape is an implementation detail and never appears in a public API response.                                                                                                                                                                                  |
| MARC-8                                | LC codetables.xml                     | B    | 7     | **G0/G1 designations reset at every field boundary.** Mappings are string-valued (some map to sequences). Double-diacritic halves U+FE20–FE23 span two base characters and get their own pass before the general combining-mark reorder. EACC lazily loaded; CJK is the least-tested path and says so. |
| UNIMARC Bib + Authorities             | IFLA 3rd ed. + updates                | B    | 50    | First-class `schema='unimarc'`, own Avram file, own projector. The Greek requirement: ABEKT is UNIMARC. Conversion is explicitly lossy, reported per record, original retained as a version.                                                                                                           |
| Avram JSON Schema Language            | 0.9.x (GBV)                           | F    | 8     | Our own format-definition format. Generated and **committed** — air-gapped builds fetch nothing.                                                                                                                                                                                                       |
| Unicode Normalization                 | UAX #15                               | B    | 7     | `content` stored NFC; original bytes verbatim in `source_blob`; ISO 2709/MARC-8 export emits NFD when `export_normalization='nfd'`. `content_hash` over canonical NFC JSON excluding 005.                                                                                                              |
| NACO Normalization                    | PCC/LC                                | B    | 7     | ~150-line table-driven transform; a Greek profile sits beside it, selected by script detection.                                                                                                                                                                                                        |
| ISO 843                               | 1997                                  | B    | 1     | **Type 2 (transcription) IS ELOT 743** — one option labelled `ISO 843 Type 2 (ELOT 743)`, not two. Type 1 (reversible) stored separately for identifier work.                                                                                                                                          |
| ALA-LC Romanization (Greek)           | current                               | P    | 45    | Third mapping, genuinely different from ISO 843 (β→v, η→ē, rough breathing). Needed to match LC/VIAF authorities.                                                                                                                                                                                      |
| RDA / AACR2 / ISBD                    | 3R / 2002 / 2011                      | C/P  | 8, 47 | Named rule packs over one Avram definition, as data. ISBD display generates for Leader/18 in `' ', 'c', 'n', 'u'` and passes through for `'a', 'i'` — **`'c'` (punctuation omitted) is growing under RDA and must not be treated as pass-through**.                                                    |
| BIBFRAME                              | 2.5 + bflc                            | P    | 49    | Practical subset, hand-rolled Turtle/N-Triples + fixed JSON-LD context. No RDF library, no XSLT engine, no remote context fetch.                                                                                                                                                                       |
| IFLA LRM                              | 2017                                  | F    | 46    | `work_clusters.cluster_key` includes 240 `$l`/`$s`/`$k` and 008/35-37, with an expression key beneath the work key — otherwise the Greek original and the English translation of _Zorba_ collapse into one cluster, which is the most visible wrongness a bilingual collection can have.               |
| Dublin Core / oai_dc                  | DCMI 2020-01-20                       | P    | 49    | Mandatory OAI prefix. Cataloguing owns the crosswalk so DC, SRU and REST cannot disagree.                                                                                                                                                                                                              |
| MODS                                  | 3.8                                   | P    | 49    | Data-driven crosswalk plus code for titleInfo non-sorting, relatedItem nesting, originInfo encoding.                                                                                                                                                                                                   |
| METS                                  | 1.12.x                                | P    | 97    | Packaging for digital objects only.                                                                                                                                                                                                                                                                    |
| schema.org (Book, Library, Event)     | current                               | P    | 31    | JSON-LD on OPAC record pages. How a public library's catalogue starts appearing in Google.                                                                                                                                                                                                             |
| RIS / BibTeX / CSL-JSON               | CSL 1.0.2                             | P    | 49    | Hand-rolled. BibTeX escaping (braces, %, &, #, case-protection) is the injection surface and a package's escaping is what you cannot audit at review.                                                                                                                                                  |
| COinS / unAPI                         | Z39.88 / unAPI 1                      | P    | 31    | ~40 lines each. Zotero and Mendeley capture a record with one click; a researcher can script the catalogue with no API key.                                                                                                                                                                            |
| ISO 639-2/B, MARC code lists          | current                               | B    | 7     | Greek is **`gre`** in MARC and `el` in BCP 47; `ell` is the terminology variant and is wrong for MARC. Getting this backwards mislabels every Greek record.                                                                                                                                            |
| LCCN normalization                    | LC structure                          | B    | 7     | Hand-rolled with LC's test vectors as a golden file.                                                                                                                                                                                                                                                   |
| **OCLC control number normalization** | —                                     | B    | 44    | `(OCoLC)ocm/ocn/on/bare`, leading zeros stripped, canonical digits in `bib_identifiers.value_norm`. Absent from all eight specs; without it the same OCLC record imported twice makes two bibs and no duplicate candidate.                                                                             |
| ISBN/ISSN/ISMN/DOI/EAN-13             | ISO 2108/3297/10957/26324             | B    | 11    | Check-digit validated. **None is a uniqueness constraint.**                                                                                                                                                                                                                                            |
| ISO 15511 (ISIL)                      | 2019                                  | B    | 9     | `branches.isil`, `tenants.isil`. Validated by shape, never by lookup. Required for ILL, NCIP agency id and 852$a.                                                                                                                                                                                      |
| DDC / LCC / UDC / NLM / MSC           | as listed                             | B    | 44    | Number parsing and **sort-key generation**, not the schedules. Pure ASCII fixed-width. LCC follows the published `lcsort` algorithm.                                                                                                                                                                   |
| ANSI/NISO Z39.71 + ISO 10324          | 2006 / 1997                           | F    | 84    | Compressed holdings. **`863 $w` is emitted: `g` for a received-gap, `n` for never-published** — the model already knows the difference and throwing it away is exactly the question an ILL request turns on. 866/867/868 ind1 level, ind2='1'.                                                         |
| EAD                                   | **2002 on import**, 3 (1.1) on export | B    | 98    | EAD-3-only cannot ingest the corpus Greek and European archives actually hold.                                                                                                                                                                                                                         |
| ISAD(G) / ISAAR(CPF) / PREMIS         | 2000 / 2004 / 3.0                     | B    | 97–98 | ISAD(G)'s 6 mandatory elements are NOT NULL columns. Libriant is a repository front end, not an OAIS archive, and the docs say so.                                                                                                                                                                     |

### Interoperability

| Standard                                         | Version                                                    | Role | Phase                    | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------- | ---- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bath Profile**                                 | release 2.0                                                | P    | 60                       | **Functional Area A Level 1 minimum, Level 2 target; Area B for holdings.** Absent from all eight specs. A Z39.50 server that answers only the combinations its authors imagined is unusable by Connexion, Koha and VuFind, and unverifiable in a tender.                                                                                                                                                                                                                                                                                                            |
| ANSI/NISO Z39.50                                 | 2003 (ISO 23950)                                           | B    | 30 (client), 60 (server) | **Client ships in the launch path** (daily cataloguer value); server ships behind Bath conformance. `concurrentOperations` refused, which removes referenceId interleaving from the threat model. Bib-1 relation 101 (stem) supported. Z39.50 Explain not implemented — stated in the docs, not left silent.                                                                                                                                                                                                                                                         |
| ITU-T X.690 BER                                  | 02/2021                                                    | F    | 30                       | Hand-rolled over a bounded subset. `BER_LIMITS` — depth 20, indefinite depth 8, element 1 MiB, sequence 4096 items, APDU 5 MiB — is the payoff no library would have let us set. Escape hatch written down: a Rust napi decoder behind the same pure-function signature.                                                                                                                                                                                                                                                                                             |
| SRU / CQL                                        | SRU 2.0 + 1.2; CQL 1.2                                     | B    | 58                       | **Version dispatch is total**: 1.2 accepts `recordPacking(string\|xml)` and `sortKeys`; 2.0 accepts `recordXMLEscaping`, `recordPacking(packed\|unpacked)` and CQL `sortBy`; wrong-version parameters get diagnostic 80/66. `resultSetTTL` and `cql.resultSetId` are **not advertised** — a signed cursor over a live index freezes nothing, and promising a frozen set you cannot keep is worse than documenting cursor paging.                                                                                                                                     |
| ZeeRex Explain                                   | 2.0                                                        | P    | 58                       | Generated from the live `SearchAttributeRegistry`, so explain cannot advertise an index the compiler does not have.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| SRW (SOAP)                                       | 1.2                                                        | —    | **cut**                  | Not built.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| OAI-PMH                                          | 2.0 (2015 errata)                                          | B    | 59                       | GET **and POST**. Stateless HMAC-signed resumption tokens (no server state, survives restarts, cannot be forged into another tenant). **Day granularity accepted** even though seconds is declared; **set hierarchy containment** implemented (a record in `branch:main:ref` returns for `set=branch`); `oai:<public_name>.<apex>:<001>` identifier scheme with the `oai-identifier` container in Identify; `completeListSize` dropped rather than lied about. `deletedRecord=persistent` is a promise about the database — hence `deleted_at` and merge tombstones. |
| ResourceSync                                     | 1.1 (Z39.99-2017)                                          | —    | **cut**                  | Not built; OAI-PMH plus a signed nightly MARC dump serves the same need.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| SIP2                                             | 2.00                                                       | P    | 61                       | **96 = Request ACS Resend (SC→ACS); 97 = Request SC Resend (ACS→SC).** Bad checksum from the SC ⇒ ACS emits **97**. Resend messages carry no sequence number and must be answered with the byte-identical buffered previous response including its original AY digit. Error detection is negotiated in 99/98, not a per-device boolean. AO echoed in every response. **CP1253/CP737 per device** — a 2014 Bibliotheca unit renders Παπαδόπουλος as mojibake on UTF-8.                                                                                                |
| NCIP                                             | Z39.83-2012 v2.02                                          | B    | 62                       | **Conformance to NCIP Implementation Profile 1**, declared in `InitiationHeader/ApplicationProfileType`. Raw Z39.83 is not interoperable and "we support NCIP" is not actionable without the profile. Auth: Basic over TLS + IP allowlist + HMAC — deliberately not mTLS, because Cloudflare terminates TLS and client certs never reach the origin.                                                                                                                                                                                                                 |
| ILS-DI                                           | DLF 1.0                                                    | —    | **cut**                  | NCIP + `/api/v1` covers VuFind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ISO 18626                                        | 2021 (namespace unchanged since 2013)                      | B    | 63                       | Three message families with confirmations. Requester actions strict FSM; **supplier statuses permissive**. Parsing via `fast-xml-parser`; serialization hand-rolled (namespace prefixes and element order are validated against the XSD by partners).                                                                                                                                                                                                                                                                                                                |
| OpenURL 1.0 + 0.1                                | Z39.88-2004                                                | P    | 90                       | Public, unauthenticated, rate-limited, IPs hashed, 90-day retention. 0.1 legacy accepted — it is what older Greek systems emit.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| OpenSearch description                           | 1.1                                                        | P    | 31                       | Browser search autodiscovery. Unrelated to the OpenSearch engine despite the name; a comment says so in the file.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Atom / RSS                                       | RFC 4287 / RSS 2.0                                         | P    | 31                       | New arrivals cached 1 h; saved-search alert feeds are private, token-addressed, `no-store`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Sitemaps / robots.txt                            | 0.9 / RFC 9309                                             | P    | 31                       | Sitemaps **generated nightly into storage**, never computed per request. `Disallow: /*/search` and every facet URL — an OPAC's search space is infinite and is the classic way a catalogue is accidentally DDoSed by Googlebot.                                                                                                                                                                                                                                                                                                                                      |
| SBOM + signing                                   | CycloneDX 1.6, SPDX 2.3, Sigstore, minisign                | P    | 94                       | Two signature schemes on purpose: cosign for the supply chain, embedded-key Ed25519 for the disconnected site.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| OpenAPI + JSON Schema                            | 3.1.0 / 2020-12                                            | P    | 56                       | Generated, committed, gated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| RFC 9457 problem+json                            | 2023                                                       | P    | 56                       | `/api/v1` only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| CloudEvents                                      | 1.0.2                                                      | P    | 57                       | Webhook envelope. We emit the shape; no SDK.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GraphQL                                          | Oct 2021                                                   | P    | 89                       | Read-only — **no Mutation type exists**, asserted structurally. Persisted queries, depth 10, cost 2000, alias cap 50, batching refused.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| OAuth 2.0 / OIDC / SAML / LDAP / SCIM / WebAuthn | 6749+PKCE+9068+9700 / Core 1.0 / 2.0 / RFC 4511 / 2.0 / L3 | B    | 86–88                    | PKCE **S256 only**, no `plain`. SAML SP only, `@node-saml/node-saml` — hand-rolling XML Signature verification is malpractice; single-assertion, Reference-URI-bound, no re-serialization between verify and extract. SCIM hand-rolled (~600 lines). LDAP escapers (RFC 4514/4515) hand-rolled; the transport is not.                                                                                                                                                                                                                                                |

### Circulation, hardware and analytics

| Standard                              | Version                               | Role | Phase  | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------- | ---- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IANA tzdata                           | rolling                               | C    | 9      | `branches.timezone`, validated against `Intl.supportedValuesOf('timeZone')`. Every computation via `Intl.DateTimeFormat` parts — never offset arithmetic, never a date library, because a second tzdb is a second answer. **This is the circ-5 fix.**                                                                                                                                                                                                    |
| ISO 8601-1 / RFC 3339                 | 2019                                  | F    | 9      | `timestamptz` everywhere; retires the `NOW() AT TIME ZONE 'UTC'` workaround class.                                                                                                                                                                                                                                                                                                                                                                       |
| ISO 4217                              | current                               | F    | 1      | `bigint` minor units + `char(3)`, always paired. Multi-currency per account so a consortium never sums across them.                                                                                                                                                                                                                                                                                                                                      |
| **ISO 28560-2 / -3**                  | 2014                                  | B    | 78     | **-2 is the ISO/IEC 15962 OID-based variable-length encoding and is the Danish/Dutch/European default; -3 is fixed-length.** The desktop spec had these reversed. **AFI: 0xC2 = secured/in-library, 0x07 = unsecured/on-loan.** The desktop spec had this inverted, which alarms the gate on every checked-out book and lets every shelved book walk out. Checkout verifies by **read-back** before completing.                                          |
| PC/SC                                 | 2.01.14                               | C    | 78     | The one RFID transport needing no vendor SDK on any OS. Tier 1 ships without a partnership.                                                                                                                                                                                                                                                                                                                                                              |
| ISO/IEC 15693 / 14443                 | 2018 / 2020                           | C    | 78     | HF vicinity tags (items) and proximity cards (staff/patron). UID only from 14443; no proprietary sector data.                                                                                                                                                                                                                                                                                                                                            |
| ESC/POS                               | Epson TM                              | P    | 34     | Hand-rolled, ~300 lines. Available crates get **Greek codepages wrong**, and CP737/CP869/ISO-8859-7 selection is the thing that will be broken on day one in Thessaloniki. Raw to USB bulk / serial / TCP:9100 — never CUPS, never a browser dialog.                                                                                                                                                                                                     |
| ZPL II / EPL2                         | current                               | P    | 34     | One declarative template renders to **either ZPL or SVG**, so the preview is byte-equivalent to the print. Koha's label module drifts; this removes the class.                                                                                                                                                                                                                                                                                           |
| Code 128 / 39 / Codabar / EAN-13      | ISO 15417/16388/15420                 | B    | 32     | `packages/ui/Barcode.tsx` gains Codabar and EAN-13; Codabar is what most legacy Greek and US library barcodes are.                                                                                                                                                                                                                                                                                                                                       |
| RFC 5545 iCalendar                    | + RFC 7986                            | B    | 91     | Emitter hand-rolled (~120 lines; 75-octet folding + CRLF + a once-generated Europe/Athens VTIMEZONE). RRULE **expansion** uses `rrule` — BYSETPOS and DST crossings are a known trap — and occurrences are materialised as rows because each needs its own capacity and cancellation.                                                                                                                                                                    |
| ISO 2789                              | 2022                                  | P    | 26     | One derivation per element **plus `analytics.manual_statistics`** for staff FTE, expenditure, floor area, seats and satisfaction. Without that table every return still ends in a spreadsheet, which is what the feature exists to prevent. Every element card states its exact predicate; the tenant may override a definition and the override is recorded on the run.                                                                                 |
| ANSI/NISO Z39.7                       | 2013 (R2018)                          | F    | 26     | Field semantics used verbatim as the fact-table column meanings.                                                                                                                                                                                                                                                                                                                                                                                         |
| ISO 11620                             | 2014                                  | P    | 74     | Turnover, availability, hold fill rate, shelving accuracy (from `inventory_scans`), cost per loan. Every indicator renders a definition card and every run stores its compiled SQL so a disputed number is reproducible years later.                                                                                                                                                                                                                     |
| **COUNTER**                           | **5.1** (effective Jan 2025)          | C    | 87     | 5.1 replaced the flat `Report_Item.Performance[]` with nested `Attribute_Performance[]` and **removed `Section_Type`**. A 5.0-shaped parser fed a 5.1 report finds zero metrics and silently produces cost-per-use figures a library puts in a budget submission. Model 5.1 natively, treat 5.0 as a distinct input with an explicit up-converter keyed on the header `Release`.                                                                         |
| COUNTER_SUSHI API                     | 5.1                                   | C    | 87     | **`/r51/reports/...` path prefix for 5.1**; requesting `/reports/tr_j1` gets a 404 the retry policy would misread as transient. Credentials travel in the query string by the standard's design — mitigation is TLS plus adding the SUSHI URL to `log-redaction.ts` (the reliability-03 shape). Exception routing: 1011/3031 retry with backoff, 3030/3032 never, 2010/2020 disable and alert, 1010 record the capability and stop asking.               |
| **KBART**                             | **NISO RP-9-2014 (Phase II)**         | B    | 86     | The OPAC spec's "RP-2014-001" does not exist. **KBART Automation (RP-2019-01)** added as a harvest transport so provider files refresh on a schedule instead of by quarterly upload.                                                                                                                                                                                                                                                                     |
| UN/EDIFACT + EANCOM                   | ISO 9735:2002 v4; D.96A/D.01B         | B    | 85     | Hand-rolled. GIR qualifier mapping cited to the **BIC Library ordering guideline version** and held per-vendor in `quirks`, not hard-coded from a guess.                                                                                                                                                                                                                                                                                                 |
| ONIX for Books                        | 3.0/3.1, Codelists 68+                | C    | 85     | Codelists generated offline and **committed**; the build never fetches. ONIX 2.1 deliberately unsupported.                                                                                                                                                                                                                                                                                                                                               |
| Readium LCP + LSD                     | 1.0                                   | C    | 99     | **Ship the basic profile first** (`readium.org/lcp/basic-profile`) — no certificate, fully testable, makes phase-1 certification a config change. **Passphrase policy is stated: the patron's card number**, with a localized hint; only hint and key_check stored. `device_count` is driven by the **LSD register** response, not counted locally — register is a precondition of return and renew.                                                     |
| EPUB + EPUB Accessibility             | 3.3 / 1.1 (ISO/IEC 23761)             | B    | 99     | `accessibility_features`/`access_modes`/`accessibility_summary` displayed on the record page **and offered as a facet**. Required by the EAA since 28 Jun 2025 and shipped by no ILS OPAC.                                                                                                                                                                                                                                                               |
| WCAG / EN 301 549                     | 2.2 AA / v3.2.1                       | P    | 31, 96 | Four CI gates (jsx-a11y at `--max-warnings 0`, axe over rendered HTML, token contrast, nightly Playwright keyboard/focus/400 % reflow) plus a logged manual NVDA/VoiceOver/TalkBack matrix. **2.2.1 forbids an unwarned time limit**, so the kiosk idle reset warns at 15 s with an "I need more time" control. Per-tenant accessibility statement generated in the **Implementing Decision (EU) 2018/1523** format with a staleness alert at 12 months. |
| GDPR + Greek L.4624/2019              | in force                              | C    | 33, 96 | **Digital-consent age 15** (art. 21), frozen onto each registration. `check:dsar-coverage` makes it structurally impossible for a new patron-referencing table to escape the subject-access bundle. Erasure cascades through `change_events`, `sync_client_changes` and every device replica.                                                                                                                                                            |
| PCI DSS                               | 4.0 SAQ-A / P2PE                      | C    | 35     | Hosted checkout or P2PE terminal only. A `NoPanGuard` rejects any request body containing a Luhn-valid 13–19 digit run; no column may be named like a PAN.                                                                                                                                                                                                                                                                                               |
| Greek procurement / transparency      | Ν.4412/2016 (ΑΔΑΜ), Ν.3861/2010 (ΑΔΑ) | F    | 82     | First-class columns on orders, not custom fields. Every Greek public library is legally obliged to record both.                                                                                                                                                                                                                                                                                                                                          |
| AADE myDATA / POS interconnection     | current; L.4972/2022                  | P    | 80, 83 | Export shape only for myDATA. POS–cash-register interconnection is legally required for a Greek library taking card payments and is implemented by no international ILS.                                                                                                                                                                                                                                                                                 |
| ISO/IEC 27001 + SOC 2 TSC             | 2022 / 2017 (2022 PoF)                | C    | 96     | Readiness, not certification. SoA maps each Annex A control to a repository location. Named gap: A.8.32 change management vs commit-to-main — documented as an accepted risk with `verify.yml` as the compensating control.                                                                                                                                                                                                                              |
| CONSER Publication Pattern Initiative | current                               | C    | 83     | Pattern import by ISSN via the SRU/Z39.50 client, converted to a recipe and preloaded into the editor. **The default flow; hand-authoring is the fallback.** Without it nobody finishes 400 subscriptions and the module is abandoned.                                                                                                                                                                                                                   |

---

## 6. The phased roadmap

One phase = one session. Every phase ends with `pnpm check:all` green, the relevant test suites green, migrations applied, and a working app.

> **Amended after building eighteen of them.** The rule held for most and not for all: 9 shipped as 9a with the rest folded into 12–15 and 18, 10 as 10a + 10b, 19 as 19a + 19b, and 20 as 20a + 20b-i + 20b-ii + 20b-iii. Phases 7 and 8 each needed a follow-up defect commit. And `check:all` is a weaker promise than this sentence implies: it runs the static gates, typecheck and lint, but **no test suite, no build, and not `format:check`**, and `check:schema-drift` and `check:image-size` run only inside CI. `main` was red for eleven phases while every local signal was green — see the divergence log.

---

### M0 — Foundations (phases 1–6)

_No user-visible change. Every one of these is a prerequisite that, if landed later, forces a rewrite of everything built before it._

**1. Greek normalization + shared primitives.** `packages/shared/src/greek.ts` (accent fold, **final sigma ς→σ**, lunate/variant folding, ISO 843 Type 1 and Type 2/ELOT 743, ALA-LC, non-filing articles) with a 600-vector golden fixture; `packages/shared/src/callnumber` (DDC/LCC/UDC/NLM/alphanum/local → pure-ASCII fixed-width keys) with per-scheme golden shelf orders; `packages/shared/src/money` (bigint minor units, allocation with banker's rounding, the one documented crossing point); `packages/shared/src/currencies` + `check:currencies`; new subpath exports. `scripts/check-greek-folding.mjs` runs one fixture list through TypeScript, a Postgres `IMMUTABLE` wrapper and (later) the OpenSearch analyzer and the Rust fixture, failing on any divergence.
_Depends on:_ nothing.
_Accept:_ `foldGreek('ΠΟΛΙΣ') === foldGreek('πολισ') === foldGreek('πόλις')` — the measured defect (`normalizeText('ΣΟΦΟΣ')` ending U+03C2 while a typist writes U+03C3) is fixed. Call-number keys are pure ASCII (asserted over the full fixture corpus) and sort identically in Postgres under `el_GR.UTF-8` and in TypeScript. `check:greek-folding`, `check:currencies`, typecheck, lint, prettier green.

**2. Migration toolchain.** `packages/db-tenant/prisma/schema/` folder + `prisma.config.ts` (`schema`, `migrations.path`, `views.path`, `tables.external`); the **non-transactional online track** (`prisma/online/*.sql`) with `_libriant_online_migrations`, resumable batched backfills and `CREATE INDEX CONCURRENTLY`; `_libriant_schema_state` + control-plane `tenant_schema_state`/`migration_runs`/`migration_run_tenants`; `scripts/tenant-migrate.ts` gains the ledger, `--plan`, `--resume`, per-tenant timeout, barrier handling; `scripts/seed-v1-fixture.ts`. New gates `check:schema-drift` and `check:migration-safety`.
_Depends on:_ 1.
_Accept:_ `pnpm db:generate` emits a byte-identical client to before the split. `prisma migrate diff --from-migrations --to-schema-datamodel --exit-code` returns 0. `pnpm tenant:smoke` unchanged. A deliberately unsafe migration (CONCURRENTLY in the transactional track, a bare `now()`, an unqualified `gen_random_uuid`, a `CREATE INDEX` without `IF NOT EXISTS`, a timestamptz cast without `AT TIME ZONE 'UTC'`) fails CI.

**3. Permission model, applied to the 1.0 surface.** `packages/shared/src/permissions.ts`; `roles`/`role_permissions`/`staff_profiles`/`staff_role_grants`/`staff_permission_overrides`; `PermissionsService` (Redis + `FailOpenMemo`, fail-closed); `@RequirePermission` + `PermissionGuard` + numeric limits; built-in templates mapping 1:1 onto owner/admin/librarian/volunteer plus a narrower `support`; every existing controller migrated; `check:permissions` turned on.
_Depends on:_ 2.
_Accept:_ A route-by-route matrix asserts the new decision equals the old `@Roles`/`@StaffWrite` decision for every existing route. `circ.fine.waive` with `limit_num=500` waives €5.00 and refuses €5.01 with a 403 naming the limit. Support impersonation loses the four named permissions. Resolution p99 < 3 ms warm and fail-closed with Redis down. `check:permissions` fails on a deliberately undecorated route.

**4. Per-tenant Postgres roles.** `tenant_<id>_app` created at provisioning with database-scoped grants, connection limit, `statement_timeout`, `idle_in_transaction_session_timeout`; password sealed into the existing `tenant_db_credentials`; `TenantResolverService` composes the runtime URL in-process; `tenants.db_url` degrades to the migration-only superuser URL; `scripts/tenant-rotate-db-creds.ts`; backfill for existing tenants.
_Depends on:_ 2.
_Accept:_ Tenant A's **runtime** connection string is refused by Postgres when pointed at tenant B — the audit's original demonstration no longer reproduces at any layer. `assertUrlBelongsToTenant` unchanged and still covered. Rotation swaps with zero failed requests. No superuser URL in any log, error or metric label. Closes tenant-isolation-02/03.

**5. Metrics registry + queue consolidation.** `apps/api/src/observability/metrics.registry.ts` with `defineMetric({name, help, type, labels, alert})` as the single declaration site; `check:alerts` rewritten to read declarations and to assert **both** directions; `EMITTERS` widened to `apps/protocol-gateway/src` and a Rust declaration file; the merged six-queue list wired into `worker.ts` in all four places (healthz map, readyz `handlesUp`, metrics, shutdown) per REL-04; `tenant-pool-budget.ts` extended.
_Depends on:_ 2.
_Accept:_ Every metric named in a rule is declared; every metric declared `alert:true` has a rule. `/readyz` returns 503 when any registered consumer is not running. Aggregate connection budget documented and asserted.

**6. The port boundary + public-API registry skeleton.** `DataPort` / `PlatformPort` / `PrintPort` interfaces and the `HttpDataPort` implementation; every 2.0 staff screen from phase 20 onward is authored against `DataPort`, never bare `fetch`, so the Tauri client in M8 is an additive implementation rather than a rewrite of sixty screens. `apps/api/src/public-api/registry.ts` with `defineEndpoint`, the `class-validator` → JSON Schema deriver, and `check:openapi` (no public routes yet). **1.0 screens are not extracted** — they are about to be replaced.
_Depends on:_ 3.
_Accept:_ An ESLint rule fails on `fetch(` inside a screen component. `check:openapi` passes against an empty registry and fails on a deliberately drifted fixture.

> **After M0** — nothing a librarian can see. Internally: Greek search is correct, permissions are real and enforced, a tenant credential opens exactly one library, migrations can be safe and online, and the schema is ready to be replaced.

---

### M1 — ILS core: the MARC store and the policy engine (phases 7–18)

**7. `packages/marc` — the codec.** Types; ISO 2709 reader (lifted from `import/parsers/marc-parser.ts` with its three defects fixed — structure discarded, indicators dropped, subfield code read past buffer end) and writer with the corrected leader rules; MARCXML reader + hand-rolled writer; MARC-in-JSON; MARC-8 both directions with generated+committed LC tables, per-field designation reset and string-valued multi-character mappings; NFC/NFD policy; MARC path grammar; `applyOps` with `$6`/880 occurrence renumbering as a post-condition; `diff`; canonical hash excluding 005; NACO + Greek normalize re-exported from `@libriant/shared`. `scripts/gen-marc8-tables.ts`. Uses WebCrypto, no `node:` built-ins, so it runs in a webview.
_Depends on:_ 1.
_Accept:_ Property test over ≥5,000 records (_amended: the corpus is **generated**, not real — this repository has no real MARC and the authoring session had no way to obtain any. `generateCorpus(n)` emits ISO 2709 bytes from an independent hand-written emitter parameterised by per-exporter quirk profiles, which is what makes the round-trip meaningful: two independent implementations agreeing, rather than one agreeing with itself_): `parse(serialize(parse(b))) ≡ parse(b)` for all, and `serialize(parse(b)) === b` byte-for-byte for ≥98 %, residue documented per record. Every serialized leader matches `^.{10}22.{9}4500$`. MARC-8 round-trips LC's codetable vectors including combining-mark-before-base reordering and the U+FE20–FE23 pairs; a Greek 245 followed by a Latin 260 both decode correctly (designation reset). `applyOps` inserting a paired field renumbers every `$6` on both sides. `check:greek-folding` still green.

**8. Format definitions and the validator.** `scripts/gen-marc-schema.ts` → committed Avram JSON for MARC21 bib/authority/**holdings (008 included)** and UNIMARC bib/authorities; _(Amended: **one** of the five shipped — `marc21-bibliographic.json`. The other four are typed refusals, each with a reason. The one that matters commercially is **UNIMARC**, because that is what ABEKT exports and therefore what the Greek market runs on; §5 assigns it to phase 50 and decision 12 makes it a launch requirement, so the gap is real and dated rather than forgotten. The shipped file also declares `"version": "unknown — see coverage.limits"` and a `coverage.source` of hand transcription, not generation from a vendored authority — so §5's "Update 39" and §5's "generated and committed" are both aspirations.)_ the layered loader (shipped ← tenant override); the validator; RDA/AACR2/ISBD/UNIMARC rule packs as data; `validateDelta`. New gate `check:marc-schema`.
_Depends on:_ 7.
_Accept:_ Zero false positives on LC-published-valid records. A record with a repeated 245, an illegal 6XX ind2, an obsolete 440 and a 3-char indicator each produce exactly one precisely-worded issue naming tag, occurrence and rule. `validateDelta` returns an empty blocking set on a neutral edit to a record with 12 pre-existing errors. `check:marc-schema` fails on a hand-edited definition and on a template binding a tag absent from its definition.

**9. The 2.0 baseline migration.** _(Amended: shipped as **9a** — seventeen tables, not the ~219 §3 names: the ten §3 specifies with a full `CREATE TABLE` block, five skeletons forced by their foreign keys, `audit_log`, and one support table. Notices, bookings, `custom_field_values` and the settings singletons were not in it; they arrived with phases 12–18 or are still deferred. `prisma/schema-v2/BASELINE-SCOPE.json` is the authority on which of the 184 exist, and `check:schema-conventions` fails if that manifest and the schema disagree — so the gap is enumerated rather than lost.)_ One squashed migration creating the cross-domain tables in §3 — branches (with the cycle trigger, ISIL, **timezone**), service points, shelving locations, calendars, item/material types, patron categories, patrons + cards, holdings, items, the MARC store trio, loans, holds, fees + ledger, notice tables, bookings, roles/permissions, `change_events` + generated triggers, partitioned `audit_log`, `sync_client_changes`, `custom_field_values`, settings singletons — plus `btree_gist`, `btree_gin`, `record_version_seq`, `default_toast_compression=lz4`. **No services yet.** `check:changelog-coverage` and `check:schema-conventions` land here.
_Depends on:_ 2, 8.
_Accept:_ Applies to a fresh tenant DB and to a 1.0 tenant DB (as a second schema, not yet cut over). Every hand-written index, partial unique, CHECK, generated column and EXCLUDE constraint exists in a freshly migrated DB, asserted by an integration test — a forgotten migration fails CI rather than production. Overlapping calendar exceptions raise `23P01`. A non-IANA timezone is rejected. Every replicated model has a change trigger and vice versa. `pnpm tenant:smoke` (split per module) green.

**10. MARC store: write path, versions, locks.** `apps/api/src/bib` — the single `write()` (advisory lock → hash precondition → `applyOps` → NFC → 005 stamp → `validateDelta` → hash → version → audit), record locking in Postgres with heartbeat/expiry/take-over, version list/diff/restore.
_Depends on:_ 9.
_Accept:_ Create → edit one subfield with `expectedContentHash` → version count 2, diff names exactly that subfield, restore returns to v1 and creates v3. A stale hash returns 409 with the current record and a diff and writes nothing. Two concurrent PATCHes: one succeeds, one 409s, exactly one new version row. Two consecutive edits produce strictly increasing 005. Lock acquire/heartbeat/expiry/take-over each write the expected audit action.

**11. Projection, satellites, serialization.** `bib-projection.ts` (pure, total, never throws — records an anomaly instead), `bib_records`/`bib_identifiers`/`bib_classifications` written in the same transaction; holdings auto-creation; `GET /catalog/bib/:id.(mrc|xml|json)`; streamed `catalog_marc` export format; `scripts/catalog-verify.ts` + the nightly drift job.
_Depends on:_ 10.
_Accept:_ Import a 10,000-record `.mrc` through the API, export it, and the export re-parses to identical records. `catalog-verify` reports zero drift over those 10,000. A 25-row catalogue page issues **no TOAST reads** (`EXPLAIN (ANALYZE, BUFFERS)`). The projector is fuzzed against structurally hostile records and never throws. `libriant_catalog_projection_drift_total` emitted and alerting.

**12. `packages/circ-policy` — the pure resolver.** Types, `specificity`/`rank` (mirroring the SQL generated column), `resolve`, `calendar` (`isOpenAt`/`nextOpen`/`openDaysBetween` via `Intl.DateTimeFormat` parts), `duedate`, `fines`, `blocks`, `resolveTemplate`, and `fixtures/resolution-vectors.json` (~400 cases). Greek movable-feast seeder (Julian Paschal, ~40 lines).
_Depends on:_ 1.
_Accept:_ Pure — no I/O, no `Date.now()`, asserted by test. All ~400 vectors pass. Golden vectors cover Europe/Athens DST in both directions, a 2-hour loan starting 01:30 on a spring-forward night, the Greek split day (08:00–14:00 + 17:00–21:00), and Orthodox movable feasts 2026–2030. `rank()` equals the SQL column for all 64 selector combinations.

**13. Policy engine service.** `apps/api/src/policy` + `apps/api/src/org` — the five policy tables, `patron_category_limits`, `PolicySnapshotService` (Redis version + pub/sub + process LRU), simple-mode façade over the wildcard rule, preview endpoint, `/circulation/explain`, `TenantClockService` + the ESLint ban on raw `Date` arithmetic in `circulation/`.
_Depends on:_ 12, 9.
_Accept:_ Deleting or disabling the wildcard rule is refused with a typed error; a duplicate scope 409s from the partial unique. A policy write bumps `circulation_policy_version` **in the same transaction** and every pod serves the new snapshot within 1 s (pub/sub) or 30 s (TTL). Resolution p99 < 0.2 ms over a 500-rule snapshot. `/circulation/explain` returns `matchedRuleId`, `beatenRuleIds` and the calendar rolls applied.

**14. Patrons 2.0.** Service layer over the baseline tables: categories, patrons, cards, identifiers, addresses, relationships, blocks (with the `ON CONFLICT` recompute), messages, notes, merge, number minting (`UPDATE … RETURNING`, never `max()+1`), GDPR erase/export extended to the new tables.
_Depends on:_ 13.
_Accept:_ Merge is transactional under sorted `patron:` locks; an old card barcode resolves through `merged_into_id` in **one hop**, never a chain; balances sum per currency. A concurrent block-recompute racing a desk transaction never aborts the desk transaction (25-way repro). `patrons_number_pattern_idx` with `text_pattern_ops` serves `LIKE 'M-2026-%'` under `el_GR.UTF-8` (perf-13 preserved).

**15. Items, holdings, call numbers.** Service layer: item types, material types, holdings auto-creation, items with a **single status writer**, `item_status_history`, notes, transfers, call-number sort recomputation.
_Depends on:_ 11, 13.
_Accept:_ `items.status` is writable through exactly one service (ESLint boundary rule + a grep gate). Every transition writes history. `items_shelf_available_idx` is used by the hold-promotion probe (EXPLAIN asserted). `items_shelf_order_idx` serves `ORDER BY current_branch_id, call_number_sort` with an Index Scan and no sort node. Only one open transfer per item is possible.

**16. Circulation engine, part 1.** `apps/api/src/circulation`: checkout, checkin with `CheckinDisposition`, renew (single/batch/all); `loan_events` with `occurred_at` **and** `effective_at`; `sync_client_changes` written in-transaction; `circulation_statistics` + `partition-maintenance`; `locks.ts` that **sorts** keys by domain rank (patron < bib < item) before acquiring, with a CI grep forbidding a bare `pg_advisory_xact_lock` outside it.
_Depends on:_ 14, 15.
_Accept:_ Policy resolved once and frozen; editing a rule afterwards provably does not change an open loan's due date or fine. One-open-loan-per-item holds under 25-way concurrent checkout of the same item. Replaying a `client_change_id` returns the stored response and re-applies nothing; a mismatched `request_hash` 409s. Zero deadlocks across a 4-way mixed workload for 10 minutes. Checkin p99 < 40 ms with ≤ 12 statements per transaction.

**17. Holds 2.0.** Title/volume/item-level requests, pickup-branch policy, transit routing, suspension with date ranges, priority override, group holds, the promotion algorithm, hold shelf + pull list, expiry and transit-timeout jobs.
_Depends on:_ 16.
_Accept:_ Queue positions stay contiguous and 1-based across every mutation **including skipping a suspended hold**; a named regression test fails under the 1.0 blanket `> 0` decrement. Three copies returned concurrently against five mixed holds (one suspended, one with an ineligible pickup branch) fill exactly three, strand zero items, 25 runs. A routed hold reaches `awaiting_pickup` only on transit receipt and no ready-notice fires while in transit.

**18. Fees ledger.** Fee types, accounts, fees, transactions, entries, allocations, payment methods, cash drawer, receipts (render once, store bytes, reprint verbatim), `ledger-reconcile` + drift metric.
_Depends on:_ 16.
_Accept:_ Property test: 10,000 random charge/pay/waive/refund/write-off sequences leave every reconciliation identity intact. The `fees_one_open_accrual_per_loan` upsert survives a return racing the accrual sweep without aborting the return (DATA-1 repro, ported). A reprint is byte-identical. A drawer close with a variance records it rather than adjusting. `libriant_circ_ledger_drift_total` emitted and alerting.

> **After M1** — the 2.0 core exists and is exercised by tests, but no librarian is using it yet. 1.0 still serves.

---

### M2 — The cutover (phases 19–20)

> **Amended after building it.** Phase 19 became 19a + 19b and phase 20 became
> four, because the original text was written before phases 10–18 existed and
> assumed a parity between 1.0 and 2.0 that those phases did not produce. The
> measurements behind every change here are in the divergence log
> (`README.md`, sections "Phase 19b", "Phase 20a", "Phase 20b-i" and
> "What 20b-ii faces"). Phase NUMBERS remain stable identifiers; the letters
> are sub-phases of one deliverable.

**19a. The upgrade surface.** ✅ **Shipped** (`0af96b3`). `prisma/upgrade/routing.json`
routes all 233 1.0 columns as `copied` / `derived` / `dropped` (with a reason) /
`compat`, gated by a new `check:upgrade-coverage` that fires on a missing, stale
or unreasoned entry and on an unrouted table. Eleven **compat twins** in 1.0's
physical shape for the columns 2.0 has no home for yet, plus `ledger_account.opening_balance`,
`event_source.migration`, `loans.notes`, `fees.notes`, `fees.archived_at` and three
custom-field columns.
_Depends on:_ 18.
_Accept:_ `check:upgrade-coverage` fails on a column added to 1.0 and not routed.

**19b. The copy-forward and the verifier (dry runs only).** ✅ **Shipped** (`1f5bd06`).
`packages/db-tenant/prisma/upgrade/{01-pre-catalog,02-post-catalog,03-verify}.sql`
plus `scripts/tenant-upgrade-v2.ts` as the orchestrator — **not** a single
`v1_to_v2.sql`, because MARC synthesis runs through the real `packages/marc`
codec in Node rather than a SQL port of it that would only ever have to agree
with the first implementation. MARC built from every `books` row with 001 = the
existing cuid so every permalink and audit target still resolves, 005 from
`updated_at`, 008/00-05 from `created_at`, computed non-filing indicators,
holdings per shelf location, an item per copy, loans with `closed_at`
back-filled and `policy_snapshot` synthesised, reservations → title holds, fines
→ fees with synthetic transactions, `audit_log` routed to monthly partitions.
**42** assertions, not ~40. `scripts/seed-v1-fixture.ts` builds the fixture in
two profiles (`ci`, `acceptance`); CI seeds and upgrades it on every commit.
There is no `--commit` in this phase by design.
_Depends on:_ 19a.
_Accept:_ All 42 assertions hold on the `ci` profile — row counts exact,
outstanding money identical to the cent, every cuid preserved, every instant
within 1 s of the v1 value read as UTC, hold ORDER preserved exactly. A
deliberately corrupted fixture aborts and leaves the database byte-identical.

> **Two corrections this phase measured.** "Bit-exact queue positions" cannot
> survive and is a stated divergence — 1.0 permits duplicates and gaps that
> 2.0's constraints refuse, so the ORDER is preserved and the NUMBERS are
> renumbered. And the rollback is one statement at this point,
> `ALTER SCHEMA v1_archive RENAME TO public`, because §6's two-step recipe fails
> with `schema "public" does not exist` until the promotion exists.

**20a. The 2.0 read surface.** ✅ **Shipped** (`96adbd8`). The cutover had nothing
to repoint AT: `lbr2` had no list or search endpoint for anything. Twelve read
routes — catalogue search, patron roster, items by bib and by barcode, loans,
holds, fees, branches, locations — with **zero new permission keys**, one shared
keyset helper (`platform/list.ts`) so eleven lists cannot each drop the tie tier,
and `platform/like.ts` because Prisma's `contains` does not escape LIKE
metacharacters. Six keyset indexes; a seventh was written, measured to displace
`items_shelf_available_idx` on the hold-promotion path, and removed.
_Depends on:_ 19b.
_Accept:_ **§9's Greek case, over HTTP:** `πολισ` finds `Η ΠΟΛΙΣ ΕΑΛΩ`, as do
`ΠΟΛΙΣ`, `πόλις` and `ΠΌΛΙΣ`. It needs **no migration**: `search_text` is already
folded and trigram-indexed, and `libriant_fold_greek` is installed by no
migration so calling it would throw. Four records tying exactly on `sort_title`
walk at `limit: 1` with no row repeated and none skipped.

**20b-i. The cutover mechanism.** ✅ **Shipped** (`5947033`). `--commit`, guarded
by an explicit `--yes`. The promotion `ALTER SCHEMA lbr2 RENAME TO public` **plus
six `ALTER EXTENSION … SET SCHEMA public` in the same transaction** — without
them `DROP SCHEMA v1_archive CASCADE` deletes `patrons.email`, both trigram
indexes and all three no-overlap constraints, announced as a NOTICE that
`ON_ERROR_STOP` does not stop. `04-promoted.sql` adds **8** assertions run under
the application's own `"$user", public`, which is the only path under which the
citext failure is visible at all. `scripts/tenant-rollback-v2.ts`, because after
the promotion §6's recipe SUCCEEDS and destroys the archive it exists to restore.
A `pg_proc` pre-flight refuses a database whose function bodies name `public.`
rather than rewriting them.
_Depends on:_ 20a.
_Accept:_ CI cuts a disposable database over for real, asserts the committed
shape, DROPS the archive to prove that is now safe, then rolls back on a second
copy and reads 1,000 books / 500 members / 800 loans out again. Both flags
refuse without `--yes`; a second rollback refuses.

**20b-ii. Parity — what 1.0 does and 2.0 cannot.** The phase the original text
did not know it needed. Of the 46 1.0 routes, **zero have a clean drop-in
equivalent and 21 have none at all**; deleting the five modules before this is
built takes a Greek library's GDPR compliance offline. Build, in this order:
the **Article 15/20 subject-access bundle** over 2.0 (`patron-data-map.ts` is the
specification and `BUNDLE_TABLES` has zero consumers — the bundle must be
written, not repointed) and the **Article 17 erase** (2.0 writes
`patrons.erased_at` nowhere); patron read-by-id, update, status change and
archive; bib delete/archive; cover upload and patron photo; the overdue-fine
sweep, without which a patron holding an overdue book shows a zero balance at
the desk; and the import engine's 2.0 write path. Move the five integration
specs that hard-code `table_schema = 'lbr2'` onto a shared constant, or they go
green and vacuous the moment 20b-iii promotes.

And the piece no earlier text noticed: **the deletion is fleet-wide and the
upgrade is one database at a time.** `tenant-upgrade-v2.ts` takes a single
`--url`; deleting the 1.0 modules is one deploy that reaches every tenant at
once. Between the two, an un-upgraded tenant is served by code that cannot read
its schema. The flag for this already exists and nothing uses it:
`TenantSchemaState.schemaMajor` is documented as "1 = the pre-2.0 shape; the 2.0
upgrade sets 2", `scripts/tenant-migrate.ts` reads and caches it, and
`tenant-upgrade-v2.ts` never writes it. So 20b-ii makes the upgrade stamp it, and
gives the app a routing decision keyed on it — or 20b-iii must upgrade every
tenant inside the same window as the deploy, which is not a thing a deploy can
promise.
_Depends on:_ 20b-i.
_Accept:_ Every 1.0 route either has a named 2.0 successor or a written decision
that the capability is deliberately lost. A DSAR bundle and an erase run against
a 2.0 tenant and are asserted by an integration spec. `check:dsar-coverage` —
promised by §5 at phases 33/96 and never built — lands here instead, because the
cutover is the moment a patron-referencing table can silently escape the bundle.

> **Deliberately lost, and stated rather than discovered:** authors as an entity.
> 2.0 has no `Author` model and an authority MARC record gets no projection row,
> so the five 1.0 author routes do not come back; contributors live inside the
> MARC record until the authority store lands at phase 45. Mark-lost and
> claims-returned stay assigned to phase 21 and the loan-detail buttons go with
> them until then.

**20b-iii. THE CUTOVER.** One session, one commit: run the upgrade on the demo
tenant with `--commit --yes`; delete `apps/api/src/{catalog,loans,reservations,fines,members}`
and their specs; repoint the staff UI at the 2.0 routes; rename `V2_SCHEMA` to
`public` and rewrite the **377 `lbr2.` literals across 57 files** (189 in source,
188 in tests) that the promotion invalidates; retire the 1.0 locale namespaces —
which means **creating** the 2.0-shaped ones first, since none exists to retire
into.

_Two corrections to the original instruction._ "Drop `books_isbn13_unique_active`
and `authors_sortname_unique_active`" is a **no-op**: both sit on `books` and
`authors`, which the rename carries into `v1_archive` index and all, and `lbr2`
has no ISBN uniqueness to begin with — §3's "deliberately not unique in 2.0" is
already true by construction. And `check:translations` is **not** the gate for
the namespace work: it reads `locales/` only and never opens a source file, so it
passes cleanly on a namespace deleted while code still calls its keys. The
failure is silent — `createTranslator` returns the key id and `loadNamespace`
swallows ENOENT — so the namespace retirement needs a gate that reads source, or
it needs doing by grep and reviewing.
_Depends on:_ 20b-ii.
_Accept:_ Two ISBN-sharing books that the 1.0 constraint refused both migrate and
appear as one duplicate candidate. All CI gates green, full unit + integration +
smoke + both builds pass, and every retired locale key proved unreferenced by a search of the source rather than by `check:translations`, which cannot see it.
Before this session the system runs 1.0; after it runs 2.0.

> **On the marketing claims.** §6 said "rewrite the four `pages.{en,el}.json`
> claims that say MARC does not come out and there is no public catalogue".
> There are **twenty**, not four — ten MARC and eleven catalogue strings per
> locale — and the instruction conflates two claims of which only one is false.
> The MARC claims were already false before this milestone, because
> `catalog_marc` has been a bulk export format since phase 11. **The
> public-catalogue claims must stay**: the OPAC is phase 31, and rewriting them
> here would make the site advertise something that does not exist.

> **After M2 — a real library can:** hold a full MARC 21 record as the system of record, export it as ISO 2709 / MARCXML / MARC-in-JSON that round-trips, see every version of every record with a field-level diff and restore any of them, run circulation under a real rules matrix with per-branch calendars and timezones so due dates roll off closed days and fines are calendar-day rather than 24-hour blocks, ask _why_ a book is due on a given date and get the rule that decided it, and take a partial payment against a real double-entry ledger. **Koha, Alma and FOLIO cannot answer the "why this due date" question at all.**

---

### M3 — Circulation complete (phases 21–26)

**21. Circulation engine, part 2 + the unified desk.** Declare-lost, mark-found with refund, claims-returned / claims-never-borrowed, recall, transfers with the transit desk, overrides with reason codes and `override_permissions`, fast-add; the unified desk UI (patron pane + item pane + disposition card + block banner + due-date explainer) on the responsive layer.
_Accept:_ A lost loan closes and the item can later be marked found and returned without violating any constraint — the 1.0 dead end. Every operation is keyboard-reachable; the disposition card is announced via `aria-live`; block banners are `role=alert`; axe reports zero AA violations.

**22. Notices engine.** Templates/triggers/queue/deliveries/suppressions; the `notices` queue; the sandboxed `{{var}}`/`{{#items}}` renderer over a fixed allowlist (no Handlebars — a general engine on librarian- and plugin-authored templates is an RCE and prototype-pollution surface); quiet hours in the branch timezone; digests; channel priority; email via the existing driver stack, SMS via a console driver plus Yuboto/APIFON/Twilio REST clients with **GSM-7 segment counting** and a monthly budget cap; RFC 8058 unsubscribe. `member-notifications.job.ts` deleted.
_Accept:_ The same `dedupe_key` twice produces exactly one row (the index proves it). A notice inside quiet hours defers, never drops. A hard bounce writes a suppression keyed on the address hash that survives erasure of the address. Crossing the SMS cap degrades to email and alerts. Fuzzing the template body executes nothing. `EMAIL_DRIVER=console` still works end to end.

**23. Multi-branch operations.** Branch CRUD + hierarchy UI, calendars/hours/exceptions UI, branch switcher stamped into the session, transit send/receive/overdue-in-transit, floating rules, per-branch policy resolution (branch → library → tenant), branch-scoped dashboards.
_Accept:_ A 4-branch fixture: an item owned by A, checked out at B, returned at C either floats or generates a transit per `floating_rules` — both tested. A loan taken Friday at a branch closed Sat–Mon is due Tuesday and accrues no weekend fine. **circ-5 closed**, with a regression test that fails under the 1.0 arithmetic.

**24. Inventory / stocktaking.** Sessions, scans, shelf-order verification via `call_number_sort`, misplaced/wrong-branch/missing detection, two-step preview-then-close, full revert.
_Accept:_ A 50,000-item session uploads in bounded memory (COPY, no unbounded array). Shelf-order flags reproduce a known mis-shelved set. Items on loan, on hold or in transit are **never** marked missing. Revert restores every item and the session to `reviewing`.

**25. Course reserves.** Terms, departments, instructors, courses, reserves that set `temporary_item_type_id` / `temporary_location_id`; term rollover.
_Accept:_ "Reserve items are 2-hour in-library loans" is expressed entirely as a normal rule; grepping `circulation/` for `reserve` returns nothing. Removing the reserve restores the permanent values.

**26. Reports: ISO 2789 + the analytics schema.** `analytics` schema with partitioned facts and the pseudonymous patron dimension; the watermark-driven refresh job from `circulation_events`/`change_events`; the separate analytics pool + `PG_ANALYTICS_URL` (with `assertUrlBelongsToTenant` extended to an explicit host allowlist rather than incidentally permitting a replica); the ISO 2789 element catalogue; **`manual_statistics`**; fixed report definitions rendering to CSV/XLSX; `report_runs` storing the compiled SQL and parameters.
_Accept:_ ISO 2789 loan totals reconcile exactly with `count(*)` over `loans` for 12 months. `dim_patron` contains no name, email or DOB (column-level test). No report runs on the circulation pool — proved by saturating the analytics pool while checkout latency is unchanged. Every run is reproducible from its stored SQL years later.

> **After M3 — a real library can:** run every counter operation of a multi-branch service (checkout, return, renew, holds with transit, lost/found/claims, overrides, cash drawer, receipts), send due-soon / overdue / hold-ready notices in Greek by email with quiet hours and digests, take a full inventory and find its mis-shelved books, run course reserves with no special-case code, and **file its annual ISO 2789 statistical return from the system instead of a spreadsheet.**

---

### M4 — Public library launch (phases 27–35)

**27. Search: the Postgres backend.** `packages/search` with `SearchBackend`, `SearchRequest`/`SearchResponse`, capability negotiation, the `SearchAttributeRegistry`; `bib_search_projection` and `browse_terms` fed from `change_events`; weighted tsvector + trigram + the Greek fold + the phonetic (Greeklish) key + the ISO 843 Type 2 column; facets, browse, `/t/:slug/search`.
_Accept:_ A 250k-record library answers a faceted keyword search p95 < 300 ms with OpenSearch **not installed**. `vivliothiki` finds `βιβλιοθήκη`; an unaccented query finds accented records; a final-sigma query finds the medial form. Facet counts are correct with three filters active. Call-number browse matches physical shelf order for 500 LC and 500 Dewey items. Killing the indexer mid-load and restarting loses nothing.

**28. Dual-mode editor, part 1.** `catalog_templates` with the seeded system set (Book RDA, Book AACR2, Serial, DVD, Sound recording, Electronic resource, Map, Manuscript, Greek monograph UNIMARC, Fast-add); the raw MARC editor; the definition-driven 006/007/008 positional editor; record lock banner; `marc` locale namespace.
_Accept:_ An 008-bound widget rewrites only its positions and leaves the other characters byte-identical, including on a 39-character 008 (padded, anomaly recorded). Keyboard-only completion of a full record; axe zero AA violations.

**29. Dual-mode editor, part 2.** The simple form over `form_layout`; **path-op emission only for widgets the user changed**; the mandatory **Advanced content** panel; record diff view.
_Accept:_ Given a record with 41 fields of which the Book template models 11, changing only the subtitle produces a version whose `changed_tags` is exactly `['245']` and whose diff touches exactly `245$b` — the other 40 fields byte-identical. Clearing a bound widget on a 3-subfield field deletes one subfield and keeps the field; clearing the last deletes the field, prompting about a paired 880. Editing a record that already fails validation six ways succeeds with six warnings. Switching raw ↔ simple mid-edit preserves unsaved changes.

**30. Copy cataloguing.** BER codec + Bib-1 attribute map + CQL→RPN (from `packages/protocols`); the Z39.50 and SRU **clients**; `copy_cataloguing_targets` with Greek presets (NLG, EKT/ABEKT union, HEAL-Link, major university libraries) and international (LC, DNB, BnF, BL, K10plus) shipped `enabled=false` until a probe job flips `verified_at`; parallel fan-out (max 6), merge/dedupe clustering, candidate scoring (encoding level, 6xx presence, `040$b = gre` preferred for Greek tenants, RDA flag); one-click import rewriting 001/003 into 035; **`marc_overlay_rules`** with protect/replace/merge per tag and the encoding-level guard.
_Accept:_ Against a live LC target an ISBN search returns MARC21 bytes that parse identically. A target that hangs, returns 8 MiB, closes mid-APDU or resolves to a private address is refused per-target without affecting the other five. Re-importing the same remote record twice produces one bib and two source rows. **Overlaying a fuller record preserves local 9XX, 852, 590 and 650 \_4 and refuses a weaker Leader/17**, and the overlay is a versioned, undoable op set — which no incumbent offers. A preset that never verifies stays invisible rather than timing out in front of a cataloguer.

**31. OPAC, part 1: the public catalogue.** `apps/opac` on `opac.libriant.com` with its own Caddy vhost, CSP and cache policy; `/opac/:slug/*` API surface (`PublicTenantMiddleware`, `PublicOpacGuard`, search, record display in ISBD and friendly views, live availability, browse); `opac_settings` + contrast-validated `opac_branding`; robots.txt, nightly sitemaps, OpenSearch description, Atom feeds, schema.org JSON-LD, COinS, unAPI; deep-paging refusal; `packages/app-kit` extraction; the four accessibility gates.
_Accept:_ An anonymous browser searches with zero cookies. Availability is uncached while the rest of the record page is edge-cached (two curl runs, age header). `from+size > max_result_window` returns 400 with a refine-your-search body and links to OAI/SRU as the bulk path. `visibility='off'` 404s the host; `unlisted` emits `X-Robots-Tag: noindex`. A staff cookie on `/opac/*` is ignored. `check:a11y`, `check:contrast`, jsx-a11y, `check:opac-cache`, `check:caddy` green.

**32. OPAC, part 2: patron identity.** `patron_identities`/`patron_sessions`/`patron_privacy_settings`/`patron_contact_endpoints`; `PatronSessionService` on a **distinct `PATRON_SESSION_SECRET`** with `__Host-lbr_patron`; `PatronSessionMiddleware` + `PatronGuard` + `PatronStepUpGuard`; password / magic-link / card+PIN with lockout; read-only my-account; device list and sign-out-everywhere; offline card page with a Code128/Codabar barcode.
_Accept:_ The cross-plane probe suite enumerates **every registered route from the Nest router at test time** and asserts each rejects the other plane's cookie — so a new route is covered the moment it is registered. A PIN session (aal=1) is refused a profile email change, a data export and a credential change. Sign-out kills the session on another device within one request. Loading `/account/*` twice offline never serves the previous patron's loans.

**33. OPAC, part 3: account writes + registration.** Renew (through the policy engine, with `Idempotency-Key`), place/cancel/suspend holds with pickup choice and own-hold reordering, saved searches, lists, reading-history opt-in wired to the anonymisation path, household delegation; self-registration with double opt-in, **guardian double opt-in under the Greek age of 15**, duplicate detection and a staff approval queue.
_Accept:_ A patron renew hits the same policy refusal a librarian would, with the same error code. A double-submitted renew replays with `X-Idempotent-Replay`. With `keep_loan_history=false`, returning nulls `patron_id` and stamps `anonymised_at` in the same transaction while circulation statistics are unchanged (count before/after). A 12-year-old's registration cannot reach the staff queue without a confirmed guardian — enforced by the CHECK constraint as well as the service. The consent age in force is frozen onto the row.

**34. Printing.** Hand-rolled ESC/POS builder with CP737/CP869/ISO-8859-7 selection; the ZPL II / EPL2 renderer sharing **one declarative template** with the SVG preview; cash-drawer kick with `hw_event_log`; delivered through the existing Electron silent-print bridge.
_Accept:_ A Greek receipt prints correctly on an Epson TM-T20III (photographed acceptance) and the same bytes are asserted against a golden file in CI. A Zebra ZD421 spine label is dimensionally identical to its SVG preview. Every drawer kick is audited.

**35. Migration adapters.** `SourceAdapter` + `CanonicalRecord` layered on the existing parsers/mapping/engine; adapters for **ABEKT**, **Koha** and generic MARC; the migration report (field-level coverage matrix, rejection reasons, duplicate clusters, in-flight state reconciliation, PII findings, deterministic diff against the previous dry run); the credential policy — no MD5/crypt/plaintext ever, bcrypt/argon2 only with a signed acknowledgement and forced re-hash on first login, `must_reset` otherwise.
_Accept:_ A real ABEKT UNIMARC export in windows-1253 imports with correct diacritics and final sigma. A Koha dump imports bibs, items, patrons, live issues with due dates, reserves with **queue positions preserved**, and accountlines reconciling to the cent. Running the same export twice changes no row count and no total. The dry-run report names every dropped source field with a reason. A patron whose notes contain an ΑΦΜ-shaped string is quarantined, not imported.

> **After M4 — a real Greek public library can go live.** It has a public catalogue that Google can index and Zotero can capture, patron accounts with renewals and holds, self-registration with lawful guardian consent, copy cataloguing from NLG and LC with local-field protection, Greek receipts and spine labels, a migration path off ABEKT or Koha with a report that says exactly what came across — and reading history that is anonymised on return by default. **This is the launch line.**

---

### M5 — Cataloguing depth (phases 36–50)

**36.** Classification schemes + vocabularies + `bib_classifications` + the settings UI. · **37.** Batch edit with preview and **exact per-record undo** via `before_version`, on the `catalog` queue. · **38.** Find-and-replace (literal + ReDoS-screened regex reusing `patternLooksCatastrophic`). · **39.** Duplicate detection (identifier, normalized OCLC number, match key) and merge with tombstones, aliases and re-pointing of items/holds/heading links. · **40.** Work clustering with the **expression key** and staff pin/split/exclude overrides. · **41.** Authority store + editor over the same MARC store. · **42.** The authority linker inside the bib write transaction + generated see/see-also + the unlinked-headings queue. · **43.** Global heading change as an undoable batch; authority merge/split. · **44.** Subdivision-aware heading decomposition + OCLC/LCCN normalizers + free-floating subdivision validation. · **45.** External reconciliation: VIAF, id.loc.gov (names + subjects), ISNI, ORCID, GND, Wikidata, each on the outbound-HTTP guard. · **46.** Series authority (490/8XX/830, series authority 642–646). · **47.** ISBD display (pass-through and generate, including Leader/18='c'). · **48.** Crosswalks: DC, MODS, schema.org, RIS/BibTeX/CSL-JSON. · **49.** BIBFRAME 2.5 Turtle + JSON-LD; `oai_record_state` fully populated. · **50.** UNIMARC native projector, templates, rule pack, and the bidirectional crosswalk with a per-record lossiness report.

_Representative acceptance:_ a batch adding a 655 to 20,000 records writes 20,000 versions tagged with the job id and undo restores all 20,000 with zero residue and zero version gaps; preview writes nothing (content hashes compared before and after). Saving a bib whose 100$a matches an established heading links **in the same transaction** — no eventual consistency. A tenant with `default_schema='unimarc'` catalogues end to end with no MARC21 assumption leaking through. Every reconciliation adapter refuses a 302 to an attacker host, aborts at its timeout, stops at the body cap, and with every source disabled **no outbound socket is opened** (a test fails on any fetch).

> **After M5** — a cataloguing department can do authority work, batch maintenance with undo, deduplication and merge, and can catalogue natively in UNIMARC. A Greek academic library can be its cataloguing system of record.

---

### M6 — Interoperability (phases 51–63)

**51.** `packages/protocols` skeleton + the CQL 1.2 parser with a complexity budget + the shared `SearchAttributeRegistry`. · **52.** OpenAPI-registered public REST v1 read surface (catalog, holdings) + API keys + scopes + cursor pagination + `problem+json` + ETag/If-Match + rate-limit headers + `check:openapi` armed. · **53.** REST v1 write surface (patrons, circulation, fees) with mandatory `Idempotency-Key`. · **54.** `packages/api-client-ts` generated at build; the `api.{$SITE_HOST}` vhost inside `origin_guard`; CORS reflected only for origins registered on the calling client, emitted by Nest and never by Caddy. · **55.** Signed CloudEvents webhooks over `change_events` with SSRF guard, dual-secret rotation, circuit breaker, delivery inspector and replay. · **56.** OAuth 2.0 authorization server (code+PKCE S256, rotation with family revocation, ES256 JWKS, discovery, introspection, revocation). · **57.** SRU 2.0 + 1.2 server with total version dispatch and generated ZeeRex explain. · **58.** OAI-PMH provider with signed stateless resumption tokens, set-hierarchy containment, day granularity, the identifier scheme. · **59.** OAI-PMH harvester through the existing import engine as `ImportSourceKind='oai'`. · **60.** `apps/protocol-gateway` + Z39.50 server to **Bath Profile Level 1** with named result sets, Scan over the browse index, Sort, and the full abuse suite. · **61.** SIP2 server + emulator + in-product conformance console + the LAN TLS bridge, with correct 96/97 direction, response buffering, negotiated error detection and per-device CP1253. · **62.** NCIP responder/initiator to Implementation Profile 1 + the institutional-patron representation. · **63.** ISO 18626 codec, peers, transport, both endpoints; ILL lifecycle, rota, costs, copyright declaration (Ν.2121/1993 art. 22), temporary item and hold on arrival.

_Representative acceptance:_ a 10k-case CQL fuzz run produces no unhandled throw and no over-budget query; `yaz-client`, Koha's and VuFind's Z39.50 clients each complete Init → Search → Present → Scan → Sort and the returned MARC re-parses byte-identically; the Open Archives validator and a real harvester complete full and incremental harvests, and a token minted for tenant A returns `badResumptionToken` against tenant B; a self-check that drops the 12 response and re-sends the identical 11 with the same BK produces **one** loan and one fee; a SIP2 checkout and a desk checkout produce indistinguishable audit rows apart from `actor_id`; an ISO 18626 `Unfilled/NotHeld` advances the rota after `retry_after`, and swapping the ILL reducer for a spy proves the transport decides nothing and stores no status.

> **After M6** — a university can drive circulation from EBSCO Discovery or Primo, self-check machines and sorters work, the catalogue is harvestable and searchable by every union catalogue and copy-cataloguing client in Europe, and interlibrary loan runs on the international standard.

---

### M7 — The academic back office (phases 64–75)

_Gated: does not start until a paying library asks for it._

**64.** Fiscal years, ledgers, funds (materialised path + `text_pattern_ops`), budgets, the **append-only** `acq_fund_transactions` with its immutability trigger and one-encumbrance-per-line partial unique, trigger-maintained balances, Greek tax rates, ECB FX. · **65.** Vendors (ΑΦΜ/ΔΟΥ/GLN) + purchase suggestions + the public OPAC suggestion form. · **66.** Orders, order lines, fund distribution, receiving on the KeyGrid, ΑΔΑΜ/ΑΔΑ. · **67.** Invoices, credit notes, adjustments, accounting export (CSV, EN 16931/UBL 2.1, SEPA pain.001, myDATA shape). · **68.** Claiming, notices, fiscal rollover, the `acquisitions` queue. · **69.** `packages/serials-prediction` (calendar with the month-end clamp, omission, combination, enumeration carry, chronology projection, sort keys, 853↔recipe) + subscriptions + the 24-issue live preview. · **70.** **CONSER pattern import by ISSN** through the SRU client as the default subscription flow. · **71.** Serials check-in grid, late sweep, claiming, accept-and-resync, item creation. · **72.** Routing lists, binding, Z39.71 holdings statements with `863 $w` gap-vs-break. · **73.** EDIFACT: `packages/edifact` + SFTP with pinned host keys + `edi_messages` with raw bytes to storage before parse + ORDERS out / INVOIC in. · **74.** ORDRSP, DESADV, ORDCHG, ONIX ingest; ISO 11620 indicator dashboard. · **75.** ERM (packages, resources with KBART-named columns, coverage, agreements, licences with the ONIX-PL/ERMI term vocabulary where `silent` never auto-permits, trials, proxy profiles, admin credentials).

_Representative acceptance:_ order → receive → invoice → approve → pay → credit note leaves encumbered at 0 and expended at the net, and the whole chain of ledger rows sums to the invoice total minus the credit; a direct UPDATE or DELETE on `acq_fund_transactions` raises; the ~40-pattern fixture corpus predicts 36 issues each with exact designations including Jan 31 → Feb 28 → **Mar 31**, weekly-skips-August, and no.9 following a combined no.7/8; a full check-in session completes with **zero mouse events** and axe reports no AA violations; `parse(serialize(x)) ≡ x` over generated EDIFACT interchanges plus golden round-trips of real ORDERS and INVOIC from two vendors; an inbound INVOIC with one malformed line creates the invoice with the other lines and one row issue, never zero lines.

> **After M7** — an academic or large public library can run its acquisitions budget, its subscriptions and its e-resource agreements in Libriant, and file a POS/myDATA-shaped export its municipality's accountant can actually import.

---

### M8 — The native client, offline and hardware (phases 76–81)

**76.** Tauri 2 shell + Rust core (`libriant-core`, `libriant-shell`), native menus/tray/multi-window/deep links/file associations, rendering the same screens through `DataPort`; Electron retired; `check:rust-no-policy` (no business term inside a crate). · **77.** The encrypted SQLCipher replica + the pull half of sync over `change_events` with the commit watermark; FTS5 with the shared Greek fold; profiles (full / branch / circulation_lite / kiosk). · **78.** The push half: ops through `SyncPushService` re-executing the identical service methods, clock skew correction and clamping, provisional loans/holds/fees, the **Reconciliation report** with print-corrected-receipt and audited sign-off. · **79.** Device identity: enrolment codes, P-256 keys in Secure Enclave/TPM, DPoP-proofed 15-minute tokens, `DeviceAuthMiddleware` synthesising `req.session` in the existing shape so no guard changes, the lease-and-seal, remote wipe with outbox quarantine, the Stations console, GDPR purge propagation with per-device acknowledgement. · **80.** Hardware tier 1 + RFID: PC/SC readers, the hand-rolled **ISO 28560-2** (OID variable-length) and **-3** codecs, **AFI 0xC2 secured / 0x07 unsecured** with mandatory read-back on checkout, exclusive HID claim for keyboard-wedge scanners, hot-plug, simulators for CI. · **81.** Kiosk mode (self-check, returns, OPAC) with station principals scoped to `circ.selfcheck`, the PII-minimal replica profile, WCAG 2.2.1-compliant idle warning, OS-lockdown scripts and the unverified-lockdown badge; the inventory wand.

_Representative acceptance:_ a 14-day offline run producing 900 mixed ops reconnects and converges in one push+pull round; replaying the entire outbox three times produces byte-identical final state; a device clock set to 2009 is corrected and clamped and its due dates match an online checkout; the Rust core and the TS resolver produce identical due dates for all golden vectors (`cargo test` and `node --test` on the same file); a kiosk token is refused on the patron-list endpoint; encode/decode round-trips ISO 28560-2 and -3 worked examples; a failed disarm **blocks the checkout** rather than sending the patron into a gate alarm; the Tauri updater's minisign verification makes auto-update safe on unsigned builds, retiring A11-01.

> **After M8** — a branch can run for a week with the network down and reconcile with a report telling the librarian exactly which receipts were wrong; self-check units, RFID pads and security gates work; and the fleet is managed from one console.

---

### M9 — Search at scale and AI (phases 82–87)

**82.** OpenSearch backend behind the same interface: per-tenant indices, the Greek/English analysis chain, `icu_collation_keyword`, bulk indexer with `version_type: external_gte` from `record_version_seq`, `assertIndexBelongsToTenant`, zero-downtime reindex (build → verify → alias swap → 24 h grace drop). · **83.** Relevance profiles, facets at scale, suggest, did-you-mean, browse over the browse index with bidirectional `search_after`. · **84.** `packages/ai`: the provider abstraction, four hand-rolled providers plus null, capability negotiation, the router with quota/cache/audit/metrics, allowlist redaction with Greek detectors (ΑΜΚΑ, ΑΦΜ, IBAN, Luhn PAN), versioned prompts, the eval harness, the three off switches — **and no AI features**. · **85.** Constrained subject and classification suggestion (the model chooses indices into a retrieved candidate list; every choice re-validated against the authority store). · **86.** pgvector, chunking, the partial-HNSW model-switch procedure, hybrid BM25+kNN with RRF, similar items, NL-query→structured search. · **87.** Collection analytics: zero-result and unfilled-hold gap analysis, CREW/MUSTIE weeding with hard blocks (last copy in consortium, curriculum-locked), Holt-Winters demand forecasting, cost-per-use joined to the acquisitions ledger.

_Representative acceptance:_ a full rebuild of 5M synthetic bibs completes while the live pipeline keeps writing, and an out-of-order replay produces a byte-identical index; with `AI_ENABLED=false` the module is not registered and every route 404s; a tenant with `data_egress_allowed=false` cannot select a cloud provider and the router refuses any host but its configured base URL; the subject suggester fed a model stub returning garbage produces **zero output and a counted refusal**; hybrid beats BM25 on a 60-query concept panel (nDCG@10) without losing on known-item; every weeding suggestion shows its evidence and nothing is ever withdrawn automatically; with AI off all three analytics screens render fully and only the prose paragraph is missing.

---

### M10 — Platform and extensibility (phases 88–92)

**88.** SSO: OIDC RP, SAML 2.0 SP (with our own single-assertion / Reference-URI-bound / no-re-serialization belt on top of the library), CAS 3.0, LDAP with hand-rolled RFC 4514/4515 escapers, JIT provisioning. · **89.** SCIM 2.0 server (hand-rolled) + WebAuthn passkeys with the scoped-`allowCredentials` rule on the shared host. · **90.** GraphQL reporting endpoint generated from the semantic model, read-only, persisted queries. · **91.** Report builder UI + scheduling + delivery (email/SFTP/webhook/S3) + PDF. · **92.** Declarative plugins + the separate-origin iframe UI lane + the signed registry + the four kill switches.

_Representative acceptance:_ SAML XSW corpus (assertion moved into Extensions, second unsigned assertion appended, Reference pointing at a sibling) rejected in every case with a distinct logged reason; an LDAP username containing `)(|(uid=*` binds as itself or fails, never as another user; a scheduled report fires at the right local wall-clock time across a DST boundary; the GraphQL schema contains no Mutation type, asserted structurally, and no resolver touches a write-path table (Prisma spy); a plugin attempting `fetch` from its iframe is blocked by CSP **and** absent from the bridge.

---

### M11 — Deployment, consortium and compliance (phases 93–96)

**93.** Self-hosted profile: `DeploymentProfile` capability matrix, offline Ed25519 licence with embedded keys, `libriantctl`, the compose and Helm artefacts, the signed offline bundle. · **94.** Air-gapped: no-egress enforcement centrally in `outbound-http.ts`, signed update bundles with barrier-version refusal and rollback, support bundle with a patron-free scanner, SBOM. · **95.** Consortium via the **in-process loopback transport** — the identical ISO 18626 state machine with no HTTP, no new container, no cross-database query — plus the union index fed from each member's `change_events`, patron identity carried as a single-use HMAC voucher and a ghost patron with no PII, and the federated-SRU fallback. · **96.** Compliance and procurement packs: ISO 27001 SoA mapped to repository locations, SOC 2 TSC, PCI scope, ROPA/DPIA covering SSO, replicas and consortium, `check:dsar-coverage`, `scripts/access-review.ts`, `NoPanGuard`, the Ν.4412/2016 crosswalk, VPAT 2.5 EU, the per-tenant accessibility statement with its 12-month staleness alert, the external WCAG audit.

_Representative acceptance:_ a bundle installs inside a network-namespaced container with egress dropped and reaches a working library; an expired licence blocks administrative creation while checkout, checkin, renew and hold keep working (asserted, because it is a product promise); a loopback consortial request drives the identical state machine and a boundary test proves `makeTenantPrismaClient` is absent from the loopback path's dependency closure; an erasure provably removes the subject from the tenant DB, the change feed, the sync dedupe table and every enrolled device replica.

---

### M12 — Discovery depth (phases 97–104)

_All demand-gated._

**97.** Events, spaces, equipment, bookings with the EXCLUDE constraints, waitlists, iCal. · **98.** Community: reviews with pre-moderation, lists, tags, reading challenges, nightly co-circulation recommendations from anonymised loan pairs. · **99.** Digital objects: ingest with SHA-256 fixity and PREMIS, static IIIF level-0 tile pyramids, Presentation 3.0 manifests, Content Search 2.0, BagIt. · **100.** Digital lending: watermarking first, the four lending models through the same loans table and policy engine, the accessible EPUB reader with EAA metadata, open-content harvesters (Gutenberg, DOAB, OAPEN, EKT). · **101.** Readium LCP on the basic profile, then certified. · **102.** Wallet passes + APNs/FCM push + the offline card. · **103.** Archives: `archival_description` (ltree), **EAD 2002 import / EAD 3 export**, ISAAR(CPF) creators reusing the authority store, collection-level MARC generation. · **104.** The React Native patron app — **one app with a library picker**, gated on a paying request and on CyberSystema holding a D-U-N-S trader identity for DSA Art. 30.

---

## 7. What we deliberately do NOT build

| Cut                                                    | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SRW (SOAP binding)**                                 | Its own spec called it "not because it is a good idea in 2026". If a German discovery system needs it, that is a paid integration, not a shipped surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **ILS-DI**                                             | A legacy accord adding a third patron-authentication path to keep correct. NCIP + `/api/v1` covers VuFind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **ResourceSync**                                       | Nothing in this market harvests it. OAI-PMH plus a signed nightly MARC dump serves the same need.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Z39.50 Explain (IR-Explain-1)**                      | Clients fall back to configured profiles. The honest position — "not implemented, use the Bath Profile defaults" — is written in the documentation rather than left silent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **A second plugin runtime**                            | Two full designs (QuickJS-in-process, wasmtime out-of-process) for zero third-party developers. The declarative tier plus a separate-origin iframe covers ~90 % of real requests with no execution engine. The compute tier is deferred, not designed twice.                                                                                                                                                                                                                                                                                                                                                                                      |
| **A second GraphQL endpoint**                          | Interop and Search each specified one. One, generated from the semantic model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **The consortium broker container**                    | A process holding narrow credentials for many libraries is the first thing a consortium's security officer refuses. The in-process loopback transport achieves the identical state machine with no new trust boundary. Revisit at the second consortium.                                                                                                                                                                                                                                                                                                                                                                                          |
| **A shared bibliographic Community Zone**              | Alma's CZ and OCLC's shared KB are a labour asymmetry no architecture fixes. Every Libriant library copy-catalogues one record at a time. We say so rather than implying parity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Article-level discovery (Primo/EDS equivalent)**     | Libriant will never hold the article index. The OpenURL resolver hands off; it does not compete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **OCLC WorldCat holdings-setting**                     | Requires an OCLC agreement and the Metadata API. Copy cataloguing from LC/NLG/K10plus is the shipped path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **AS2 for EDI**                                        | Node has no CMS; the options are a large historically-CVE-prone library or shelling to openssl, for a transport almost no Greek library vendor uses. SFTP, email and vendor REST ship instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Hand-rolled cryptographic primitives**               | Argon2, XML Signature verification, LDAP bind and WebAuthn attestation are the four places the zero-dependency bias yields. We hand-roll _protocols and encodings_, never primitives — the line `marc-parser.ts` and `Barcode.tsx` already draw.                                                                                                                                                                                                                                                                                                                                                                                                  |
| **An in-image OCR engine**                             | Real digitization emits ALTO, hOCR or a PDF text layer. Page-image OCR is offered only through an AI vision model, rate-limited and costed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **A headless browser for PDF**                         | ~200 MB of image for report rendering. `pdfkit` + the SVG charts, and only if XLSX proves insufficient in the field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **A charting library**                                 | Server-rendered inline SVG, following `Barcode.tsx`: CSP-safe, printable through the silent-print bridge, zero bundle cost, and it forces the accessible data-table twin to exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **A date library**                                     | `Intl.DateTimeFormat` in Node 26 and every browser, backed by the same ICU tzdata the platform ships. A date library is a second, divergent tzdb — and the Rust core must agree byte-for-byte.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **A CAPTCHA anywhere**                                 | A WCAG 1.1.1 hazard on a public-sector site that also ships visitor data to a third party. Honeypot + timing + rate + account-age heuristics instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **MARC-8 EACC (CJK)**                                  | _Amended: **two** of the twelve graphic sets shipped — Basic Latin and Extended Latin (ANSEL). `SUPPORTED_TABLES = [BASIC_LATIN, EXTENDED_LATIN]`. There is no Greek, Cyrillic, Hebrew or Arabic MARC-8 table, which matters more than the CJK omission this row is about: a Greek library product claiming a Greek MARC-8 table it does not have is the overstatement to fix first._ Ship the codec structure and Latin/Greek/Cyrillic/Hebrew/Arabic tables; EACC is a lazily-loaded stub raising "CJK MARC-8 not supported, re-export as UTF-8". No Greek library exercises it and it is the least-testable path in the highest-risk component. |
| **RiC-O and METS beyond digital-object packaging**     | Named in a spec as a roadmap item for procurement that has not asked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Coexistence adapters between 1.0 and 2.0**           | Three specs promised "legacy tables still serving". There are no libraries in production. Weeks of work that would be deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Extracting 1.0 staff screens into a shared package** | They are about to be replaced. The port boundary is established instead, so the Tauri client is additive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **One mobile app per library**                         | Apple rejects template apps under Guideline 4.3. One app, one library picker, from the start.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## 8. Top risks and their mitigations

1. **The cutover corrupts a real library's data.** _Mitigation:_ one atomic transaction with a 40-assertion verifier inside it; rollback is a schema rename; CI runs the whole upgrade against a generated v1 fixture on every commit; the demo tenant is cut over and exercised through the UI before any customer; a named first library with a rehearsed cutover date and a documented rollback decision point.

2. **Timestamp conversion silently shifts every date by three hours.** Prisma's generated `ALTER COLUMN … TYPE timestamptz` casts through the session TimeZone, which on this production host is Europe/Athens. _Mitigation:_ every conversion hand-written `USING col AT TIME ZONE 'UTC'`; `check:migration-safety` fails any bare cast; the verifier asserts every converted instant is within 1 s of the v1 value read as UTC.

3. **The schema rename breaks a live database — and the real mechanism is not the one this risk named.** _Amended after measuring it in 20b-i._ An operator class inside an index is bound by OID and survives a rename untouched, so every trigram index and every EXCLUDE constraint comes through intact; the only category a rename can break is a SQL or PL/pgSQL body, which is stored as TEXT and re-resolved at run time. That class is EMPTY in every tenant database this repo produces — the `immutable_unaccent` wrapper exists only in the control plane — so the upgrade does not drop and recreate anything. It REFUSES instead: a `pg_proc` pre-flight before `BEGIN` names any function body containing `public.` and stops, because the correct rewrite depends on what the author meant and a wrong guess produces a function that runs and is wrong. **The actual hazard is that extensions move WITH their schema:** all six ride `ALTER SCHEMA public RENAME TO v1_archive` into the archive, where they are still what the promoted schema depends on, and `DROP SCHEMA v1_archive CASCADE` then deletes `patrons.email`, both trigram indexes and all three no-overlap constraints — as a NOTICE, which `ON_ERROR_STOP` does not stop. _Mitigation:_ six `ALTER EXTENSION … SET SCHEMA public` inside the cutover transaction, eight post-promotion assertions run under the application's own `"$user", public`, and a CI job that commits a real cutover and then drops the archive to prove it is safe. `check:migration-safety` still rejects unqualified calls in migrations.

4. **The hand-rolled BER decoder is unauthenticated attacker-chosen binary on a public port.** _Mitigation:_ `BER_LIMITS` enforced before any allocation; decode-to-typed-error with no throw/catch control flow; a CI fuzz corpus of 50,000 mutated real captures as a merge gate; process isolation so a failure kills the gateway and not the API; a written escape hatch to a Rust napi decoder behind the same pure signature.

5. **The permission migration locks a librarian out of checkout on a Monday morning.** _Amended: the numbers and the escape hatch are both wrong. It landed against **130** tenant-scoped routes, not 25 — that is the size of the frozen baseline at phase 3 — and there is **no break-glass script**: `scripts/` has 58 entries and none grants a role, permission or override. What actually protects this is `authorization-matrix.spec.ts`, which enumerates the live Nest router and asserts the permission model reaches the same verdict as the old role check for every route and every role, against a committed baseline._ _Mitigation:_ landed in M0 against 25 routes rather than 85; a test matrix comparing every route's old and new decision; templates upgraded by migration so an unedited built-in role inherits new permissions; a documented, audited break-glass script requiring DB access.

6. **The matrix makes the product unusable for a five-person school library.** _Mitigation:_ simple mode is the **default** and is gated by `circulation_rules_enabled` — off means the UI is today's settings form writing only the wildcard rule and the matrix editor does not exist; advanced mode is fronted by `/circulation/explain` so "why this due date" always has a straight answer.

7. **Ledger drift makes fee balances untrustworthy.** _Mitigation:_ every write in the same transaction as its allocations; a nightly job asserting all three identities per tenant, writing `ledger_discrepancies` and emitting a metric **rather than self-healing** (a self-healing reconciler hides the bug that caused the drift); a 10,000-sequence property test gating the phase.

8. **Serials prediction gets the second issue wrong and staff never return.** _Mitigation:_ CONSER pattern import by ISSN as the default flow so most patterns are never authored; a 24-issue dry-run preview before anything is saved; one-keystroke accept-and-resync; `ser_pattern_exceptions` so a correction is _taught_ once; the month-end clamp (Jan 31 → Feb 28 → **Mar 31**) as a named test.

9. **A hardware polarity or protocol-direction error humiliates the library in front of patrons.** AFI inverted alarms the gate on every checked-out book; SIP2 96/97 reversed drops every self-check connection. _Mitigation:_ both corrected in this document; read-back verification before a checkout completes; golden tests from the ISO 28560-2 worked examples and recorded vendor SIP2 transcripts; simulators so CI covers it with no physical device.

10. **Scope kills the launch.** 105 spec phases is two years before a Greek library borrows a book, with a campaign already queued. _Mitigation:_ the launch line is drawn at phase 35 (~35 sessions); everything after M4 is explicitly demand-gated; acquisitions/ERM/ILL, the protocol servers, Tauri, consortium, plugins, digital lending and mobile are all out of v1 by decision, not by slippage; each of M0–M4's phases ships something independently validated, and only phase 20b-iii is a cutover — 20a, 20b-i and 20b-ii are each additive and leave the product working.

_Runners-up worth naming:_ the sizing of the merged stack against a shared 128 MB `shared_buffers` box (mitigated by profiles-off-by-default and a per-phase deployment budget as an acceptance criterion); `@node-saml/node-saml`'s transitive XML tree, the dependency with the highest ongoing maintenance obligation in the design; and the marketing site's four claims that become untrue at phase 31 — one of which, at line 806, would become an untrue _security_ claim.

---

## 9. Immediate next step — Phase 1

**Greek normalization, call-number keys, money primitives, and the folding gate.** No schema change, no user-visible change, no migration. It lands first because every index, every projection, every sort key and every offline replica built after it depends on the fold being right, and because the `search_text` backfill it requires is free only inside the phase-20 cutover.

### Files to create

```
packages/shared/src/greek.ts                        # THE single implementation
  foldGreek(s)            NFD strip + FINAL SIGMA ς→σ (U+03C2→U+03C3)
                          + lunate ϲ/Ϲ→σ, ϐ→β, ϑ→θ, ϕ→φ, ϖ→π, ϰ→κ, ϱ→ρ
  greekPhoneticKey(s)     Greeklish-collapsing reduction ('vivliothiki' ≡ 'βιβλιοθήκη')
  toIso843Type1(s)        reversible transliteration (η→ī, ω→ō, χ→ch)
  toIso843Type2(s)        transcription — LABELLED "ISO 843 Type 2 (ELOT 743)"
  toAlaLc(s)              ALA-LC Modern Greek (β→v, η→ē, rough breathing)
  stripNonfilingArticle(title, langCode)
  GREEK_STOPWORDS
packages/shared/src/greek/__fixtures__/greek-normalization.json    # ~600 vectors
packages/shared/src/greek.test.ts

packages/shared/src/callnumber/normalize.ts   # AMENDED: all six schemes live here,
packages/shared/src/callnumber/compare.ts     # not in six per-scheme files
packages/shared/src/callnumber/index.ts
packages/shared/src/callnumber/normalize.ts         # sortKey(scheme, cn) -> fixed-width PURE ASCII
packages/shared/src/callnumber/compare.ts
packages/shared/src/callnumber/index.ts
packages/shared/src/callnumber/__fixtures__/{ddc,lcc,udc,nlm}.json   # AMENDED: 2000 each for
                    # DDC/LCC/NLM; UDC holds 27 and the test lowers its own threshold to 20 for UDC
                    # alone. Plus an undocumented fifth, named-orderings.json.
packages/shared/src/callnumber/callnumber.test.ts

packages/shared/src/money.ts                        # Money{amount:bigint,currency}, add/sub/mul/allocate
packages/shared/src/currencies.ts                   # ISO 4217 + minor-unit exponents
packages/shared/src/money.test.ts

scripts/check-greek-folding.ts                      # NEW GATE  (.ts, not .mjs)
scripts/check-currencies.mjs                        # NEW GATE (modelled on check-countries.mjs)
```

### Files to edit

- `packages/shared/package.json` — add `"./greek"`, `"./callnumber"`, `"./money"`, `"./currencies"` to `exports` (`check:shared-imports` requires the subpath to be declared before `apps/web` may import it).
- `packages/shared/src/search.ts` — add `SEARCH_MIN_CHARS_INDEXED = 1` and `minCharsFor(capabilities)` beside the existing `SEARCH_MIN_CHARS = 3`, so the UI can never disagree with whichever backend is serving it. Keep the existing constant and its comment verbatim.
- `apps/api/src/catalog/normalize.ts` — `normalizeText` becomes `foldGreek` re-exported from `@libriant/shared/greek`. **Do not change any stored data in this phase**; the projection rebuild in phase **20b-iii** recomputes `searchText`/`sortName`/`sortTitle` once. Add a comment recording that the function's output changed and pointing at phase 20. _(Shipped. Phase 20a later moved `classifySearchTerm` out of this module into `@libriant/shared/search` and left a forward, because two of its three callers survive the cutover and this module does not.)_
- `package.json` — add `"check:greek-folding": "tsx scripts/check-greek-folding.ts"` and `"check:currencies": "tsx scripts/check-currencies.mjs"`, and insert both into `check:all` between `check:countries` and `typecheck`.
- `.github/workflows/verify.yml` — two new steps in the `Static checks` job, mirroring the existing `Country list matches ICU and libphonenumber` step's shape.

### Tables

**None.** Phase 1 creates no table and runs no migration. The first migration is phase 2 (the schema-folder split, still semantically empty) and the first new table is phase 9.

### Tests

- `packages/shared` gains a `test` script: `node --import tsx --test "src/**/*.test.ts"` (matching `packages/ui`, not vitest — this is a pure library with no DB fixtures), plus the `typecheck`/`lint` scripts turbo requires. _Amended: there is no `build` script and the package does not need one — it is consumed as TypeScript source through subpath exports._
- **The defining assertion:** `foldGreek('ΠΟΛΙΣ') === foldGreek('πολισ') === foldGreek('πόλις') === foldGreek('ΠΌΛΙΣ')`. Today `normalizeText('ΠΟΛΙΣ')` ends in U+03C2 because `String.prototype.toLowerCase` correctly applies the Unicode `Final_Sigma` conditional mapping, while a typist writes U+03C3 — so a Greek user searching for a word ending in sigma gets "No matches" for a book on the shelf, and uppercase-catalogued records (the norm in Greek library exports) are exactly the ones affected.
- Polytonic already folds correctly (`ἀ`/`ᾳ`/`ᾍ` decompose to marks inside U+0300–U+036F) — assert it so a future refactor cannot regress it.
- ISO 843 Type 1 round-trips; Type 2 and ALA-LC each match their published tables on a 200-name corpus including `Καζαντζάκης` → `Kazantzakis` / `Kazantzakēs`.
- Call-number keys are **pure ASCII** over the entire fixture corpus (`/^[\x20-\x7E]+$/`). _Amended: the Postgres half was never built._ `callnumber.test.ts` is a pure `node --import tsx --test` file with no database and no `COLLATE` clause; it sorts in JavaScript and compares against the fixture's own recorded shelf order. The perf-13 trap — a key that sorts one way in the app and another in `ORDER BY key COLLATE "el-GR-x-icu"` — is therefore **assumed, not asserted**, and remains open. Original text: sorting the fixture in JavaScript produces the same order as `ORDER BY key COLLATE "el-GR-x-icu"` in a throwaway Postgres table — the perf-13 trap, asserted rather than assumed. Zero inversions for LCC and DDC against a reference shelf order; UDC auxiliaries in the documented sign precedence; a malformed number never throws and falls to the natural sorter with a flag.
- `money.allocate(1250n, [1,1,1])` distributes to the cent with no rounding residue; every currency's minor-unit exponent matches ICU.

### CI gates it must pass

- **`check:greek-folding` (new)** — _amended: the gate creates no database and never runs the fixture through Postgres_, by design, so it can live in the `static-checks` CI job which has none. What it actually does is run 854 vectors through the TypeScript implementation and assert that `greek-fold.sql` declares the same variant table, the same combining range and the same pinned collation, with every call schema-qualified. The executable two-runtime comparison is `apps/api/test/integration/greek-folding-parity.spec.ts`, which does have a database. `libriant_fold_greek(text)` is installed by **no migration** — only by that spec, which creates and rolls it back — so nothing in the product may call it. The gate is written now with two runtimes and grows two more later — the OpenSearch analyzer chain in phase 82 and the Rust core's `cargo test` fixture in phase 77 — because that is the only thing standing between a name that sorts in one place and cannot be found in another.
- **`check:currencies` (new)** — the ISO 4217 table against ICU, modelled directly on `scripts/check-countries.mjs`.
- **`check:shared-imports`** — the four new subpaths must be declared in `exports`; the barrel is never importable from `apps/web`.
- **`check:supply-chain` / `check:pnpm-pins`** — must pass **unchanged**: this phase adds **zero dependencies**. Every function here is hand-rolled for the reason the repo has already applied three times (`marc-parser.ts`, `Barcode.tsx`, `http-metrics.ts`), and in this case the decisive argument is that the same fold must run identically in TypeScript, in a Postgres index expression, in an OpenSearch analyzer and in Rust — which no package can promise.
- `check:translations`, `check:assets`, `check:legal`, `check:caddy`, `check:alerts`, `check:countries`, `check:image-size`, `pnpm typecheck`, `pnpm lint --max-warnings 0`, `pnpm format:check` — all unchanged and green.
- `pnpm tenant:smoke` and the existing unit + integration suites — unchanged and green (the API's behaviour changes only in that Greek search now matches more, which no existing test asserts against).

### Definition of done

`pnpm check:all` green with two new gates in it; `packages/shared` has real tests where it had none; `foldGreek('ΠΟΛΙΣ') === foldGreek('πολισ')`; call-number keys are ASCII-safe under `el_GR.UTF-8`; no dependency added; no migration run; no data changed. The backfill that makes the fix visible to users happens once, inside the phase-20 cutover, which recomputes every projection anyway.
