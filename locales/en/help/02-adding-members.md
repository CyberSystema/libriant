---
title: Adding members
slug: adding-members
summary: How to add a single member by hand. (Bulk import is coming.)
tags: members, onboarding, forms
---

## The form

Open **Members** in the sidebar, then click **Add member** in the top
right. The form is split into three sections:

### 1. Who they are

- **Full name** — required. Use the name they recognise.
- **Member number** — optional. Leave blank and we'll generate one in the
  shape `M-2026-0001`. If your library already uses a numbering scheme
  (a sticker, a card), type it here so we keep it.
- **Date of birth** — optional. Useful if you have age-based lending
  rules.

### 2. How to reach them

Email, phone, address. Everything is optional — a library with thin
records is perfectly fine. If you DO fill in the email we'll use it for
any notification templates you set up later.

### 3. Library-specific details

If your library has custom fields on members (set up in **Settings →
Data model**), they show up at the bottom of the form. The plain-language
labels you set in the editor are what shows here.

## After submit

You'll land on the member's **detail page** — full record on the left,
photo and stats on the right. From here you can:

- **Edit** anything you typed.
- **Suspend** the member temporarily (they can't be lent to until
  reactivated).
- **Archive** them when they leave (Libriant keeps their lending
  history; archive is reversible).
- **Upload a photo** for the membership card.

## Bulk import

Coming in the next release. For now, the API accepts JSON if you want to
script a one-off import from a spreadsheet — get in touch and we'll walk
you through it.
