---
title: Lending a book to a member
slug: lending-books
summary: The checkout flow — pick a member, pick a copy, set a due date.
tags: loans, circulation, checkout
---

## Quick path

1. Open **Loans** in the sidebar.
2. Click **New loan** in the top right.
3. **Member picker** — start typing the member's name, email or card
   number. Pick from the dropdown.
4. **Book picker** — start typing a title, author or ISBN. Pick from
   the dropdown.
5. **Copy** — we'll show every copy that's currently on the shelf for
   that book. Pick one (we auto-select the first available).
6. **Due date** — defaults to today + 14 days (or whatever your
   library's policy is). Change if you need.
7. **Notes** — optional. Anything the next librarian should know.
8. Click **Check out**.

That's it. You'll land on the loan's detail page where you can mark
the loan returned, renew it, or mark the copy lost when the day comes.

## What can go wrong

- **Member is suspended or archived.** Reactivate them first (Member
  detail page → Reactivate).
- **No available copies.** Either add a copy (Book detail page → Add a
  copy) or place a hold (Reservations → Place a hold) so the member is
  notified when the book comes back.
- **Per-member loan ceiling reached.** Some libraries cap how many
  books a member can borrow at once. Either return one of their open
  loans or change the cap in **Settings → Loan policies**.

## Returning a book

Open the loan's detail page (Loans → click the row), then **Mark
returned**. The modal asks for:

- **Condition** — "Good" puts the copy back on the shelf; "Damaged"
  flags it for repair.
- **Notes** — optional.

If the loan was overdue, we'll compute the fine from your library's
per-day rate and tie it to the loan. The librarian sees the fine total
on the loan's detail page and on the member's detail page.
