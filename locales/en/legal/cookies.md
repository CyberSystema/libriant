> **Draft — pending review by qualified legal counsel.** This document is a
> tailored starting point, not legal advice. Replace every `[PLACEHOLDER]` and
> have it reviewed before you rely on it.

# Cookie Policy

**Last updated: 2026-08-27**

This policy explains the cookies and similar technologies Libriant uses.

## Summary

Libriant uses **strictly necessary cookies** to keep you signed in and to
operate securely, plus **one language cookie that is written only when you use
the language switch**. We do **not** use analytics, advertising, profiling, or
third-party tracking cookies. Both kinds are exempt from the prior-consent
requirement under the EU ePrivacy rules and Greek law — the first as strictly
necessary, the second because it does nothing until you explicitly ask for it —
so Libriant does not show a cookie-consent banner.

## Cookies we set

| Cookie                                                       | Purpose                                                                                                                       | Type                                  | Retention                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------ |
| `libriant_session` (or `__Host-libriant_session` over HTTPS) | Keeps a signed-in library user authenticated                                                                                  | Strictly necessary                    | Session / up to the "remember me" lifetime |
| `libriant_admin` (or `__Host-libriant_admin`)                | Authenticates a Libriant platform administrator                                                                               | Strictly necessary                    | Short-lived admin session                  |
| `libriant_imp` (or `__Host-libriant_imp`)                    | Identifies an authorised, audited support session ("impersonation")                                                           | Strictly necessary                    | Up to the support-session lifetime         |
| `libriant_locale`                                            | Remembers the language you chose with the in-app language switch                                                              | Preference (set only when you choose) | 1 year                                     |
| `__cf_bm` (set by Cloudflare, not by us)                     | Tells a person apart from an automated client so the protective network in front of the Service can turn away abusive traffic | Strictly necessary                    | 30 minutes                                 |

All authentication cookies are `HttpOnly` (not readable by JavaScript), use the
`SameSite` attribute, and are marked `Secure` (with the `__Host-` prefix) when
served over HTTPS.

`libriant_locale` is written only when you use the language switch, holds
nothing but `el` or `en`, and is the one cookie here you can refuse without
consequence: without it the Service falls back to your browser's language and
then to your library's default.

`__cf_bm` is set by **Cloudflare**, which sits in front of our servers as a
protective network and terminates the connection before it reaches us — see
[Sub-processors](/legal/subprocessors). It is bot management, not analytics: it
does not profile you and is not used to track you between sites.

## Local storage

The installable web app (PWA) and the desktop app use the browser's local
storage / IndexedDB — this is not a cookie and is never used for tracking — for
three things, which are cleared at different moments because they are not the
same kind of data:

- **Cached pages and data**, so the app still opens and shows what you were
  working on when the connection drops. Cleared when you sign out, and cleared
  again when your session expires or is ended for you.
- **Circulation actions taken while offline** (check-out, return, renew, mark
  lost) waiting to be sent. Each one carries a short human-readable summary —
  the title and the member — so staff can see what is still outstanding.
  Signing out clears them. An expired session deliberately does **not**: the
  same member of staff usually signs straight back in, and their queued
  check-outs still have to reach the library's records. An action that has been
  waiting more than 18 hours is no longer sent automatically; it is listed for
  staff to redo by hand.
- **Actions that could not be completed**, kept so that the work is not lost
  silently — a return that never reached the server is a book the catalogue
  still shows as out. These stay on the device until a member of staff dismisses
  them in the app, and in any case no longer than 30 days. They are **not**
  removed by signing out, because they belong to the library's desk rather than
  to whoever happened to be signed in when they failed.

Nothing else is kept in local storage. Interface preferences — the language you
picked — live in the `libriant_locale` cookie above, not here.

## Third parties

When you make a payment, Stripe may set cookies on its own checkout/portal pages
to operate and secure the payment and to prevent fraud. Those cookies are
governed by Stripe's own policies — see [Sub-processors](/legal/subprocessors).

## Managing cookies

Because our cookies are strictly necessary, disabling them in your browser will
prevent you from signing in and using the Service. You can clear cookies at any
time via your browser settings; signing out also clears the offline cache and
the queue of pending circulation actions, as described above.

## Contact

Questions: `[CONTACT EMAIL]`. See also the [Privacy Policy](/legal/privacy).
