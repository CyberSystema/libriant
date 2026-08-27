# Legal layer — maintainer notes

The public legal documents live as checked-in markdown under
`locales/<locale>/legal/<slug>.md` and are rendered by the web app at
`/<locale>/legal` and `/<locale>/legal/<slug>`. UI strings (titles, summaries,
consent text) are in `locales/<locale>/legal.json`.

## ⚠️ These are DRAFTS — have them reviewed by qualified legal counsel

Every document was tailored to how Libriant actually processes data, but none is
legal advice. **Do not rely on them until a lawyer qualified in Greek/EU
data-protection and consumer law has reviewed them.** Each page also shows a
"draft pending review" banner; remove it (the `legal.draftNotice` string + the
`<Banner>` in the two `app/[locale]/legal` pages) once reviewed.

## Fill in the placeholders

Search the markdown for `[...]` placeholders and replace them with your real
details. The key ones:

- `[COMPANY LEGAL NAME]`, `[REGISTERED ADDRESS]`, `[COMPANY REGISTRATION NUMBER / GEMI]`
- `[VAT NUMBER]`, `[TAX OFFICE]`, `[NAME(S)]` (legal representative)
- `[CONTACT EMAIL]`, `[DPO EMAIL]`, `[SECURITY CONTACT EMAIL]`, `[PHONE]`, `[WEBSITE URL]`
- `[Athens, Greece]` (governing courts), `[Hetzner, Germany/Finland]` (hosting region)
- Sub-processor entities/regions in `subprocessors.md`
- Numeric windows: notice periods `[30]`, cure `[14]`, backup `[14]`-day, tax
  retention `[5–10]` years, liability cap `[EUR amount]`, refund terms
- Confirm the actual sub-processors (`subprocessors.md`) match your deployment

## Versioning + consent

- The canonical version is `LEGAL_VERSION` in `packages/shared/src/legal.ts`
  (the ISO date of the revision). It stamps the WHOLE corpus — all seven
  documents, both locales — not one file.
- New library owners must accept the Terms + Privacy Policy at signup; the
  accepted version + timestamp (+ IP) is recorded on the `User` and `Tenant`
  rows (`legalAcceptedVersion` / `legalAcceptedAt` [/ `legalAcceptedIp`]).
- Those three columns say WHEN and under which stamp, and nothing about WHICH
  TEXT — the pages render whatever is at HEAD. So signup ALSO writes a
  `tenant.legal_accepted` control-plane audit row carrying the locale, the
  person who accepted, and a SHA-256 per document (privacy-legal-09). See
  `apps/api/src/auth/legal-acceptance.ts` and `docs/legal/README.md`.
- And because a digest still cannot PRODUCE the text, the bodies themselves are
  copied into the control-plane table `legal_document_versions` — one immutable
  row per (version, locale, slug), loaded from the frozen directory below before
  any acceptance is recorded. That is what makes the record answerable: given a
  library, `GET /t/:slug/legal/consent/evidence` returns who accepted, when,
  from which IP, and the exact words of every document in the version they were
  shown. It comes back with a control-plane restore, so it outlives the repo.
- `defaultLocale` at signup is what the record calls the presented locale. It is
  optional, so an acceptance made without it is flagged `localeAsserted: false`
  and does not claim which translation was read; both translations of the
  version are archived regardless. Send it.

### ⚠️ Editing a document is a two-file change

Every published version has a frozen copy of all seven rendered documents at
`docs/legal/accepted/<LEGAL_VERSION>/<locale>/<slug>.md`. Editing a file under
`locales/*/legal/` without bumping the version and re-freezing **fails**
`apps/api/src/auth/legal-acceptance.spec.ts`, on purpose: before that check
existed, a one-word edit silently retargeted every acceptance already recorded.

**When you publish a material change:** update the `Last updated` line + the
body, bump `LEGAL_VERSION`, re-freeze `docs/legal/accepted/<new version>/`,
update `LEGAL_CORPUS`, and update the `legal.json` strings if needed. The exact
steps are in `docs/legal/README.md`.

After a version bump, every library that accepted the old text is stale, and
the API now says so: `GET /t/:slug/legal/consent` compares
`tenants.legalAcceptedVersion` against `LEGAL_VERSION` and returns
`reacceptanceRequired: true`, and `POST /t/:slug/legal/consent/accept`
(owner-only, body `{ "locale": "el" | "en" }`) records the new acceptance with
full evidence. That comparison is the first code in the repo to READ the column
— the audit's "nothing ever reads them" was true until it existed.

**Still missing, and it is `apps/web` work this change did not own:** the banner
that surfaces `reacceptanceRequired` to the owner and the screen that shows the
acceptance record. Until those exist a version bump means telling the live
libraries to re-accept out of band — the API can record it, but nothing in the
product asks.

## Queued correction — DPA §7.2 and §7.3 (privacy-legal-15)

**The Service now does more than the published DPA says it does.** A per-member
Article 15 / Article 20 export shipped — `GET /t/:slug/members/:id/data-export`,
with an **Export member's data** control on the member's page — and §7.2 still
reads "There is no per-member export … not something the Service lets you
self-serve today", while §7.3 still reads "there is no guardian contact field,
no age-based restriction on automated notices, and no shorter retention for a
minor's record" without mentioning the one age branch that now exists.

It is written down here rather than edited in place because editing a published
document is the two-file change above: it needs a `LEGAL_VERSION` bump, a fresh
`docs/legal/accepted/<version>/`, new digests in `LEGAL_CORPUS`, and both
locales moved together. The change that shipped the export did not own
`packages/shared/src/legal.ts` or `apps/api/src/auth/legal-acceptance.ts`, and a
half-done version bump breaks `legal-acceptance.spec.ts` for everybody.

The direction of the error is the safe one — the DPA under-promises — but it
must go out with the next version. Drafted replacements:

**`locales/en/legal/dpa.md` §7.2**, replacing the whole paragraph:

> 7.2 **Two different exports.** Settings → Export produces your whole library —
> catalogue, members, circulation — as CSV, JSON, XLSX or SQL. That is your
> Article 20 tool for moving your own data and needs nothing from us. For one
> person's Article 15 or Article 20 request, use **Export member's data** on that
> member's page instead: it produces a single structured, machine-readable JSON
> file holding that member's record, loans, reservations, fines, the notices we
> addressed to them, the activity entries about their record and their photo, and
> nothing about anybody else. It is available to an owner, an administrator or a
> librarian, never to a volunteer, and each production is recorded in your own
> activity log. The file states its own limits: it is matched on identifiers, so
> it does not sweep up rows that merely mention the person inside another
> record's free text, and it does not cover backups or anything you hold outside
> the Service. Where a request needs more than it contains, ask us under 7.4.

**`locales/en/legal/dpa.md` §7.3**, replacing the first sentence:

> 7.3 **School libraries and children.** The Service stores a date of birth if
> you enter one, and one feature reads it: the per-member export in 7.2 marks a
> subject who is under 18 — and, in a school library with no date of birth on
> file, says the subject should be presumed a pupil — so that whoever is about to
> hand the file over checks who is entitled to receive it. Nothing else in the
> Service treats a child differently: there is no guardian contact field, no
> age-based restriction on automated notices, and no shorter retention for a
> minor's record.

**And while that version is open, fix §7.1 too.** It says a member's record and
history "are reachable from that member's page in the Service: you can read
them, correct any field, and, as owner or admin, erase the member irreversibly
under Article 17." The first two are true. The third is not: erasure is
`POST /t/:slug/members/:id/erase` and **no page in `apps/web` calls it** — the
member page has no erase button (see `MemberDetail.tsx`, which has archive,
restore, suspend, reactivate and the new export, and nothing else). Either ship
the button before the version goes out, or change "from that member's page" to
name the route and say it is not yet on screen.

`locales/el/legal/dpa.md` needs the same edits in Greek; the corresponding Greek
wording already exists in `docs/legal/dpia-school-libraries.el.md` §4.1, §4.3 and
§4.6 and can be adapted. Update the `Last updated:` line in both files.

## Translations

Each document must exist in `locales/en/legal/` and `locales/el/legal/`. If a
locale is missing a file, the web app falls back to English and flags it. The
`legal.json` UI strings ARE parity-checked by `pnpm check:translations`; the
markdown bodies are not, so keep them in sync manually when you edit.
