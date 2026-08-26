> **Draft — pending review by qualified legal counsel.** This document is a
> tailored starting point, not legal advice. Replace every `[PLACEHOLDER]` and
> have it reviewed before you rely on it.

# Data Processing Agreement (DPA)

**Last updated: 2026-08-27**

This Data Processing Agreement ("**DPA**") forms part of the
[Terms of Service](/legal/terms) between `[COMPANY LEGAL NAME]` ("**Libriant**",
"**Processor**") and the Library ("**Controller**", "**you**"). It governs
Libriant's processing of personal data on your behalf under Article 28 GDPR. If
there is a conflict on data-protection matters, this DPA prevails.

## 1. Roles

You are the **controller** and Libriant is the **processor** of the personal data
contained in Library Data (the "**Controller Personal Data**"). You determine the
purposes and means; we process only on your documented instructions. Where we
engage another organisation to assist (a **sub-processor**), the terms of this
DPA flow down to them.

## 2. Subject-matter and details of processing (Annex I)

- **Subject-matter & duration:** processing for the term of your subscription
  plus the post-termination return/deletion window.
- **Nature & purpose:** hosting and operating a library-management service —
  storing and managing catalogue, members, loans, reservations, fines, imports/
  exports, notifications, and related features — solely to provide the Service.
- **Categories of data subjects:** your **members/patrons** (which may include
  **children**), your **staff/volunteers**, and other individuals whose data you
  enter.
- **Categories of personal data:** identification and contact details (e.g. name,
  member number, email, phone, address), borrowing/reservation/fine history,
  staff account data, and any **custom fields you define** (you must not enter
  special-category data unless you have a lawful basis and have informed us).
- **Special categories:** not required by the Service; processed only if you
  choose to enter them, under your responsibility.
- **Access by Libriant personnel:** our staff have **no standing access** to
  your library's database. Two paths exist and both are described in Section 6:
  a **support session**, which only you can open by issuing a one-time key, and
  an **administrative database export**, which for a single named library
  requires an open support session that you issued. Both are recorded in your
  own audit log, and both are notified to your registered contact address.

## 3. Your instructions and obligations

3.1 Your documented instructions are: these Terms, this DPA, your configuration,
and your use of the Service's features. We will inform you if, in our opinion, an
instruction infringes the GDPR.

3.2 You warrant that you have a lawful basis to process the Controller Personal
Data and to have us process it, that you have provided required notices to data
subjects (including for any minors), and that your instructions are lawful.

## 4. Our obligations as processor

We will: (a) process Controller Personal Data only on your documented
instructions, including for transfers, unless required by law (and then we will
inform you unless legally prohibited); (b) ensure persons authorised to process
it are bound by confidentiality; (c) implement the security measures in
Section 6; (d) respect the sub-processor conditions in Section 5; (e) assist you,
taking into account the nature of processing, with data-subject requests
(Section 7) and with your obligations under Articles 32–36 (security, breach
notification, DPIAs, prior consultation); (f) at your choice, delete or return
Controller Personal Data at the end of provision (Section 8); and (g) make
available information necessary to demonstrate compliance and allow for and
contribute to audits (Section 9).

## 5. Sub-processors

5.1 You provide **general authorisation** for Libriant to engage sub-processors.
The current list is published at [Sub-processors](/legal/subprocessors).

5.2 We will give at least `[30]` days' notice of any intended addition or
replacement of a sub-processor (e.g. by updating that page and/or by email),
giving you the opportunity to object on reasonable data-protection grounds. If we
cannot resolve a reasonable objection, you may terminate the affected Service.

5.3 We impose data-protection obligations on each sub-processor that are no less
protective than this DPA, and we remain liable for their performance.

## 6. Security measures (Annex II)

6.1 Taking into account the state of the art and the risk, we implement
appropriate technical and organisational measures, including: encryption of data
in transit (TLS); **logical isolation of each Controller's data in a separate
database**; password hashing (bcrypt) and encryption of authentication secrets
at rest; mandatory MFA for platform administrators; role-based access control
and least-privilege access; network segmentation; audit logging of sensitive
actions; rate limiting and abuse protection; regular encrypted backups with
restore testing; and vulnerability management. We review these measures and may
update them provided protection is not materially reduced.

### 6.2 Support access — Libriant staff acting inside your data

Libriant staff have no standing access to your library's database. When you ask
us for help that requires it, access works like this, and only like this:

1. **You open the door.** An owner or admin in your library generates a one-time
   support key from Settings → Support access. We cannot generate one for
   ourselves. The key is stored only as a bcrypt hash, is valid for 60 minutes,
   and can be redeemed once.
1. **A named administrator redeems it.** Redemption requires a Libriant
   administrator account with multi-factor authentication enabled. Failed
   redemption attempts are recorded with their source IP address.
1. **The window is time-boxed and yours to close.** A session lasts at most four
   hours and then ends automatically. You can end it earlier at any moment, and
   at most one session per library can be open at a time.
1. **What we may do inside it is limited.** During a support session we cannot
   create staff accounts, reset staff passwords, or change staff roles; cannot
   change your plan or payment details; cannot start a data export in your name;
   and cannot alter or revoke your own support keys and sessions. A refusal is
   logged in the same places as an action.
1. **Everything is recorded, on both sides.** Every request in the window is
   written to our `support_action_log` with the method, the path, the record
   touched and — for changes — a before/after snapshot of the changed fields.
   Every change and every refusal is **also** written to your library's own
   audit log, flagged as having happened through support, where you read it at
   Settings → Activity. Reads stay in the support log rather than your activity
   feed, and you can read that log yourself.
1. **You are told by e-mail** when a key is generated, when it is redeemed (with
   the administrator's name and source IP), and when the session ends.

Those before/after snapshots capture the records we touched, so they may contain
Controller Personal Data. We treat them as Controller Personal Data for every
purpose of this DPA, including Sections 8 and 10. The support log, session
records and redemption attempts live in Libriant's control-plane database in the
EU/EEA and are retained for `[RETENTION PERIOD — SUPPORT LOGS]`.

### 6.3 Administrative database exports

The Service can produce a complete copy of a library's database as a file (CSV,
JSON, XLSX or SQL). **You** can do this for yourself at any time from Settings →
Export; that is your Article 20 tool and needs nothing from us.

When **Libriant** initiates an export:

1. An export of one named library requires an **open support session for that
   library** — the same key you issued under 6.2. Without one the request is
   refused.
1. It is recorded in our control-plane audit log with the administrator, the
   scope, the source IP address and the support session it was taken under; and
   in **your** library's audit log, where it appears in your activity feed as
   `tenant.exported`. It also appears in your own export list at Settings →
   Export, marked as requested by Libriant rather than by your staff.
1. We e-mail your registered contact address when it happens.
1. A **platform-wide** export may cover every library at once. No single library
   can consent on behalf of the others, so such an export is never taken under a
   support session — but it is written to **every** affected library's audit log
   and notified the same way, and our control-plane record lists the libraries
   included and any that could not be told.
1. The produced file is downloadable only by a Libriant owner-administrator, the
   download is itself audit-logged, and the file is deleted automatically 24
   hours after it is produced (2 hours for a platform-wide export).

We remain able to reach the underlying databases as their operator; nothing
above claims otherwise. What 6.2 and 6.3 do is ensure that the routine,
one-click paths cannot be used without your consent and cannot be used without
leaving a record you can read.

### 6.4 Wording you can reuse in your own member notice

You may need to describe the above in the privacy notice you give your members.
You are free to adapt the following:

> Our library-management system is operated for us by Libriant. Libriant staff
> have no standing access to your data. If we ask them for technical help that
> requires it, we issue a one-time key that opens a support window of at most
> four hours, which we can close at any moment; everything done in that window
> is recorded in our own activity log, which we can inspect. Libriant may also
> produce a complete copy of our database at our request or during such a
> window; every copy is recorded in our activity log and is deleted
> automatically within 24 hours.

## 7. Assistance with data-subject rights

7.1 **What you can do yourself.** A member's record — and their loans,
reservations and fines — are reachable from that member's page in the Service:
you can read them, correct any field, and, as owner or admin, erase the member
irreversibly under Article 17. That answers most access, rectification and
erasure requests without involving us.

7.2 **Export is at library level, not at data-subject level.** The export
feature produces your whole library — catalogue, members, circulation — as CSV
or JSON. There is no per-member export, so an Article 20 portability request for
a single person is not something the Service lets you self-serve today. Ask us
instead: through the support-access route in Section 6.2, which only you can
open, we will produce that person's record and history in a structured, commonly
used, machine-readable form. We say this plainly rather than describe the
library-wide export as a per-subject tool, because producing a copy of your
entire member registry in order to answer one member's question would disclose
far more than the question asked.

7.3 **School libraries and children.** The Service stores a date of birth if you
enter one and otherwise treats every member alike: there is no guardian contact
field, no age-based restriction on automated notices, and no shorter retention
for a minor's record. Notices are sent to the address on the member record, so
where a pupil's notices should reach a parent or guardian, that is the address
to enter. The assistance we owe you under Section 4(e) towards an Article 35
assessment is a **DPIA information pack for school libraries** — the description
of the processing, the categories of data, the retention periods actually
enforced by the system, the Article 32 measures, and the decisions that remain
yours — which we will send you on request to `[CONTACT EMAIL]`, together with
our Article 30(2) record.

7.4 If a data subject contacts us directly about your data, we will refer them
to you. We will provide reasonable assistance, taking into account the nature of
the processing, for requests you cannot fulfil through the Service.

## 8. Return and deletion

On termination, and at your choice, we will return and/or delete the Controller
Personal Data within `[30]` days, except where retention is required by law.
Residual copies in backups are deleted on the normal backup-rotation cycle.

## 9. Audits

We will make available the information necessary to demonstrate compliance with
Article 28 (e.g. documentation, security summaries, and `[third-party
certifications/reports if any]`). For an on-site or detailed audit, the parties
will agree reasonable scope, timing, and confidentiality in advance, no more than
`[once per year]` except following a personal-data breach.

## 10. Personal-data breaches

We will notify you **without undue delay** after becoming aware of a personal-
data breach affecting Controller Personal Data, with the information available to
help you meet your Article 33/34 obligations, and we will take reasonable steps to
mitigate it.

## 11. International transfers

We process Controller Personal Data in the **EU/EEA**. Where a sub-processor
processes it outside the EEA, we ensure an adequacy decision or EU Standard
Contractual Clauses (with supplementary measures as needed) are in place.

## 12. Liability and term

Liability under this DPA is subject to the limitations in the Terms, except where
the GDPR provides otherwise. This DPA remains in effect for as long as we process
Controller Personal Data.

## 13. Contact

Data-protection contact: `[DPO EMAIL]` / `[CONTACT EMAIL]`.
