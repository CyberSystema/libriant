# Prospect list — sources, coverage and gaps

`prospects.csv` holds **306 Greek libraries, 299 of them sendable** (in Greece,
with a published email, in a targeted segment).

## The rule this list was built under

**Every email in this file was read from a page that library published.** None
was guessed, pattern-matched from a domain, or inferred from a name. A library
with no published address has an empty `email` cell and a note saying so — that
is the honest result, and it is the right one: an invented address bounces,
damages the sending domain's reputation, and can land in a stranger's inbox.

If you extend the list, hold that line.

## What is in it

|                                                  | Count   |
| ------------------------------------------------ | ------- |
| Total records                                    | 306     |
| In Greece                                        | 301     |
| With a published email                           | 305     |
| **Sendable (Greece + email + in-scope segment)** | **299** |

Sendable, by campaign segment (see `email/variants.md`):

| Segment                       | Count | Who                                   |
| ----------------------------- | ----- | ------------------------------------- |
| **B** — municipal & community | 256   | δημόσιες, δημοτικές, λαϊκές, παιδικές |
| **D** — specialist & private  | 25    | ειδικές, ιδιωτικές, φυλακών           |
| **C** — school & academy      | 18    | σχολικές                              |

By region: Αττική 86 · Κεντρική Μακεδονία 57 · Θεσσαλία 33 · Πελοπόννησος 24 ·
Κρήτη 19 · Στερεά Ελλάδα 19 · Αν. Μακεδονία & Θράκη 15 · Δυτική Ελλάδα 12 ·
Νότιο Αιγαίο 10 · Δυτική Μακεδονία 8 · Ιόνια Νησιά 7 · Βόρειο Αιγαίο 5 · Ήπειρος 4.

## Sources

**1. Δίκτυο Ελληνικών Βιβλιοθηκών — National Library of Greece**
<https://network.nlg.gr/library/> — 304 records, harvested 2026-08-21 from each
library's own directory page via the site's `library-sitemap.xml`. This is the
single best source in Greece: it carries name, postal address, phone, email,
website, type and region for essentially every entry. **303 of 304 had a
published email.** Every row's `source_url` points at the exact page it came from.

**2. Ministry of Education list of state public libraries**
<https://edu.klimaka.gr/ekpaideytikoi/genika/459-katalogos-me-dhmosies-vivliothhkes>
— 46 libraries with postal addresses but no emails. Used as a **cross-check**:
42 of the 46 were already in the NLG directory. Of the 4 missing, 2 were traced
to their own sites and added (Δημητσάνα, Μηλιές).

## Known gaps — read before assuming this is everything

**1. Two state public libraries still have no verified email.**
Δημόσια Βιβλιοθήκη Πεταλιδίου and Δημόσια Ιστορική Βιβλιοθήκη Μήθυμνας «Αργύρης
Εφταλιώτης» appear in the Ministry list but not in the NLG directory, and neither
publishes an address I could confirm. Both have postal addresses and are worth a
phone call.

**2. Academic libraries are deliberately near-absent.** Greece has ~37 (24
university + 13 former TEI). Only 1 is in this list. Two reasons: the NLG
directory barely covers them, and **they are the worst fit for this campaign** —
long public-procurement cycles, and most already run Alma, Koha or ΣΕΑΒ shared
systems. `brief.md` puts them out of scope for wave one. If you want them later,
the roster with websites is at
<https://el.wikipedia.org/wiki/Ακαδημαϊκές_βιβλιοθήκες_στην_Ελλάδα> — but each
email needs a manual lookup, because scraping a university site is how you end up
emailing a webmaster.

**3. The long tail of municipal libraries.** Greece is estimated to have ~686
δημοτικές και κοινοτικές βιβλιοθήκες. This list has 184 δημοτικές, so roughly a
quarter of the municipal universe. The rest are small branches that publish
nothing centrally; reaching them means going municipality by municipality
(δήμος → Πολιτισμός → Βιβλιοθήκη). That is real work with a low yield per hour,
and 299 sendable addresses is already six waves' worth.

**4. School libraries are barely represented.** 18 here, against thousands of
Greek school libraries. Most have no public web presence at all and are reachable
only through the school itself (`@sch.gr`). If segment C proves to convert, the
route in is the school directory, not a library directory.

**5. Five records are outside Greece** (4 Cyprus, 1 England). They are kept for
completeness but marked `in_greece=no` and excluded from the sendable count.
**Filter on `in_greece=yes` before any send.**

## Using it

```
library_name  library_type   segment_variant  region  city  email  phone
address       website        source_url       source_date    in_greece
subject_variant  sent_date   replied          outcome        notes
```

- `library_type` uses the app's own enum (`packages/shared/src/library.ts`), so an
  accepted library can be provisioned straight from its row.
- `segment_variant` maps to the swappable line in `email/variants.md`.
- `sent_date` / `replied` / `outcome` are yours to fill as the wave runs.

Sort by `region` to send geographically — it makes follow-up calls efficient and
keeps a day's batch coherent.

**Before the first send, re-read `send-checklist.md`.** In particular: these are
institutional addresses published by the libraries themselves, which is the
posture that makes this defensible under Greek Law 3471/2006 and the GDPR. Keep
it that way — do not add named-individual mailboxes, and honour every ΔΙΑΓΡΑΦΗ
the same day into `suppression.csv`.

## Reproducing or extending the harvest

The scraper is not committed (it is a one-off), but it is trivial to redo:
`https://network.nlg.gr/library-sitemap.xml` lists every record URL, and each page
carries a `<div class="library-details">` block with address, phone and a
`mailto:` link. Taxonomy comes from the `lib_cat-*` / `lib_area-*` CSS classes.
Be polite — a few workers, a delay per request, and a User-Agent that says who
you are.
