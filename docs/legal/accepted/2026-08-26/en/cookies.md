# Cookie Policy

**Last updated: 2026-06-22**

This policy explains the cookies and similar technologies Libriant uses.

## Summary

Libriant uses **only strictly necessary cookies** to keep you signed in and to
operate securely. We do **not** use analytics, advertising, profiling, or
third-party tracking cookies. Because all of our cookies are strictly necessary,
they are exempt from the prior-consent requirement under the EU ePrivacy rules
and Greek law, so Libriant does not show a cookie-consent banner.

## Cookies we set

| Cookie                                                       | Purpose                                                             | Type               | Retention                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------ | ------------------------------------------ |
| `libriant_session` (or `__Host-libriant_session` over HTTPS) | Keeps a signed-in library user authenticated                        | Strictly necessary | Session / up to the "remember me" lifetime |
| `libriant_admin` (or `__Host-libriant_admin`)                | Authenticates a Libriant platform administrator                     | Strictly necessary | Short-lived admin session                  |
| `libriant_imp` (or `__Host-libriant_imp`)                    | Identifies an authorised, audited support session ("impersonation") | Strictly necessary | Up to the support-session lifetime         |

All authentication cookies are `HttpOnly` (not readable by JavaScript), use the
`SameSite` attribute, and are marked `Secure` (with the `__Host-` prefix) when
served over HTTPS.

## Local storage

The installable web app (PWA) and the desktop app may use the browser's local
storage / IndexedDB to: cache the app shell for offline use; queue circulation
actions made while offline so they sync when you reconnect; and remember
interface preferences. This is not a cookie and is not used for tracking; cached
data is cleared on sign-out and on session loss.

## Third parties

When you make a payment, Stripe may set cookies on its own checkout/portal pages
to operate and secure the payment and to prevent fraud. Those cookies are
governed by Stripe's own policies — see [Sub-processors](/legal/subprocessors).

## Managing cookies

Because our cookies are strictly necessary, disabling them in your browser will
prevent you from signing in and using the Service. You can clear cookies at any
time via your browser settings; signing out also clears the offline cache.

## Contact

Questions: `[CONTACT EMAIL]`. See also the [Privacy Policy](/legal/privacy).
