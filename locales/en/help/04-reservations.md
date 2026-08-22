---
title: Holds and reservations
slug: reservations
summary: How the queue works — placing holds, ready pickups, and what happens when a copy comes back.
tags: reservations, holds, queue, pickup
---

## What's a hold

When a book a member wants is already on loan to someone else, the member
can **place a hold**. They join a queue; when the copy comes back, the
person at the front of the queue gets notified and has a window of time
to pick it up.

## Placing a hold

1. Open **Reservations** in the sidebar.
2. Click **Place a hold**.
3. Pick a book (autocomplete by title, author or ISBN).
4. Pick the member.
5. Add an optional note (e.g. "Calling from front desk").

The toast that pops up tells you what happened:

- **"Held at position N in the queue"** — there's a queue for this book
  and the member is now in position N. They'll be notified when their
  turn comes.
- **"A copy was available — this hold is ready to pick up"** — there
  was a free copy on the shelf when you placed the hold. We auto-promoted
  it so the member can pick it up immediately.

## When a copy comes back

The moment you mark an active loan as **returned** in Libriant, two
things happen:

1. The copy's status flips to "available".
2. If there's a queued hold on this book, the head of the queue is
   auto-promoted to **ready**. The librarian's UI shows this in the
   return modal so they can shelve the book in the holds area instead
   of general stacks.

The ready hold has an **expiry** — by default 48 hours (configurable in
your library's policies). If the member doesn't pick it up before then,
the hold expires and the next person in the queue takes their place.

## Handing over a ready hold

When the member arrives:

1. Open **Reservations**.
2. Find their row (status will say "Ready").
3. Click **Hand over**.

Behind the scenes that creates a Loan from the held copy and marks the
reservation as fulfilled. The member walks out happy; the queue moves
on for the next person.

## Cancelling a hold

Click **Cancel hold** on any row whose status is "Waiting" or "Ready".
If you cancel a ready hold, the copy goes back to "available" and the
next person in the queue is auto-promoted.

## Plan note

Reservations require a plan with a subscription (Community and above).
Libraries on the free Starter plan get a friendly upgrade page if they try
to place one.
