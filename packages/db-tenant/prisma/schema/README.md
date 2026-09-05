# The tenant schema, split across files

Prisma reads every `.prisma` file in this folder and concatenates them. The
split exists because the tenant schema was one 701-line `schema.prisma` and is
on its way to several thousand lines across a dozen modules — a file that size
is unreviewable in a diff, and every change to circulation shows up next to
every change to cataloguing.

## The numeric prefixes are load-bearing

Prisma reads the folder in lexical order, and **declaration order decides the
order of models and field enums in the generated client**. Without the
prefixes the split reordered the client — audit before catalogue, and so on.
Nothing breaks, but it makes the only question that matters about a refactor
— _did this change anything?_ — unanswerable by diff.

With them, splitting the file changed the generated client by exactly **three
characters**: `../` became `../../` in the inlined copy of the generator block,
because a relative `output` path now resolves against the folder rather than
against the old single file. `index.d.ts`, `index-browser.js`, `client.*` and
`default.*` are byte-identical.

So: **a new file gets a prefix, and appending is safer than inserting.** A new
module at `10-…` adds its models at the end of the client. Renumbering an
existing file rewrites the client for no reason.

## The one trap

`output` in `00-datasource.prisma` is `../../node_modules/.prisma/tenant-client`
— one level deeper than it looks. With a schema _folder_, Prisma resolves a
relative output path against the folder. Left at `../`, `prisma generate`
quietly wrote the client to `prisma/node_modules/` while every import kept
resolving to the stale copy in the package root, and nothing failed.

## Files

| File                      | Contents                                                                |
| ------------------------- | ----------------------------------------------------------------------- |
| `00-datasource.prisma`    | The schema's docblock, `generator`, `datasource`, extensions.           |
| `01-enums.prisma`         | Every enum.                                                             |
| `02-settings.prisma`      | `tenant_settings` — the singleton holding all circulation policy today. |
| `03-catalog.prisma`       | `authors`, `books`, `book_authors`, `book_copies`.                      |
| `04-patrons.prisma`       | `members`, `member_number_counters`.                                    |
| `05-circulation.prisma`   | `loans`, `reservations`, `fines`.                                       |
| `06-customization.prisma` | `field_definitions` — custom fields on built-in entities.               |
| `07-collections.prisma`   | `collections`, `collection_fields`, `collection_records`.               |
| `08-audit.prisma`         | `audit_log`.                                                            |
| `09-platform.prisma`      | `_libriant_schema_state`, `_libriant_online_migrations`.                |

## What Prisma cannot hold, and where it lives instead

Partial unique indexes, `CHECK` constraints, GIN/trigram indexes,
`text_pattern_ops`, generated columns and advisory-lock semantics are all in
raw migration SQL, not here. `pnpm check:schema-drift` replays the migrations
into a shadow database and compares: statements that **DROP** something are the
expected surplus and must be allowlisted with a reason; statements that
**CREATE** or **ADD** mean a migration is missing, and fail.
