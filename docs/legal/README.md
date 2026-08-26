# `docs/legal/` — the documents that are not published

The seven documents a visitor can read live in `locales/<locale>/legal/` and are
rendered at `/<locale>/legal/<slug>`. This directory holds the legal artefacts
that are **not** web pages: the record we owe a regulator, the material we owe a
school library assessing its own risk, and the frozen evidence of what each
published version actually said.

## `ropa.el.md` / `ropa.en.md` — record of processing activities

The GDPR **Article 30(2)** record: every category of processing Libriant carries
out on behalf of its customer libraries, the controllers it acts for, the
recipients, the transfers, the retention periods, and a description of the
Article 32 measures. Greek is the operative language — the Hellenic DPA works in
Greek — and the English version is a translation for non-Greek customers.

It exists because it did not (finding privacy-legal-08). It is the first
document an authority asks for in an inspection or after a breach, and the first
thing a public body's DPO asks for during vendor due diligence, so it is
versioned with the code rather than kept in someone's drive.

Two things about it that are easy to get wrong:

- **It records what the system does, not what we wish it did.** Section 7 splits
  retention into "enforced today, by this job" and "not determined yet". Writing
  a period nobody enforces would be worse than writing nothing.
- **`pnpm check:legal` does not scan this directory** — it gates
  `locales/*/legal/` only. Section 0 of the record therefore lists its own
  unfilled `[PLACEHOLDER]` values by hand. If you fill placeholders in the
  published documents, check Section 0 too.

## `dpia-school-libraries.el.md` / `.en.md` — the Article 35 material

The processor's half of a data-protection impact assessment, for the customer
segment that needs one: school libraries, whose members are children. It states
what the system does, what it does **not** do (there is no guardian field and no
age logic anywhere in the product), the risks that follow, and the measures that
answer them.

It exists because [DPA](../../locales/el/legal/dpa.md) §4(e) promises assistance
with Articles 32–36 to a segment it names in Annex I, and shipped none (finding
privacy-legal-12). DPA §7.3 now points at it, which is the only reason it counts
as delivered: a document nobody is told about is not assistance.

It is **not** a DPIA. The assessment belongs to the school as controller, and
the pack says so in its first paragraph — an aid a processor writes and a
controller signs is exactly the confusion Article 35 does not tolerate.

## `accepted/<LEGAL_VERSION>/` — what each version actually said

One frozen directory per published version of the legal corpus, holding the
**rendered body** of all seven documents in both locales — the leading author
blockquote stripped, exactly as `apps/web/lib/legal.ts` strips it before
rendering, so the bytes here are the bytes a visitor saw.

`DIGESTS.txt` in each directory is `shasum -a 256` output and can be checked
directly:

```sh
cd docs/legal/accepted/<version> && shasum -a 256 -c DIGESTS.txt
```

This exists because acceptance was recorded but not evidenced (finding
privacy-legal-09): signup stored a single date string, and the web app renders
whatever is at HEAD, so nothing could establish _which text_ a library agreed
to. Now `apps/api/src/auth/legal-acceptance.ts` compiles in the SHA-256 of each
file here and signup writes them into a `tenant.legal_accepted` audit row
alongside the tenant.

### Publishing a new version

1. Edit the documents under `locales/{el,en}/legal/` and update their
   `Last updated:` line.
2. Bump `LEGAL_VERSION` in `packages/shared/src/legal.ts` to the new ISO date.
3. Freeze the new corpus:

   ```sh
   # Read the constant from source — packages/shared is not built in a fresh checkout.
   V=$(sed -n "s/^export const LEGAL_VERSION = '\(.*\)';$/\1/p" packages/shared/src/legal.ts)
   for L in el en; do
     mkdir -p "docs/legal/accepted/$V/$L"
     for F in locales/$L/legal/*.md; do
       # strip the leading author blockquote, then write the body
       awk 'BEGIN{s=1} s==1 && /^>/ {next} s==1 && /^[[:space:]]*$/ {next} {s=0; print}' "$F" \
         > "docs/legal/accepted/$V/$L/$(basename "$F")"
     done
   done
   (cd "docs/legal/accepted/$V" && shasum -a 256 {el,en}/*.md > DIGESTS.txt)
   ```

4. Copy the digests into `LEGAL_CORPUS` in
   `apps/api/src/auth/legal-acceptance.ts`.
5. Run `pnpm --filter @libriant/api test` — `legal-acceptance.spec.ts` compares
   all three artefacts and fails if any disagree.

**Never edit a frozen directory.** A version that changes after publication is
the exact defect this scheme exists to prevent.

### Still missing

Existing libraries are not yet **prompted** to re-accept when `LEGAL_VERSION`
moves. Half of this has since been built: `ConsentService.stateFor()` reads
`tenants.legalAcceptedVersion`, `GET /t/:slug/legal/consent` answers with
`reacceptanceRequired`, and `POST /t/:slug/legal/consent/accept` records a fresh
acceptance (privacy-legal-09). What is missing is a caller — no page in
`apps/web` requests either route, so nothing surfaces the prompt. Until that UI
exists, a version bump must be followed by asking the launch libraries to
re-accept explicitly.
