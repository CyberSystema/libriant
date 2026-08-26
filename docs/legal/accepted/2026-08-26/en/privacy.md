# Privacy Policy

**Last updated: 2026-08-26**

This Privacy Policy explains how `[COMPANY LEGAL NAME]` ("**Libriant**",
"**we**") handles personal data in connection with the Libriant service (the
"**Service**"). It is written to meet the EU General Data Protection Regulation
(**GDPR**) and Greek data-protection law (Law 4624/2019).

## 1. Two different roles

Libriant processes personal data in **two distinct capacities**:

- **As a processor, on behalf of a Library.** When a library uses Libriant to
  manage its catalogue, members, and circulation, the **library is the data
  controller** and Libriant is its **processor**. This includes data about the
  library's **members/patrons** (and any minors among them). How we process that
  data is governed by our [Data Processing Agreement](/legal/dpa) and the
  library's instructions — **not** by this Policy. If you are a library member,
  please contact your library for its own privacy notice and to exercise your
  rights; we will assist the library as required.

- **As a controller, for our own purposes.** For the data we decide the purposes
  and means of — your **account and staff-user data**, **billing data**, and
  **service operation/security logs** — Libriant is the **controller**. This
  Policy covers that processing.

## 2. The controller and contact details

Controller: `[COMPANY LEGAL NAME]`, `[REGISTERED ADDRESS]`.
General contact: `[CONTACT EMAIL]`. Data-protection contact / DPO (if appointed):
`[DPO EMAIL]`. See the [Legal Notice](/legal/legal-notice).

## 3. What we process as controller, why, and on what basis

| Data                                                                                                              | Purpose                                                                  | Lawful basis (GDPR Art. 6)                                        |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Account identity (name, email, library/role)                                                                      | Create and operate your account; authenticate you                        | Contract (6(1)(b))                                                |
| Credentials (password **stored only as a bcrypt hash**; admin TOTP secrets stored encrypted)                      | Secure sign-in and two-factor authentication                             | Contract; legitimate interests (6(1)(f)) in account security      |
| Billing data (billing name/email, plan, invoices; card data handled by Stripe — we never store full card numbers) | Process subscriptions and payments; tax/accounting                       | Contract; legal obligation (6(1)(c)) for invoicing/tax            |
| Usage & security logs (IP address, timestamps, actions, audit log of sensitive admin/billing actions)             | Operate, secure, debug, and prevent abuse of the Service; accountability | Legitimate interests (6(1)(f)); legal obligation where applicable |
| Support communications                                                                                            | Respond to your requests                                                 | Contract; legitimate interests                                    |
| Email delivery metadata (e.g. delivery status)                                                                    | Send transactional emails (verification, password reset, notices)        | Contract; legitimate interests                                    |

We do **not** use your data for advertising, and we do **not** sell personal
data. We do not use cookies for tracking or analytics — see the
[Cookie Policy](/legal/cookies).

## 4. Where the data is processed and stored

The Service is hosted in the **European Union** (`[Hetzner, Germany/Finland]`).
We use a small number of carefully selected sub-processors (hosting, edge/CDN,
payments, email) listed in [Sub-processors](/legal/subprocessors). Where a
sub-processor processes data outside the EEA, we rely on an adequacy decision or
EU Standard Contractual Clauses with appropriate supplementary measures.

## 5. How we protect data

We apply technical and organisational measures appropriate to the risk,
including: encryption in transit (TLS); **isolation of each library's data in a
separate database**; password hashing (bcrypt) and encryption of MFA secrets at
rest; mandatory multi-factor authentication for platform administrators;
role-based access control and least-privilege internal access; audit logging of
sensitive actions; rate limiting and abuse protections; and regular backups with
restore testing. No system is perfectly secure, but we work to protect your data
and to detect and respond to incidents.

## 6. How long we keep data

- **Account & Library Data:** kept while your account is active. After
  termination we make data available for export for `[30]` days, then delete it
  (see the [Terms](/legal/terms) and DPA).
- **Backups:** rotated on a rolling `[14]`-day cycle, after which deleted copies
  age out of backups.
- **Billing/tax records:** retained for the period required by law (in Greece,
  typically `[up to 5–10]` years).
- **Security logs:** retained for `[a limited period, e.g. 90 days]` unless
  needed longer for an investigation.

## 7. Your rights

If we are the controller of your data, you have the right to: **access** a copy;
**rectify** inaccuracies; **erase** ("right to be forgotten"); **restrict** or
**object** to processing; **data portability**; and to **withdraw consent** where
processing is based on consent (without affecting prior processing). You also
have the right to **lodge a complaint** with a supervisory authority — in Greece,
the Hellenic Data Protection Authority (HDPA / Αρχή Προστασίας Δεδομένων
Προσωπικού Χαρακτήρα, [dpa.gr](https://www.dpa.gr)) — or the authority in your
country of residence.

To exercise these rights, contact `[CONTACT EMAIL]` / `[DPO EMAIL]`. We will
respond within one month (extendable by two months for complex requests). We may
need to verify your identity. **If your request concerns data a library holds
about you as a member, please contact that library (the controller); we will
support them in responding.**

## 8. Automated decision-making

We do **not** carry out automated decision-making that produces legal or
similarly significant effects about you (GDPR Art. 22).

## 9. Children

The Service is a tool for libraries (B2B) and is not directed at children. A
library may hold data about minor members; for that data the **library is the
controller** and is responsible for the lawful basis (including any parental
consent) under the GDPR and Greek law. Libriant processes such data only on the
library's instructions.

## 10. Sharing your data

We share data only with: our **sub-processors** (Section 4 and the dedicated
page); **professional advisers** under confidentiality; **authorities** where
legally required; and a **successor** in a merger/acquisition (with notice). We
do not otherwise disclose personal data.

**Access by Libriant staff.** Our own staff have no standing access to a
library's data. Access happens only through a time-limited support window that
the library itself opens with a one-time key, or through a database export
which — for a single named library — requires such a window. Both are recorded
in the library's own audit log and notified to it by e-mail. The mechanism, its
limits, what is logged and for how long are set out in Section 6 of the
[Data Processing Agreement](/legal/dpa). If you are a library member, the
library — not Libriant — is the controller of your data; ask your library for
its own notice.

## 11. Changes to this Policy

We may update this Policy; material changes will be notified by email or in-app
and the "Last updated" date will change.

## 12. Contact

`[COMPANY LEGAL NAME]` — `[REGISTERED ADDRESS]` — `[CONTACT EMAIL]` —
DPO: `[DPO EMAIL]`.
