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
> ολοκληρωμένο και σε λειτουργία· πέρασε πλήρη έλεγχο ασφαλείας πριν διατεθεί.
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

Once they say yes, this is the whole runbook. **No code changes are needed** to
honour the free year.

1. **Create the tenant**
   ```bash
   pnpm tenant:create
   ```
2. **Assign the plan.** In the admin UI → Tenants → _their library_ → billing:
   set the plan to **Municipal**, `billingMode = manual`, and **paid-until** to
   **today + 12 months**.

   That is the entire mechanism. `apps/api/src/plans/effective-plan.service.ts`
   gates manual subscriptions on `paidUntil > NOW()`, so the free year expires by
   itself with no cron, no reminder, and no risk of accidentally charging anyone.

3. **Send credentials** and a short "here's how to start" note.
4. **Run their import yourself.** Ask for whatever they have — CSV, Excel, MARC,
   a messy spreadsheet — and do it for them. This is the promise that makes the
   offer real, and it's where you'll learn the most about the product.
5. **Decrement `offer.spotsRemaining`** in `apps/site/site.config.json` and
   redeploy the site.
6. **Log it** in `prospects.csv` with the date.

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
