> **Draft — pending review by qualified legal counsel.** Verify each
> sub-processor, region, and safeguard against your actual deployment before you
> publish this.

# Sub-processors

**Last updated: 2026-06-22**

To deliver the Service, Libriant uses the third-party "sub-processors" below.
Each is bound by data-protection terms no less protective than our
[Data Processing Agreement](/legal/dpa). We update this list before adding or
replacing a sub-processor, as described in the DPA.

| Sub-processor                    | Service provided                                                           | Data processed                                                                                       | Location / transfer safeguard                                  |
| -------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `[Hetzner Online GmbH]`          | Cloud hosting (application + databases + storage + backups)                | All Library Data + account data at rest                                                              | EU (`[Germany / Finland]`) — within EEA                        |
| `[Cloudflare, Inc.]`             | Edge network / TLS / DDoS & WAF protection in front of the app             | Network metadata, IP addresses, requests in transit                                                  | Global edge; EU SCCs + data-localisation options as configured |
| `[Stripe Payments Europe, Ltd.]` | Payment processing for paid subscriptions                                  | Billing name/email, payment method (card data handled by Stripe; we never receive full card numbers) | EU/Ireland; SCCs for any onward transfer                       |
| `[Resend / your SMTP provider]`  | Transactional email delivery (verification, password reset, notifications) | Recipient email address, message content                                                             | `[Region]`; SCCs where applicable                              |

Notes:

- Email delivery is only active when a real email driver is configured; until
  then no email sub-processor receives data.
- Payment data is processed by Stripe only when paid billing is enabled and a
  library initiates a checkout or portal session.
- We do **not** use analytics, advertising, or tracking sub-processors.

Questions or objections: `[CONTACT EMAIL]` / `[DPO EMAIL]`.
