# Campaign brief — launch offer

## The job

Win the **first 5 Greek libraries** as reference customers. The product is finished,
audited and in service; this is a launch, not a trial.

The first year is free because it is a **launch offer** for the first ten — a
normal way to open a market where the incumbent is free (ABEKT) or zero-cost
(Excel), and where an unknown vendor has to take price out of the decision to get
a fair hearing. It also lets the Hetzner server be sized against real demand
rather than a guess.

## Audience

Greek libraries, three segments, one swappable paragraph each (`email/variants.md`):

| Segment                   | Who                                                 | Current state                               | What lands                                                              |
| ------------------------- | --------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| **Municipal & community** | δημοτικές, κοινοτικές, λαϊκές                       | ABEKT, an abandoned local install, or paper | Respect for what they've built; a system that doesn't need a maintainer |
| **School & academy**      | σχολικές, φροντιστήρια, ιδιωτικά εκπαιδευτήρια      | Excel, or nothing                           | Time. The reader is a teacher doing this off the side of their desk     |
| **Specialist & private**  | μουσεία, δικηγορικά, εταιρικές, ΜΚΟ, εκκλησιαστικές | Nothing that fits their material            | Custom fields and custom record types, without a developer              |

Not in scope for wave one: academic/university libraries (procurement cycles too
long for a pilot) and anything outside Greece.

## Offer

**Municipal plan, first year free, first 5 libraries.** No card, no
auto-renewal, catalogue migration done for them, and a permanent founding
discount afterwards.

**Never anchor on €948.** The annual value of the Municipal tier is real, but
leading with it makes every reader picture that invoice landing in twelve months —
and it is wrong for most of them. Libriant runs five plans:

| Plan          | €/mo   | Titles  | Members |
| ------------- | ------ | ------- | ------- |
| Starter       | 0      | 500     | 100     |
| Community     | **19** | 5.000   | 1.000   |
| Municipal     | 79     | 30.000  | 7.500   |
| Institutional | 249    | 200.000 | 50.000  |

**The ad says "μετά, πακέτα από 19€ τον μήνα".** Not €0 — a free tier reads as
hobby software to a municipal director, and Starter's 500-title cap excludes
essentially every recipient anyway, so €19 is the honest entry price _for the
reader being addressed_. Not €79 or €948 — those are the tier they're being given
free, not the tier they must buy.

The site, which has room to be complete, names the full ladder including the free
level and its 500-title cap. Neither surface overstates; the ad leads with one
number and the site explains all of them.

The €79/month price is stated plainly as the price, with the first 12 months free
for the first ten. No money changes hands during the offer period and the site
carries no checkout. See
`docs/brand/name-clearance-2026-08-21.md` and `apps/site/content/programme-terms.el.md`.

## Positioning

> Ένας ήρεμος, σύγχρονο χώρος εργασίας για τον κατάλογο, τα μέλη και τον
> καθημερινό δανεισμό — στα ελληνικά, φτιαγμένο για βιβλιοθηκονόμους.

Against the competition:

- **ABEKT** — free and entrenched in Greek public libraries. Don't attack it. The
  wedge is libraries it doesn't fit: too small, too informal, or frustrated by it.
  Variant B's "παράλληλα, χωρίς να αλλάξει τίποτα" framing exists for this.
- **Ex Libris / Koha / international ILS** — priced and scaled for institutions
  far larger than the target, and not Greek-first.
- **Excel and paper** — the real incumbent, and the one most recipients use.

**Credibility comes from verifiable specifics, not adjectives.** Libriant has no
public customers yet, so the campaign substitutes proof for social proof:

- a **completed pre-production security audit** — 3 passes, 27-agent adversarial
  review across 14 dimensions, all 63 findings remediated; no auth bypass, no
  cross-tenant data access, no SQL injection, no RCE
- an **automated test suite** (318 unit + 36 integration) run on every change
- **EU hosting, nightly backups**, off-site copy (`scripts/backup.sh`)
- **full data export, one click, any time** — no lock-in
- exact plan limits quoted as numbers rather than "generous"

Every one is checkable in the repo. None is a claim about popularity, which is the
claim we cannot yet make.

## Funnel

```
Cold email (individual send, personalised subject)
   ↓
libriant.com  ← the credibility check; they WILL look you up
   ↓
Application form (mirrors signup fields exactly)
   ↓  D1 + email notification
Personal reply within 1 working day
   ↓
20-minute call
   ↓
Provision: Municipal plan, manual billing, paidUntil +12 months
   ↓
We run their import
```

The reply-to fallback matters as much as the button — some institutional readers
will never click a link in a cold email but will happily hit reply.

## What we're measuring

Track **replies, not opens** — the email has no tracking pixel by design, because
the site promises no tracking and it would be hypocritical to embed one.

| Metric                 | Target                                             |
| ---------------------- | -------------------------------------------------- |
| Replies per 40 sent    | 2–6                                                |
| Applications completed | 2–6                                                |
| Libraries onboarded    | until 5 total                                      |
| Opt-outs (`ΔΙΑΓΡΑΦΗ`)  | < 5% — higher means the list or targeting is wrong |

Zero replies from 40 well-chosen addresses is a list or offer problem, not a copy
problem. Don't rewrite the email; come back and diagnose before burning more
addresses.

## Assets

```
email/el.html        the email — 600px tables, all inline CSS, zero images
email/el.txt         plain-text alternative (send as multipart/alternative)
email/subjects.md    5 subject + preheader pairs, one recommended
email/variants.md    the 3 swappable segment paragraphs
send-checklist.md    sender setup, legal posture, testing, sending cadence
reply-playbook.md    reply templates + the provisioning runbook
prospects.template.csv / suppression.csv
```

**Format: an advertisement, not a letter.** No salutation, no sign-off, no
second-person address anywhere in the body. 93 words. The reader is not being
written to — they are being shown a product and a price.

**Design.** The whole ad lands in one screen: ink field, headline, the shelf
graphic, the price, four capabilities, one button. The hero visual is the brand
mark rebuilt as **book spines drawn in table cells** — varying heights, brand
teals and golds, standing on the cream shelf that becomes the offer panel. It
carries no image file, so it renders at full strength in Outlook, with images
blocked, and it cannot fail to load. The offer leads with **12 μήνες δωρεάν** — the
duration, not a price.

The CTA uses the same `#13B0A0` / `#042522` pairing as the button on libriant.com,
so the click-through feels continuous.

**Tone.** Declarative. The product is finished and audited; the ad says so by
showing the product, not by arguing for it.

## Sequencing

1. ~~Site live at libriant.com~~ ← **blocks everything below**
2. DMARC record added
3. Placeholders filled, tested on your own Gmail / Outlook / iCloud
4. List of 30–50 built from published institutional addresses
5. Wave one, 10–15 sends a day, Tue–Thu mornings
6. One follow-up after 7–10 days, then stop
7. Wave two to a fresh list if fewer than 5 accepted

**Do not send in August** — Greek public institutions are largely closed.
