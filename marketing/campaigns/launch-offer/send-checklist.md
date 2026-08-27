# Send checklist — launch offer

Work top to bottom. Nothing below the line marked **STOP** should happen until
everything above it is done.

---

## Before anything: the whole server stack must be live

**This dependency changed, and it is a schedule change rather than a wording
change.** The campaign used to be sendable off a free Cloudflare deploy that
needed no server. Everything now runs on the Hetzner box, so the form cannot
take a single application until Caddy, the api and Postgres are all up and
verified. Plan the send around the server, not the other way round.

The email's primary CTA points at `https://libriant.com/#apply`. Sending before
that works puts every recipient on a broken page, and you get one first
impression per library.

- [ ] The server is built and the stack is deployed — `docs/deployment-hetzner.md`
- [ ] The cutover is done — `docs/cutover-three-hosts.md`
- [ ] `libriant.com` returns 200 and renders the Greek home page
- [ ] Submit a real test application yourself and confirm the row lands:
      `dc exec -T postgres psql -U libriant -d libriant_control -c 'select id, "libraryName", "createdAt" from applications order by "createdAt" desc limit 1;'`
- [ ] Submit a deliberately incomplete one and confirm the page comes back with
      your answers still in the fields — the no-JS path is easy to break unnoticed
- [ ] `libriant.com/privacy` and `/offer-terms` both load (the footer links to them)

## Sender setup

Your domain is already in good shape — iCloud Custom Email Domain is configured
with valid SPF and a published DKIM key. Two things remain:

- [ ] **Add DMARC.** `_dmarc` TXT → `v=DMARC1; p=none; rua=mailto:dmarc@libriant.com; fo=1`
      Monitor-only, changes nothing about delivery, but its presence improves how
      receiving servers score you.
- [ ] **Send from `info@libriant.com`**, not from a personal address. Set the
      display name to `Libriant` or `[Your name] — Libriant`.
- [ ] **Do not use a self-hosted MTA for this.** A brand-new domain sending its
      first-ever mail from a Hetzner IP to institutional mail servers is the
      textbook way to land in spam invisibly. Your own MTA is for transactional
      mail later, after weeks of warm-up.

## Fill in the placeholders

Both `email/el.html` and `email/el.txt` contain `[ΟΝΟΜΑ]` and `[ΠΟΛΗ]`.

- [ ] Replace `[ΟΝΟΜΑ]` — your name, in the sign-off and the footer identity line
- [ ] Replace `[ΠΟΛΗ]` — your city, in the footer identity line
- [ ] Confirm no `[` remains: `grep -n '\[' email/el.html email/el.txt`

## Build the list

Use `prospects.template.csv` as the schema.

- [ ] **Institutional addresses only** — `info@`, `library@`, `biblio@`. Never a
      named individual's mailbox. This is the single most important rule here,
      both legally and practically.
- [ ] Addresses must be **publicly published** by the library itself (their own
      website, their municipality's site). Do not scrape directories or buy lists.
- [ ] Record where you found each address and when — you may need to show it.
- [ ] Tag each row with its segment so you know which variant to use.
- [ ] Start with **30–50**. Wave one is a test of the message, not a numbers game.

## Legal posture

Greek Law 3471/2006 art. 11 and the GDPR govern unsolicited commercial email.
Targeting published institutional addresses of organisations, with clear identity
and a working opt-out, is the defensible posture — and it is what this email does.

- [ ] Sender identity is in the footer (it is, once you fill the placeholders)
- [ ] Opt-out works: **you** must actually honour `ΔΙΑΓΡΑΦΗ` replies
- [ ] Create `suppression.csv` **now**, before the first send, and commit it
- [ ] The email states why they received it and links the privacy notice — done

**I am not a lawyer and this is not legal advice.** This belongs in the same
counsel review as the legal drafts in `locales/el/legal/`.

---

## STOP — test on yourself first

- [ ] Send the finished email to **your own Gmail, Outlook.com and iCloud** addresses
- [ ] Open each on **desktop and phone**
- [ ] Check it with **images disabled** (it has no images, so it should be identical)
- [ ] Check the **plain-text part** renders — send as `multipart/alternative` with
      both `el.html` and `el.txt`, never HTML alone
- [ ] Click the CTA and confirm it lands on the live form
- [ ] Reply to it and confirm the reply reaches `info@libriant.com`
- [ ] Run it through a spam-score checker (mail-tester.com or similar) — aim ≥ 8/10
- [ ] Confirm **Greek renders correctly** in all three clients. If you see mojibake,
      the MIME `Content-Type` header is missing `charset=UTF-8` — the `<meta>` tag
      alone is not enough, many clients ignore it.

---

## Sending

- [ ] **One recipient at a time. Never BCC.** 30–50 is well inside manual range,
      individual sends convert far better on institutional B2B, and it keeps you
      out of bulk-sender territory entirely.
- [ ] Personalise the subject with the library's name (see `email/subjects.md`)
- [ ] Swap in the right segment paragraph (see `email/variants.md`)
- [ ] **Spread it over several days** — 10–15 a day. A hundred identical messages
      leaving one new domain in ten minutes looks exactly like what it looks like.
- [ ] **Tuesday–Thursday, 09:00–11:00 Greek time.** Avoid Monday morning, Friday
      afternoon, and August entirely — Greek public institutions are largely closed.
- [ ] Log the send date per row in your prospects file

## After

- [ ] Reply to every response within one working day — the email promises two
- [ ] Honour every `ΔΙΑΓΡΑΦΗ` **same day**, and add the address to `suppression.csv`
- [ ] Mark each accepted library **_Give a place_** on the admin panel's
      Applications page. That is the whole of keeping the count true: the public
      form is gated on accepted applications, so the fifth acceptance closes it
      within the minute. It was a commit, a CI run and a full deploy until
      launch-readiness-11; if you find yourself editing `site.config.json` for
      this, you are following an old copy of this list.
- [ ] Read the Applications page daily while the wave is out. It is the only
      notification there is — `EMAIL_DRIVER=console` means the "new application"
      e-mail is composed and delivered to nobody, and the sidebar's unread count
      is what tells you an application is waiting.
- [ ] **One follow-up only**, after 7–10 days, to non-responders. Two or three
      lines, not a resend of the whole email. Then stop — a third message to a
      public institution that has ignored two is not persistence, it's a complaint
      waiting to happen.

## What "working" looks like

For cold institutional B2B at this list size, expect roughly:

| Metric                    | Realistic                    |
| ------------------------- | ---------------------------- |
| Reply rate                | 5–15%                        |
| Applications from 40 sent | 2–6                          |
| Of those, a good fit      | most — the form filters hard |

You need **5 libraries total**. If wave one yields 3–4, that is a working
message, not a failure — send wave two to a fresh 40. If it yields zero from 40,
the problem is the list or the offer, not the copy; come back and we'll look at it
before burning more addresses.

Track replies, not opens. This email deliberately has **no tracking pixel** — it
would undercut the "no tracking" promise the site makes, and open rates would tell
you less than the reply thread anyway.
