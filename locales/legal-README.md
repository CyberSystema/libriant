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

Existing libraries are still not prompted to re-accept — nothing reads
`legalAcceptedVersion` at sign-in and there is no re-acceptance screen. Until
that UI exists, a version bump means asking the live libraries to re-accept.

## Translations

Each document must exist in `locales/en/legal/` and `locales/el/legal/`. If a
locale is missing a file, the web app falls back to English and flags it. The
`legal.json` UI strings ARE parity-checked by `pnpm check:translations`; the
markdown bodies are not, so keep them in sync manually when you edit.
