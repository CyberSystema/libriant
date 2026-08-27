# DPIA information pack — school libraries (GDPR Article 35)

**Last updated: 2026-08-27** · **Document version: 2** ·
Greek version: [`dpia-school-libraries.el.md`](./dpia-school-libraries.el.md)

## What this is, and what it is not

This is the material Libriant owes a customer under **Article 28(3)(f)** and
promises in [DPA §4(e) and §7.3](../../locales/en/legal/dpa.md): the processor's
side of a data-protection impact assessment. It describes what the system does,
what it does **not** do, and which risks the school has to weigh.

**It is not a DPIA and it is not legal advice.** The assessment under Article 35
is the **controller's** — the school, or the authority that runs it. Only the
school can state its lawful basis, its necessity and proportionality reasoning,
and its own conclusion. Sign nothing that says otherwise.

It exists because the DPA names school libraries and children as a category of
data subject (Annex I) and promises assistance with Articles 32–36, and until
now nothing behind that promise had been written down (finding
privacy-legal-12).

## 1. Whether you need one

Article 35(1) requires a DPIA where processing is "likely to result in a high
risk". The EDPB's nine criteria (WP248 rev.01) are the usual test; a school
library's circulation records normally touch at least these:

- **Data of vulnerable data subjects** — pupils are children, and the imbalance
  between a school and a pupil is exactly what the criterion is about.
- **Data processed on a large scale** — relative to the size of the school:
  every pupil, continuously, for as long as they attend.
- **Matching or combining datasets** — if you import pupils from a school
  information system rather than registering them at the desk.

Two criteria are generally taken to indicate high risk. Also check the Hellenic
DPA's published list of processing operations that always require a DPIA:
`[HDPA DPIA LIST REFERENCE — to be confirmed by counsel]`.

None of this decides the question for you. If your conclusion is that no DPIA is
required, record that conclusion and the reasons — that record is itself an
accountability document under Article 5(2).

## 2. Description of the processing (Article 35(7)(a))

The authoritative description is our Article 30(2) record,
[`ropa.en.md`](./ropa.en.md); its Sections 3–8 can be quoted directly into your
assessment. In summary:

| Question             | Answer for Libriant                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Who processes        | Your school (controller) → Libriant (processor) → the sub-processors in [Sub-processors](../../locales/en/legal/subprocessors.md)            |
| What data            | Member identity and contact details, an optional **date of birth**, borrowing / reservation / fine history, any **custom fields you define** |
| Whose data           | Pupils, staff, and anyone else you enter                                                                                                     |
| What the system does | Registry, circulation, reservations, fines, search, imports, exports, notifications                                                          |
| Where                | One separate database per library, on EU infrastructure                                                                                      |
| For how long         | Member records: until **you** delete them. Enforced automatically today: the periods in `ropa.en.md` §7.1 — none of them is age-based        |
| Automated decisions  | None. Fines accrue arithmetically from a due date; nothing profiles a pupil                                                                  |

## 3. Necessity and proportionality (Article 35(7)(b)) — your decisions

Libriant cannot answer these, but it is worth knowing which of them the software
actually forces:

| Decision                                   | What the software requires                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Lawful basis for pupils' borrowing records | Nothing is enforced in software; Article 6 (and 8, if you rely on consent) is yours       |
| Date of birth                              | **Optional.** Leave it blank unless an age rule of your own needs it                      |
| Home address, phone                        | **Optional.** A school library usually does not need a pupil's home address               |
| Custom fields                              | Free text you define. Nothing stops staff typing more than you decided to collect         |
| Automated notices                          | Off unless enabled, and sent to the address on the member record — see §4                 |
| Staff roles                                | Owner / admin / librarian / volunteer, with volunteers restricted from destructive writes |

## 4. Risks specific to pupils, stated plainly (Article 35(7)(c))

These are the ones a school should assess. Each is a fact about the product
today, not a hypothetical.

1. **There is no guardian field, and age changes almost nothing.** A date of
   birth is stored if you enter one. Exactly one thing in the product reads it
   as an age: the per-member data export in risk 6 below flags a subject who is
   under 18 (and, in a school library with no date of birth on file, says the
   subject should be presumed a pupil), so that the person about to hand the
   file over is told to check who is entitled to receive it. That is a caution
   at the desk, not a control. There is still **no reduced retention for a
   minor, no restriction on automated e-mail to a child's address, and no
   consent flag.** If a pupil's notices must reach a parent, **enter the
   parent's address in the member record** — that is the only routing the system
   has, and it is why the export deliberately does not attribute a notice to a
   pupil merely because it was sent to the mailbox on their record.
2. **A notice names the book.** An overdue notice's subject is
   «Εκπρόθεσμο: «<title>»», so whoever reads that mailbox learns what the child
   borrowed. Consider whether that mailbox is the child's, the parent's, or the
   school's.
3. **Borrowing history is kept until you delete it.** There is no shorter
   retention for a minor's record. Erasure is a deliberate act and, as of this
   version, an API action only: `POST /t/<your library>/members/<id>/erase`,
   restricted to an owner or an administrator and irreversible (Article 17). The
   member's page does not yet carry a button for it, so until it does, agree
   with us how a leaver's record gets erased rather than assuming a librarian
   can do it from the screen. Plan for it before the first cohort leaves.
4. **On the configuration Libriant ships, e-mail is not delivered at all**
   (`EMAIL_DRIVER=console`): messages are composed and stored but never sent, and
   are recorded as `failed`. Do not build a process on notices reaching anyone
   until we confirm a mail provider is configured for your library.
5. **A shared circulation-desk device keeps some data locally.** Offline
   circulation actions, and actions that could not be completed, are held in the
   browser with a short summary naming the pupil and the title — see the
   [Cookie Policy](../../locales/en/legal/cookies.md), "Local storage", for
   exactly what is cleared when.
6. **There are two exports, and only one of them is safe to use for a pupil.**
   Settings → Export produces the **whole library**: treat every such file as a
   copy of the entire pupil registry and handle it accordingly. A member's own
   page now also has **Export member's data**, which produces one JSON file
   holding that member's record, loans, reservations, fines, the notices
   addressed to them, the activity entries about their record and their photo —
   and nothing about anybody else. That is the file to produce for an Article 15
   or Article 20 request; use the library-wide export for a migration, never for
   a pupil's question. It is available to the owner, an administrator or a
   librarian, never to a volunteer, and every production of it is written to
   your activity log as `member.data_exported` (counts only — the log does not
   become a second copy of the answer). What it deliberately does **not**
   contain is listed inside the file itself, under `notCovered`.
7. **The audit log records staff actions against member records.** Its retention
   follows your plan, and with subscriptions disabled — the current
   configuration — retention is **lifted**, not zero: nothing is deleted on age.

## 5. Measures already in place (Article 35(7)(d))

Quote these from [DPA §6](../../locales/en/legal/dpa.md) and `ropa.en.md` §8:

- One separate database per library, on EU infrastructure.
- **No standing access** for Libriant staff. A support session exists only when
  you issue a one-time key; it lasts at most four hours, you can end it at any
  moment, and everything done inside it is written to **your** audit log.
- Administrative database exports require that window, are audited, and the file
  is deleted automatically within 24 hours.
- Article 17 erasure that also overwrites the identifiers in the audit trail.
- A per-member Article 15 / Article 20 export (risk 6) that is scoped to one
  person by foreign key, so answering one pupil's request cannot disclose
  another's — including where two pupils share one guardian's mailbox.
- Role-based access control, mandatory MFA for platform administrators,
  encrypted backups with restore testing, rate limiting.

Measures that remain **yours**: which fields you fill in, who gets a staff
account and at what role, whether notices are on and where they are addressed,
when a leaver's record is erased, and the notice you give pupils and parents.
DPA §6.4 contains wording you may reuse in that notice.

## 6. If a high risk remains (Article 36)

If your assessment leaves a residual high risk you cannot mitigate, Article 36
requires prior consultation with the Hellenic DPA before the processing starts.
Tell us if you reach that point: we will supply whatever the authority asks of
the processor.

## 7. What we will send you on request

To `[CONTACT EMAIL]`, for a named library:

- this pack and the Article 30(2) record;
- the sub-processor list with locations and safeguards;
- a summary of the Article 32 measures;
- a single member's record and history in a machine-readable format, if you
  cannot produce it yourself. Since document version 2 you can: **Export
  member's data** on the member's own page does exactly this, so the usual
  answer to an Article 15 or Article 20 request needs nothing from us. DPA §7.2
  still describes the older position and is corrected at the next publication of
  the legal corpus; where the two disagree, the product is the one that changed.

## 8. What is not filled in yet

`pnpm check:legal` scans the published documents under `locales/*/legal/`, not
this directory, so the placeholders here are listed by hand:

| Value                          | Used in   |
| ------------------------------ | --------- |
| `[HDPA DPIA LIST REFERENCE …]` | Section 1 |
| `[CONTACT EMAIL]`              | Section 7 |

## Revision history

| Version | Date       | Change                                                                                      |
| ------- | ---------- | ------------------------------------------------------------------------------------------- |
| 1       | 2026-08-27 | First issue — finding privacy-legal-12 (promised, never written)                            |
| 2       | 2026-08-27 | Per-member Article 15/20 export shipped (privacy-legal-15); §4.1, §4.6, §5 and §7 corrected |
