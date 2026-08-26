# Record of processing activities — processor (GDPR Article 30(2))

**Last updated: 2026-08-26** · **Document version: 1** ·
Greek version: [`ropa.el.md`](./ropa.el.md)

This is the record Libriant maintains **as a processor** under Article 30(2)
GDPR, covering all categories of processing carried out on behalf of its
customer libraries. Section 9 separately covers the processing for which
Libriant is a **controller** (Article 30(1)).

It is not a marketing document. It is the first document the Hellenic Data
Protection Authority asks for in an inspection or after a breach, and the
document a public body's DPO asks for during vendor due diligence. It is
versioned with the code.

## 0. What is not filled in yet

The following values cannot be supplied by any engineer — they depend on the
company being registered and on counsel review (privacy-legal-01). `pnpm
check:legal` scans the published documents under `locales/*/legal/`, **not** this
record, so this list is maintained here by hand:

| Value                                          | Used in       |
| ---------------------------------------------- | ------------- |
| `[COMPANY LEGAL NAME]`                         | Sections 1, 9 |
| `[REGISTERED ADDRESS]`                         | Section 1     |
| `[COMPANY REGISTRATION NUMBER / GEMI]`         | Section 1     |
| `[VAT NUMBER]`                                 | Section 1     |
| `[CONTACT EMAIL]` / `[DPO EMAIL]`              | Section 1     |
| `[NAME(S)]` (legal representative)             | Section 1     |
| `[Hetzner Online GmbH]`, `[Germany / Finland]` | Section 6     |
| `[Cloudflare, Inc.]`                           | Section 6     |
| `[Stripe Payments Europe, Ltd.]`               | Sections 6, 9 |
| `[Resend / your SMTP provider]`, `[Region]`    | Section 6     |
| `[RETENTION PERIOD — …]` (5 periods)           | Section 7     |

Until they are filled in, this record is **not complete** for the purposes of
Article 30(2)(a).

## 1. The processor

| Item                      | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| Legal name                | `[COMPANY LEGAL NAME]` (product: **Libriant**)             |
| Registered address        | `[REGISTERED ADDRESS]`                                     |
| Company register / GEMI   | `[COMPANY REGISTRATION NUMBER / GEMI]`                     |
| VAT number                | `[VAT NUMBER]`                                             |
| Legal representative      | `[NAME(S)]`                                                |
| General contact           | `[CONTACT EMAIL]`                                          |
| Data Protection Officer   | `[DPO EMAIL]` — see Section 10 on whether one is appointed |
| Article 27 representative | Not required: the processor is established in the EU       |

We have no joint-controller arrangements (Article 26) for any activity in
Section 3.

## 2. The controllers we act for

Each customer library is a separate controller. They are not listed by name
here, because the list changes; the authoritative source is the control plane's
`tenants` table, from which a named list is produced on request by a supervisory
authority, carrying per controller: legal name, library type, postal address,
contact address, start date and — if ended — end date.

**Categories of controller** (the `library_type` chosen at signup):

| Category    | Typical example                           | What makes it different                             |
| ----------- | ----------------------------------------- | --------------------------------------------------- |
| `public`    | Municipal / public library                | Public body; DPO mandatory for them (Art. 37(1)(a)) |
| `school`    | School library                            | **Children's** data as a matter of course           |
| `academic`  | University / academic library             | Usually a public body                               |
| `special`   | Institutional, hospital or museum library | —                                                   |
| `community` | Community / association library           | —                                                   |
| `other`     | Anything else                             | —                                                   |

**The Article 30(5) exemption does not apply.** The processing is not occasional
(it is continuous, daily and automated), it regularly involves children's data
(school and municipal libraries), and it is large-scale relative to the size of
the entity. Any one of the three limbs is enough to remove the exemption.

## 3. Categories of processing carried out for each controller

Article 30(2)(b). Every row is an operation the product performs today.

| #   | Category of processing        | What the system does                                                                                   | Personal data touched      |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------- |
| 1   | Hosting and storage           | **One separate database per library** on EU infrastructure                                             | All of the below           |
| 2   | Member registry management    | Create, update, archive and erase member records                                                       | Section 4.1                |
| 3   | Circulation                   | Loans, returns, renewals, reservations, hold queues and pickup expiry                                  | Section 4.2                |
| 4   | Fines                         | Automatic overdue accrual (hourly job), payment recording, waiver                                      | Section 4.2                |
| 5   | Search and indexing           | Accent- and case-folded composite search field built from name + email + member number + phone         | Section 4.1                |
| 6   | Bulk import                   | CSV/XLSX import of members and holdings uploaded by the library                                        | Section 4.1                |
| 7   | Data export                   | Full copy of the library's database as CSV/JSON/XLSX/SQL, on the library's own request (Art. 20)       | All                        |
| 8   | Member e-mail notifications   | Due-soon, overdue and hold-ready reminders — **per-library opt-in, default OFF**                       | Name, e-mail, loan details |
| 9   | Custom fields and collections | Fields and records the library defines itself; it chooses their content                                | Section 4.3                |
| 10  | Audit logging                 | Per-library `audit_log` with before/after snapshots of changes                                         | Sections 4.1–4.3           |
| 11  | Backup and restore            | Encrypted backups with restore testing                                                                 | All                        |
| 12  | Support access                | Time-boxed staff access after a one-time key the library issues (DPA §6.2)                             | All, fully logged          |
| 13  | Administrative export         | Export initiated by Libriant; for a single library it requires an open support session (DPA §6.3)      | All, fully logged          |
| 14  | Deletion and erasure          | Member erasure (Art. 17) overwriting every identifier; deletion/return of data on termination (DPA §8) | Section 4.1                |

No processing of Library Data is carried out for our own purposes: no
advertising, no profiling, no model training, no usage analytics over member
data. No automated decision-making produces legal or similarly significant
effects (Art. 22).

## 4. Categories of data subject and of personal data

### 4.1 Members / patrons (including **minors**)

Fields held in each library's `members` table:

- Identifiers: member number, full name, sort name, composite search field
- Contact: e-mail, phone, address line 1 and 2, city, postal code, country
- **Date of birth** (optional column — the library decides whether to fill it)
- **Member photo** (optional, stored as a file)
- Member status, join date
- **Staff notes** (free text, visible to library staff only)
- **Custom fields** defined by the library (free-form JSON)

### 4.2 Circulation history of the same people

Loans (loaned, due, returned dates, renewals), reservations (queue position,
availability, pickup expiry), fines (amount in integer currency subunits, reason,
payment, waiver) and the related audit entries.

### 4.3 Data the library enters freely

Staff notes, custom fields and custom collections accept whatever content the
library chooses. **Special-category data (Art. 9) is not required by the Service
and is not expected.** DPA §3.2 obliges the library not to enter it without a
lawful basis and without informing us. We have no technical means of detecting
it.

### 4.4 Library staff and volunteers

Staff accounts (name, e-mail, role, password hash, sign-in timestamps) live in
Libriant's **control plane**, not in the library's database. For those Libriant
is a **controller** — see Section 9 and Section 1 of the Privacy Policy.

## 5. Children

School libraries are an explicit customer category and date of birth is a stored
column, so processing children's data is expected rather than incidental.

- The **library** is the controller of that data and carries the lawful basis,
  any parental consent, and the notice to data subjects (DPA §3.2).
- The product **does not currently branch on age**: there is no guardian contact
  field, no consent flag, no reduced retention period, and no restriction on
  sending automated e-mail to a minor's address. Member notifications are OFF by
  default, which limits — but does not remove — the exposure.
- This gap is recorded (finding privacy-legal-12) and **must be disclosed to
  every school and municipal library before signature**, so they can weigh it in
  their own impact assessment.

## 6. Recipients and sub-processors

Article 30(2)(a) and (c). The published list is at
[`/legal/subprocessors`](../../locales/en/legal/subprocessors.md).

| Recipient                        | Role                                       | Data                                                | Location / transfer safeguard                 |
| -------------------------------- | ------------------------------------------ | --------------------------------------------------- | --------------------------------------------- |
| `[Hetzner Online GmbH]`          | Hosting for app, databases, files, backups | All Library Data                                    | EU (`[Germany / Finland]`) — within the EEA   |
| `[Cloudflare, Inc.]`             | Edge network, TLS, DDoS/WAF protection     | Network metadata, IP addresses, requests in transit | Global edge; EU SCCs and localisation options |
| `[Stripe Payments Europe, Ltd.]` | Subscription payment processing            | **Library billing data only** — never member data   | EU/Ireland; SCCs for any onward transfer      |
| `[Resend / your SMTP provider]`  | Transactional e-mail delivery              | Recipient address and message content               | `[Region]`; SCCs where applicable             |

**Notes that change the picture:**

- The e-mail provider **receives no data today**: the service runs with
  `EMAIL_DRIVER=console`, so messages are logged and never sent. That row goes
  live the day a real provider is configured.
- The payment provider is engaged only when subscriptions are enabled and a
  library initiates a payment. It never receives member data.
- **We use no analytics, advertising, or tracking providers.**
- Other recipients: professional advisers under confidentiality; authorities
  where legally compelled; and a successor in a merger/acquisition, with notice.

**Third-country transfers:** Library Data stays within the EU/EEA. The only flow
that leaves the EEA is network metadata at the edge network, under Standard
Contractual Clauses with supplementary measures.

## 7. Retention periods

This section deliberately separates **what code enforces** from **what has not
been agreed yet**. A record that states periods no system applies is worse than
no record.

### 7.1 Enforced today, automatically

| Data                        | Period                                            | Enforced by                                |
| --------------------------- | ------------------------------------------------- | ------------------------------------------ |
| Marketing-site applications | 12 months (except those that became partnerships) | `retention-sweep` job, daily               |
| Library `audit_log`         | The plan's period (7/90/365/1095/3650 days)       | `retention-sweep` job, daily               |
| Export artifacts            | 24 hours (2 hours for a platform-wide export)     | `export-file-cleanup` job, hourly          |
| Upload temp files           | 30 minutes of staleness                           | `storage-temp-cleanup` job, hourly         |
| Backups                     | 14 days, rolling                                  | `scripts/backup.sh` (`BACKUP_KEEP_DAYS`)   |
| Support sessions            | Expire after 4 hours; keys after 60 minutes       | `support-session-expiry` job, every minute |

**Note the configuration actually shipped:** with subscriptions **disabled** —
the configuration the product ships with — the per-plan `audit_log` retention
resolves to "unlimited" and the sweep **deletes nothing** from the audit log.
Retention is lifted, not zero. This must be stated to any library that asks.

### 7.2 Not yet determined — needs counsel

The following periods are blank in Section 6 of the Privacy Policy. None is
enforced by code today, and choosing values here would put a deletion schedule
into production that nobody agreed to:

- `[RETENTION PERIOD — CONTROL-PLANE AUDIT LOG]`
- `[RETENTION PERIOD — SUPPORT LOGS]` (`support_action_log`, sessions,
  redemption attempts — these hold IP addresses and record snapshots)
- `[RETENTION PERIOD — EMAIL OUTBOX]` (envelope and message body)
- `[RETENTION PERIOD — SECURITY LOGS]` (Privacy Policy §6: "a limited period,
  e.g. 90 days")
- `[RETENTION PERIOD — legalAcceptedIp]` (the IP recorded at legal acceptance)

On termination, Library Data is returned or deleted within `[30]` days (DPA §8),
with residual copies ageing out on the backup rotation.

## 8. General description of the Article 32(1) measures

Article 30(2)(d). Full text: DPA §6.

- **Isolation:** one physical database per library — not a shared table with an
  owner column. The tenant resolver picks the database per request.
- **Encryption:** TLS on every transfer; encrypted backups with regular restore
  testing in a disaster-recovery drill; encryption at rest of MFA secrets and
  integration credentials.
- **Authentication:** bcrypt password hashing; mandatory MFA for every platform
  administrator; account lockout after failed attempts; the ability to invalidate
  all live sessions.
- **Authorisation:** role-based access control within each library; a separate
  role tier for platform staff; support access requires a key the library itself
  issues and explicitly forbids minting credentials, changing billing, and
  revoking the library's own controls.
- **Accountability:** per-library audit log, visible to the library; a separate
  control-plane audit log for every platform-staff action; every support-session
  request logged with before/after snapshots.
- **Resilience:** rate limiting on unauthenticated edges; admission control on
  new-library provisioning; size and time bounds on every bulk job; a
  disaster-recovery drill that verifies restore.
- **Minimisation:** platform exports redact sensitive columns; credential-bearing
  links are not stored in cleartext in the e-mail queue; member erasure overwrites
  identifiers in the audit log too.

## 9. Processing where Libriant is the controller (Article 30(1))

Separate from the record above, kept here for completeness. Full description:
[Privacy Policy](../../locales/en/legal/privacy.md).

| Data                                              | Purpose                           | Lawful basis (Art. 6)                       |
| ------------------------------------------------- | --------------------------------- | ------------------------------------------- |
| Library staff accounts                            | Operate the account, authenticate | Contract 6(1)(b)                            |
| Credentials (bcrypt hash, MFA secrets)            | Sign-in security                  | Contract; legitimate interests 6(1)(f)      |
| Billing data and invoices                         | Subscriptions, tax obligations    | Contract; legal obligation 6(1)(c)          |
| Operation and security logs (IP, timestamps)      | Operate, secure, prevent abuse    | Legitimate interests 6(1)(f)                |
| Legal acceptance (version, time, IP, text digest) | Demonstrate what was agreed       | Accountability 5(2); legitimate interests   |
| Marketing-site applications                       | Respond to interested libraries   | Legitimate interests; pre-contractual steps |

## 10. Open items to close before the first real library

1. **Register the company and have counsel review** — Section 0
   (privacy-legal-01).
2. **Decide on a DPO.** Article 37(1)(b) is not automatically triggered for the
   processor, but the core activity is regular and systematic processing of
   member data including children's. A decision and its reasoning are needed;
   until then `[DPO EMAIL]` must not be published as a DPO contact.
3. **Fill in the five retention periods** in Section 7.2 and implement them in
   the `retention-sweep` job.
4. **Article 35 impact assessment.** DPA §4(e) promises assistance. Given
   children's data and the scale, a public-body library will ask for material
   that does not exist yet.
5. **Disclose the minors gap** (Section 5) to every school and municipal library
   before signature.

## Revision history

| Version | Date       | Change                                                            |
| ------- | ---------- | ----------------------------------------------------------------- |
| 1       | 2026-08-26 | First draft — finding privacy-legal-08 (the record did not exist) |
