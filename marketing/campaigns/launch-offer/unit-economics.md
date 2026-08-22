# Unit economics — how many free years can Libriant afford?

**Rebuilt 2026-08-21 with current data.** An earlier estimate in conversation used
pre-June-2026 Hetzner prices and omitted Greek statutory costs entirely. Both
errors pushed the answer in the same direction — too optimistic. This is the
corrected version, deliberately pessimistic.

---

## 1. What changed since the first estimate

**Hetzner raised prices on 15 June 2026.** DRAM is up ~171% year-on-year on AI
demand, and NVMe followed. The increase was not uniform, and the line the
deployment runbook specced was among the worst hit:

| Instance                         | Now (ex-VAT)  | Notes                                                         |
| -------------------------------- | ------------- | ------------------------------------------------------------- |
| **CPX32** (4 vCPU, 8 GB)         | **€35.49/mo** | what `docs/deployment-hetzner.md` specs — CPX rose ~2.4–2.75× |
| **CX43** (8 vCPU, 16 GB, 160 GB) | **€15.99/mo** | more machine, less than half the price                        |
| CAX31 (ARM, 8 vCPU, 16 GB)       | €20.99/mo     |                                                               |
| AX42-1 dedicated                 | €97.30/mo     |                                                               |

> **Action, independent of the voucher question: do not re-order a CPX32.** The
> CX line rose only ~30% while CPX rose ~140%. A **CX43 costs €19.50/month less
> than a CPX32 and gives twice the vCPU and RAM.** That is €234/year saved for a
> strictly better machine. Update the runbook before rebuilding.

**Hetzner VAT:** billed at German VAT until a valid Greek ΑΦΜ + VIES registration
is on file, after which it reverse-charges to €0. Unregistered, add 19%.

## 2. Cost base, year 1

### Infrastructure — Libriant's share

|                      | Cloud (CX43) | Dedicated (AX42-1, 50% share) |
| -------------------- | ------------ | ----------------------------- |
| Server               | €192         | €584                          |
| Storage Box, backups | €54          | €54                           |
| Domain               | €12          | €12                           |
| **Total**            | **€258**     | **€650**                      |

Cloudflare is DNS + proxy only on the free tier — no Workers, no D1 — and
iCloud mail is already paid for. Infrastructure is
**not** the constraint — a 30,000-title tenant database is a few hundred MB, and
twenty libraries on one box is nothing.

### Statutory — the cost the first estimate missed entirely

Greece charges you for _existing_ as a business, before a single euro of revenue:

|                                       | Monthly | Annual     |
| ------------------------------------- | ------- | ---------- |
| ΕΦΚΑ, νέος επαγγελματίας reduced rate | €150.46 | **€1,806** |
| ΕΦΚΑ, 1st category standard           | €250.77 | **€3,009** |
| Accountant (ατομική επιχείρηση)       | €50–80  | €600–960   |
| ΓΕΜΗ and sundries                     |         | ~€100      |

**Statutory floor: €2,500–4,070/year.** That is **four to fifteen times the
server cost.** Any analysis that talks about €/month of hosting and not about
ΕΦΚΑ is answering the wrong question.

**Whether this counts against Libriant is the single biggest variable in this
document** — see §5.

### Total cash cost, year 1

|                | Low        | High       |
| -------------- | ---------- | ---------- |
| Infrastructure | €258       | €650       |
| Statutory      | €2,500     | €4,070     |
| **Total**      | **€2,763** | **€4,719** |

### Time — the constraint that never appears on an invoice

Per library, year one: catalogue migration 2–8h (you promised to do it), setup
and training ~2h, support ~1h/month. **≈ 18 hours per library.**

A free voucher therefore costs roughly **€360 of your time** at €20/h — an order
of magnitude more than the server it runs on.

## 3. Revenue per customer — the assumption that decides everything

**Repriced 2026-08-22** against 76 real contract awards published on ΔΙΑΥΓΕΙΑ.
The median Greek library pays about **€900/yr** for openABEKT; the most common
contract is **€500/yr**; the range is €300–€1,700. The old ladder priced the
entry tier at €228/yr — below the cheapest contract in the entire dataset.

Plans (annual, ten months for twelve): Starter free (5k titles) · Community €390
(20k) · Municipal €790 (60k) · Central €1,190 (150k) · Institutional €1,890
(400k).

Greek δημοτικές typically hold 10,000–50,000 volumes, which points at Municipal —
and 60,000 titles now covers the median Greek public library, where the old
30,000 cap did not. But **ABEKT is free and state-backed**, so a library already
on it needs a positive reason to start paying, and the ones easiest to win are
the small ones on Excel or paper.

| Mix             | Starter | €390 | €790 | €1,190 | €1,890 | Avg/customer/yr |
| --------------- | ------- | ---- | ---- | ------ | ------ | --------------- |
| **Pessimistic** | 30%     | 50%  | 16%  | 3%     | 1%     | **€376**        |
| **Central**     | 15%     | 38%  | 32%  | 11%    | 4%     | **€608**        |
| Optimistic      | 10%     | 25%  | 40%  | 18%    | 7%     | €760            |

## 4. Pipeline — pessimistic, as asked

277 sendable addresses (distinct mailboxes, after removing personal mailboxes,
general inboxes and shared-mailbox duplicates — see `check-sendable.py`). Cold
email to Greek **public institutions**, from an
unknown vendor, with a months-long decision cycle:

|                 | Reply | → Apply | → Active yr 1 |
| --------------- | ----- | ------- | ------------- |
| **Pessimistic** | 3%    | 2%      | **4**         |
| **Central**     | 6%    | 3.5%    | **7**         |
| Optimistic      | 12%   | 7%      | **14**        |

(applications × ~70% completing onboarding)

The earlier conversational figure of ~20 active was the optimistic case treated
as central. Correcting that.

## 5. The answer

**Break-even = total cost ÷ revenue per paying customer.**

| Scenario                                  | Cost     | €/customer | Paying customers needed |
| ----------------------------------------- | -------- | ---------- | ----------------------- |
| Libriant carries full statutory load      | €4,719   | €376       | **13**                  |
| Libriant carries full statutory load      | €4,719   | €608       | **8**                   |
| Libriant carries full statutory load      | €2,763   | €608       | **5**                   |
| **Statutory shared / already registered** | **€650** | €376       | **2**                   |
| **Statutory shared / already registered** | **€258** | €608       | **1**                   |

Against a central pipeline of **7 active libraries in year one**, that produces
two completely different answers:

### If Libriant is the reason you register → **2–3 free vouchers**

You need most of your first-year pipeline to be paying just to cover ΕΦΚΑ and the
accountant. Ten free would mean **€0 revenue against ~€3,500 of cash cost and 180
unpaid hours.**

### If you would register anyway, or other projects share the load → **5 free vouchers**

Libriant's attributable cost falls to €258–650, break-even is 1–2 paying
customers, and five vouchers against an 8-customer pipeline is a defensible acquisition
cost — roughly 60% of year one spent buying the references that make year two
work. It is the top of the sane range, not the middle.

### In both cases: not 10.

Ten is more than twice the pessimistic pipeline and more than the entire central
one — you would be promising vouchers to libraries that will not exist. There is no
cost model in which giving away your entire first year is the right call for a
solo founder who is also still building the product.

## 6. Recommendation

**Open at 5. Say publicly that it is 5.**

- Five is enough for references: one Athens, one Thessaloniki, one island, one
  regional, one school answers «ποιος άλλος το χρησιμοποιεί;» completely.
- **Vouchers are one-way.** You can announce a second round if demand is strong;
  you cannot withdraw a promise already made. Start low and let the first wave
  turn the conversion rate from a benchmark into a measurement.
- «5 θέσεις» is scarcer than «10 θέσεις», so it should convert better.
- Five costs ~90 unpaid hours instead of ~180.

If you want a bigger headline number, use a ladder rather than a giveaway:

> **Οι 5 πρώτες:** πρώτος χρόνος δωρεάν
> **Οι επόμενες 10:** πρώτος χρόνος −50%

Same hook, revenue from libraries 6–15, and a second reason to email the list.

## 7. Risks this model does not price

- **ABEKT is free.** The strongest competitor costs nothing and is state-backed.
  Assume every library already on it is hard to convert; target Excel/paper first.
- **Greek public bodies pay late.** Invoices to a municipality routinely settle in
  3–12 months. Revenue booked in year one may be cash in year two. Do not spend
  it in advance.
- **Public bodies pay by treasury transfer, not card.** Stripe will barely be used
  for this segment; expect to issue τιμολόγια and chase them by hand.
- **Year one loses money in almost every scenario.** That is normal and not an
  argument against proceeding — but it means the question is not "does year one
  profit" but "can you fund year one until year two pays". Answer that before
  sending.
- **Conversion of free → paid.** High-touch onboarding with migrated data creates
  real switching cost, so 50–70% is plausible — but it is an assumption, not
  evidence, until the first cohort renews.

---

_Sources: Hetzner price adjustment 15 June 2026 (docs.hetzner.com); current
Hetzner cloud pricing (Aug 2026); ΕΦΚΑ 2026 contribution tables (ΦΕΚ Β΄318/
29-1-2026, +2.5% from 1.1.2026); Greek sole-trader income tax scale 2026; Greek
small-business VAT exemption threshold €10,000. Figures are ex-VAT unless stated.
Not accounting or tax advice — confirm with a λογιστής before acting._
