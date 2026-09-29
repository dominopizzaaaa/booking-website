# Marketing, DNC, and commercial-message policy

Effective internal baseline: 2026-09-29

Policy owner: `TBD`

DPO approver contact: `domksj23@gmail.com`; named approver and dated approval remain `TBD`

Status: `BLOCKED` for marketing campaigns

This policy is an operating baseline, not legal advice. Courtly currently has
transactional email infrastructure but no approved marketing campaign,
campaign consent journey, or unsubscribe workflow. Until every launch gate
below is complete, Courtly must not send platform- or club-originated marketing
email, SMS, WhatsApp, fax, or voice calls.

## Current-state boundary

- `config.marketingEnabled` is hard-coded to `false`; there is intentionally no
  environment setting that can open it. The email queue therefore records every
  helper-classified `MARKETING` event as `SUPPRESSED` with
  `MARKETING_DISABLED`, before recipient validation or account-preference
  lookup. This includes unbound recipients and accounts whose dormant
  `emailMarketingEnabled` value is `true`.
- This is an enqueue-time boundary in the supported helper, not a campaign
  system. The durable row does not currently retain a marketing category and
  the worker cannot independently reclassify a directly inserted or historical
  queued row. Production code must not bypass the helper; campaign work remains
  blocked until durable send-time enforcement and all approval gates below are
  implemented.
- The current preferences API and UI do not expose or capture a marketing
  choice. Therefore the database field is not evidence of consent and must not
  be populated by migration, seed, import, inferred engagement, or an operator.
- No marketing-email producer, bulk campaign sender, automated SMS, push,
  telephone, fax, or WhatsApp delivery was found in the reviewed source.
- No marketing-specific outbound event type was found. Do not repurpose a
  transactional event name or create an unbound-recipient job for a campaign.
- The post-booking WhatsApp link is a user-initiated share action. It does not
  authorize Courtly or a club to contact the recipient.
- Booking/account/security messages must be classified on their actual primary
  purpose. Calling promotional content “transactional” does not change it.

## Message classification

| Class | Examples | Current rule |
| --- | --- | --- |
| Security / service access | One-use family handover or account-security notice | Send only for the requested security workflow; no promotion; hard suppression and delivery-risk handling still apply. |
| Transactional | Booking confirmation/cancellation, payment result, service change | Send only when tied to the user's transaction/account, use the narrowest content, and honour the implemented preference unless an approved essential-service rule applies. |
| Reminder / action needed | Upcoming booking or a response needed to complete an existing service | Keep separate from marketing; honour the corresponding preference and never add unrelated promotion. |
| Marketing / specified message | Offers, win-back messages, cross-sell, club promotions, audience campaigns | Prohibited until this policy's campaign gate is approved and technically enforced. |
| User-initiated share | User chooses WhatsApp/share and controls recipient/content submission | Not a Courtly campaign; do not retain recipient numbers or treat the action as consent. |

When classification is mixed or unclear, route it to the DPO/Legal owner and
treat it as marketing while the decision is pending.

## Campaign approval gate

The campaign owner must create a record with all fields below. `TBD` means no
send. Approval applies only to the named campaign, purpose, audience, content,
channel, sender, and period.

| Field | Required record |
| --- | --- |
| Campaign ID, name, purpose, and owner | `TBD` |
| Sender/legal entity and whether Courtly or a club controls the send | `TBD` |
| Channel(s) and countries/number prefixes | `TBD` |
| Exact audience source and inclusion/exclusion query | `TBD` |
| Message classification and reviewer rationale | `TBD` |
| Consent wording, affirmative action, scope, channel, brand, timestamp, source, and policy version | `TBD` |
| DNC analysis and check evidence for each Singapore telephone number | `TBD` |
| Content, sender identification, contact details, subject label if required, and destination URLs | `TBD` |
| One-step unsubscribe/withdrawal mechanism in the same channel where required | `TBD` |
| Global, account, channel, campaign, hard-bounce, complaint, and DNC suppression applied immediately before send | `TBD` |
| Vendor, sending domain/number, authentication, rate limits, and test evidence | `TBD` |
| Start/end time, volume cap, timezone, and stop authority | `TBD` |
| DPO/Legal approval and expiry | `TBD` |

## Consent and suppression rules

1. Use a separate, unticked choice with clear purpose, sender/brand, channel,
   and withdrawal method. Do not bundle marketing with account creation, a
   booking, safety terms, or transactional email.
2. Store the affirmative action, wording/policy version, source, scope, time,
   account/recipient, and withdrawal history. Imported consent requires the
   same evidence; an email address or customer relationship alone is not proof.
3. Withdrawal must be as easy as opt-in. Apply suppression promptly and before
   any later audience export or retry. Keep the minimum suppression evidence
   needed to prevent re-contact. Do not reactivate on login or a new booking.
4. A hard bounce, complaint, invalid destination, guardian/child safety hold,
   legal hold, or account restriction overrides marketing consent as applicable.
5. Never buy, scrape, harvest, generate, or use a third party's list without a
   documented provenance, consent, role, contract, and DPO review.
6. Do not expose one recipient to another. Use provider-level per-recipient
   sends, not visible bulk address fields.
7. Keep test accounts and provider sandbox/capture modes separate from live
   audiences. A seed or demo address must never enter a campaign.

## Singapore telephone-number and DNC procedure

Before any voice call, SMS/MMS, fax, or platform-initiated WhatsApp or similar
message to a Singapore telephone number:

1. Determine and record whether it is a “specified message” under the current
   DNC provisions. Do not rely on the channel name or a “service” label.
2. Record the reviewed exception or clear and unambiguous consent, or check the
   relevant DNC Register through the approved checker.
3. If relying on a DNC check, bind the result to the normalized number, register
   type, checker, query/reference, result, and time. The current PDPC guidance
   describes a 21-day prescribed period; re-check at send time whenever the
   stored result is older or law/guidance changes.
4. Reconcile consent withdrawal and internal suppression after the DNC check.
   A number absent from DNC is not permission to ignore a direct opt-out.
5. Include clear sender identification and usable contact information. Do not
   conceal the caller/sender identity.
6. Re-run the suppression and DNC decision immediately before every attempt and
   retry. Retain evidence of the exact list version sent.

## Commercial electronic message procedure

For any bulk commercial email or electronic message, Legal must review current
Spam Control Act requirements for whether the message is unsolicited, subject
labelling (including `<ADV>` where applicable), accurate sender information, a
functional unsubscribe route, processing deadlines, and prohibitions on
address harvesting/dictionary attacks. Courtly's operating default is stricter:
affirmative opt-in, clear identity, and unsubscribe in every marketing message.

## Pre-send and post-send evidence

Before release, a second person verifies the approved content hash, audience
count, sample recipients, exclusions, consent/DNC evidence, links, unsubscribe,
sender authentication, total volume, and emergency stop. After release, record
provider acceptance, delivery/bounce/complaint signals, unsubscribe processing,
suppression reconciliation, incidents, and campaign close. “Provider accepted”
is not proof of delivery or compliance.

## Authoritative starting points

- PDPC, [organisation guide to the DNC provisions](https://www.pdpc.gov.sg/about-do-not-call-registry/do-not-call-registry-for-organisations/organisations-guide-to-singapores-do-not-call-dnc-provisions)
- PDPC, [checking numbers against the DNC Registry](https://www.pdpc.gov.sg/organisations/e-services/check-numbers-against-do-not-calldnc-registry)
- PDPC, [Advisory Guidelines on the DNC Provisions](https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/advisory-guidelines/advisory-guidelines-on-the-dnc-provisions-1-feb-2021.pdf)
- IMDA, [best practices for organisations sending unsolicited communications](https://www.imda.gov.sg/Infocomm-regulation-and-guides/unsolicited-communications/best-practices-for-organisations)
