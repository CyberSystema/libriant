# Reply playbook

Every reply gets answered within one working day — the email promises two, so one
gives you margin. Answer **everyone**, including the no's; a courteous no today is
a warm lead in eighteen months when their current system breaks.

---

## A. "Ναι, μας ενδιαφέρει"

> Θέμα: Re: Μια πρόταση για τη Βιβλιοθήκη {Όνομα}
>
> Χαίρομαι που το βλέπετε θετικά.
>
> Το επόμενο βήμα είναι μια σύντομη κουβέντα, 20 λεπτά, για να δω τι έχετε σήμερα
> και πώς θα το μεταφέρουμε. Δεν χρειάζεται να ετοιμάσετε τίποτα.
>
> Βολεύει κάποια μέρα μέσα στην εβδομάδα; Πείτε μου δύο-τρεις ώρες που σας
> ταιριάζουν και προσαρμόζομαι.
>
> Αν προτιμάτε να δείτε πρώτα το σύστημα μόνοι σας, μπορώ να σας στείλω
> πρόσβαση σε μια δοκιμαστική βιβλιοθήκη σήμερα.

**Why the call:** for a founding partner you need to hear how they actually work
before provisioning. It also surfaces the real decision-maker early — in a
municipal library the person replying often isn't the one who signs off.

## B. "Ενδιαφερόμαστε, αλλά…" (questions, hesitation)

Answer the question directly, then reduce the commitment. The most common ones:

**«Τι γίνεται με τα δεδομένα μας;»**

> Είναι δικά σας, πάντα. Τα κατεβάζετε ολόκληρα σε ανοικτή μορφή, όποτε θέλετε,
> μέσα από την εφαρμογή και χωρίς να με ρωτήσετε. Πριν καταχωρίσετε το πρώτο
> μέλος υπογράφουμε Σύμβαση Επεξεργασίας Δεδομένων που το κατοχυρώνει.

**«Θα μας χρεώσετε στο τέλος του χρόνου;»**

> Όχι, ποτέ αυτόματα. Δεν υπάρχει κάρτα στο σύστημα, άρα δεν υπάρχει τίποτα να
> χρεωθεί. Έναν μήνα πριν από τη λήξη θα επικοινωνήσω και θα αποφασίσετε: ή
> συνεχίζετε με μόνιμη έκπτωση ιδρυτικού μέλους, ή κατεβάζετε τα δεδομένα σας
> και φεύγετε. Αν δεν μου απαντήσετε καθόλου, ο λογαριασμός απλώς παύει να
> είναι ενεργός.

**«Χρησιμοποιούμε ήδη ABEKT / κάτι άλλο.»**

> Τότε έχετε ήδη λύσει το δύσκολο κομμάτι, που είναι η καταλογογράφηση — και η
> μεταφορά γίνεται εύκολα. Προτείνω να το δείτε παράλληλα, με ένα αντίγραφο του
> καταλόγου σας, χωρίς να αλλάξει τίποτα στη ροή σας. Την εισαγωγή την
> αναλαμβάνω εγώ και δεν σας κοστίζει καθόλου χρόνο.

**«Δεν έχουμε χρόνο τώρα.»**

> Το καταλαβαίνω. Κρατάω μια θέση για εσάς μέχρι τον {μήνας}. Αν ως τότε δεν
> προλάβετε, δεν πειράζει — θα επανέλθω του χρόνου.

**«Ποιος είστε;»** — answer plainly and from strength:

> Είμαι ο {όνομα}, από την {πόλη}, και αναπτύσσω το Libriant. Το σύστημα είναι
> ολοκληρωμένο και σε λειτουργία· πέρασε συστηματικό εσωτερικό έλεγχο ασφάλειας
> και αξιοπιστίας πριν διατεθεί (εσωτερικό, όχι πιστοποίηση από ανεξάρτητο φορέα).
> Η προσφορά του πρώτου χρόνου είναι προσφορά έναρξης για τις πέντε πρώτες
> βιβλιοθήκες — προτιμώ να ξεκινήσω με λίγες συνεργασίες που θα τις προσέξω
> πραγματικά, παρά με πολλές που θα τις αφήσω μόνες τους.

## C. "Όχι, ευχαριστούμε"

> Σας ευχαριστώ για την απάντησή σας — τη σέβομαι απόλυτα.
>
> Αν αλλάξει κάτι στο μέλλον, θα χαρώ να τα ξαναπούμε. Δεν θα σας ξαναγράψω
> στο μεταξύ.

Then **actually don't**. Add them to `suppression.csv`. A library that said no
politely and never heard from you again is someone who will take your call in two
years.

## D. «ΔΙΑΓΡΑΦΗ»

No reply text needed beyond a one-line acknowledgement. Add to
`suppression.csv` **the same day** and never contact that address again.

---

## Provisioning an accepted library

Once they say yes, this is the whole runbook. It is written against the code
that exists on 2026-08-25; where the code cannot do something, this says so
instead of describing it anyway.

**Read this first, before you promise anyone a start date.** Two things about
the founding offer are not what you would guess:

1. **`billingMode` can only be set when the tenant is created.** There is no
   endpoint and no screen that sets it afterwards. Every write to
   `subscriptions.billingMode` in the API copies it from the chosen _plan_
   (`billing.service.ts:337`, `:738`, `:1138`; `auth/signup.service.ts:181`),
   and the only plan whose mode is `manual` is `on-prem-enterprise`. So the free
   year is configured by `pnpm tenant:create`, which takes `--billing-mode`
   directly — **or it is not configured at all.**
2. **Nothing anywhere watches `paidUntil`.** No scheduled job
   (`apps/api/src/jobs/registry.ts` has ten; none is about billing terms), no
   email, no admin list of expiring terms. The one-month-ahead contact the
   published terms promise is kept by you, in a calendar, or it is not kept.

### 1. Create the tenant, with the billing terms, in one command

This is the step that carries the offer. Run it from the operator shell
(RUNBOOK §6.4); the flags are listed in RUNBOOK §6.6.

```bash
# NOTE: no `--` before the flags. pnpm forwards it to the script, node's
# parseArgs treats it as the positional terminator, and EVERY flag after it
# is discarded — the run exits 1 with "missing required flag(s)". Since this
# is the only way to set billingMode, the `--` form stops the founding-offer
# procedure at step 1. Verified on pnpm 9.15.4 and on 11.22.0, the pinned one.
dc run --rm --no-deps migrate sh -lc "cd /app && pnpm tenant:create \
  --slug=<their-slug> \
  --name='<Their Library>' \
  --owner-email=<their address> \
  --owner-name='<their librarian>' \
  --plan=municipal \
  --billing-mode=manual \
  --paid-until=<today + 12 months, YYYY-MM-DD> \
  --owner-password='<a long one you generate>' \
  --default-locale=el \
  --dry-run"
```

Run it with `--dry-run` first — it validates the slug, plan, cell and date and
provisions nothing. Then run it again without the flag. The generated owner
password prints **once**; `--owner-password` lets you set one you can hand over
on the call instead of copying it out of a terminal.

> **This command cannot run on the production box today.** RUNBOOK §6.4 records
> that `pnpm` exits 1 inside the `migrate` image (`supply-chain-06`), and that
> container is the only place on the host with Node. Check it before the call,
> not after:
> `dc run --rm --no-deps migrate sh -lc 'pnpm --version'` → expect `11.22.0`.
> There is no second way to set `billingMode`, so until that works the founding
> offer cannot be provisioned on the server at all.

> **Set `--owner-password` and hand it over out of band.** `EMAIL_DRIVER=console`
> means no verification mail is delivered, and `EmailVerifiedGuard` sits on
> `POST /t/:slug/staff` — so the owner is the only user that library can have
> until that is fixed (RUNBOOK §6.6). Say so on the call; a library expecting to
> add three colleagues on day one should hear it from you first.

### 2. Check what you actually created

```bash
dc exec -T postgres psql -U libriant -d libriant_control -c \
  "SELECT t.slug, p.slug AS plan, s.\"billingMode\", s.status, s.\"paidUntil\"
     FROM subscriptions s
     JOIN tenants t ON t.id = s.\"tenantId\"
     JOIN plans  p ON p.id = s.\"planId\"
    WHERE t.slug = '<their-slug>';"
```

Good looks like exactly this — anything else and the offer is not configured:

```
     slug      |   plan    | billingMode | status |      paidUntil
---------------+-----------+-------------+--------+---------------------
 their-slug    | municipal | manual      | active | 2027-08-25 00:00:00
```

### 3. Do not touch the plan dropdown afterwards

The admin UI (Tenants → _their library_) can do one of the two things this offer
needs and not the other.

| Control            | What it does                                                                      |
| ------------------ | --------------------------------------------------------------------------------- |
| **Set plan to…**   | Writes the plan **and overwrites `billingMode` with that plan's own mode.**       |
| **Set paid-until** | Extends the term. Shown only while the subscription is `manual`; works correctly. |

So "Set plan → Municipal" on a founding library **silently converts it from
manual to stripe** (`billing.service.ts:738`). The Set paid-until button then
disappears, and because the effective-plan resolver only enforces the deadline
for manual subscriptions (`effective-plan.service.ts:260`) the twelve-month term
stops meaning anything at all. Use the dropdown for ordinary customers; for a
founding library, never.

### 4. A library that signed itself up cannot be converted

If they went through `libriant.com` and created their own account, their
subscription was written by signup with the Starter plan's mode — `stripe`
(`auth/signup.service.ts:181`) — and **no endpoint, screen or script can move it
to manual.** The only lever is an `UPDATE` on `subscriptions` by hand, which
leaves no audit row, unlike every supported billing change.

Avoid needing it: the funnel routes through the application form and a call, so
provision them with `tenant:create` and send them credentials. If you do find
yourself reaching for the `UPDATE`, that is the signal to build the admin flag
(an explicit per-subscription billing mode, independent of the plan) rather than
to keep doing it by hand.

### 5. Never reach for On-prem / Enterprise to get manual billing

It is the only plan with `billingMode = manual`, so it is the obvious-looking
shortcut, and it is wrong twice:

- its feature values are **1,000,000,000 on every limit** — caps we never offered
  and would have to claw back at renewal; and
- its `monthlyPriceCents` is **0**, and `getDesktopAccess` refuses any plan
  priced at or below zero as `free-plan` (`billing.service.ts:288-290`). The
  desktop app is part of what the founding libraries are being given, and the
  day subscriptions are switched on they would lose it.

Municipal at `monthlyPriceCents = 7900` clears that check. That is the whole
reason the plan and the billing mode are set separately in step 1.

### 6. What the free year actually does, and does not, enforce

**Subscriptions ship OFF** (`BILLING_ENABLED=false`). While they are off,
`getEffectivePlan` returns an unlimited plan for every tenant
(`effective-plan.service.ts:144`) and desktop access is `free-for-all`
(`:280-282`). During the offer period `paidUntil` therefore gates **nothing** —
it is bookkeeping. Set it anyway: it is the record of what was promised, and it
is already correct on the day subscriptions are turned on.

Once they are on, the resolver drops the plan the instant `paidUntil` passes and
the library falls to the catalogue defaults, mid-morning, with no warning to
them and no notification to you. That is the behaviour the published terms
describe («ο λογαριασμός απλώς παύει να είναι ενεργός») — but the terms also
promise a conversation a month beforehand, and nothing in the product produces
it.

### 7. Put the three dates in your calendar. Now, not later.

At `paidUntil` minus 30 days, minus 7 days, and on the day itself. This is the
only mechanism there is:

- **−30 days** — the contact the terms promise. Continue with a founding
  discount, or export and leave.
- **−7 days** — chase if they have not answered.
- **the day** — record the outcome, and if they are continuing, extend with
  **Set paid-until** before you do anything else.

If we ever run a second cycle, build the expiry list before you send the emails,
not after.

### 8. The rest

1. **Send credentials** and a short "here's how to start" note.
2. **Run their import yourself.** Ask for whatever they have — CSV, Excel, MARC,
   a messy spreadsheet — and do it for them. This is the promise that makes the
   offer real, and it's where you'll learn the most about the product.
3. **Decrement `offer.spotsRemaining`** in `apps/site/site.config.json`, commit
   and push. The site is baked into the edge image, so this is a full CI run
   rather than the quick deploy it used to be — there is no on-box shortcut.
4. **Log it** in `prospects.csv` with the date.

## Keeping the count honest

The site says N θέσεις and the email says 5. Both have to be true.

- 5 → 0 as you accept libraries
- At 0, the site automatically swaps the form for a waiting-list message
- Don't quietly raise the number to 7 because two more good ones turned up. Open
  a **second cycle** and say so.

## What to actually learn from the pilot

You are not running this to get five customers. You are running it to find out what
breaks. Ask every founding library, at week two and month two:

- What did you try to do that you couldn't?
- What took longer than it should have?
- What did you go back to the old system for?

The third question is the important one. Write the answers down somewhere they
survive — the point of giving away five free years is the references and the
answers, not the goodwill.
