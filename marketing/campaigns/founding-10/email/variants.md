# Segment variants

The ad carries **one swappable line** — the sub-headline under the main headline,
marked `══ SWAPPABLE LINE ══` in `el.html` (and line 4 of `el.txt`).

That is deliberately the only variable. An advertisement earns attention through
its visual and its offer, not through paragraphs of tailored argument; swapping one
line keeps the relevance without turning the ad back into a letter.

The default is **A**, which works for any recipient.

---

## A — general (the default in the file)

> Κατάλογος · Μέλη · Δανεισμοί · Κρατήσεις

Names the four things the product does, as a rhythm rather than a sentence. Works
for every segment and needs no knowledge of the recipient.

## B — municipal & community libraries

> Για δημοτικές βιβλιοθήκες που δεν θέλουν πια να παλεύουν με το λογισμικό τους

Speaks to the specific frustration — not lacking a system, but fighting the one
they have. Use for δημοτικές, κοινοτικές, λαϊκές βιβλιοθήκες.

## C — school & academy libraries

> Για σχολικές βιβλιοθήκες που τις κρατάει όρθιες ένας άνθρωπος, μία ώρα την εβδομάδα

The reader is almost never a professional librarian — it's a teacher who inherited
the library. Naming that exactly is the entire pitch for this segment.

## D — specialist & private libraries

> Δικά σας πεδία, δικοί σας τύποι εγγραφών — χωρίς προγραμματιστή

The one segment with a genuinely different problem: generic library software forces
their material into a book-shaped schema. Both capabilities are real and shipped
(`max_custom_fields_per_entity`, `max_custom_collections` in
`packages/shared/src/features.ts`) — don't use this line for a tier that lacks them.

---

## Personalisation

Don't add a personalised sentence to the ad. It would reintroduce exactly the
letter register the format is built to avoid, and a half-personal advertisement
reads worse than a clean impersonal one.

Personalise the **subject line** instead — see `subjects.md`. That is where naming
the library earns the open, and it costs the design nothing.
