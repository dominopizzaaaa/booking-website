# Courtly compliance operations

Last reviewed: 2026-09-29

These files are internal decision records and operating templates for a
Singapore launch. They are not legal advice, a legal opinion, or evidence that
Courtly or a club is certified or compliant. A control is complete only when
its named owner has attached current evidence and, where required, obtained
professional advice. Product code, a checkbox, or a document on its own is not
proof that a control operates in production.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `BLOCKED` | A production activity must not start until the listed decision and evidence exist. |
| `OPEN` | Work or fact-finding is still required before launch. |
| `PARTIAL` | A technical or operational control exists, but the full control is not evidenced. |
| `NOT_APPLICABLE` | An owner recorded the facts and rationale showing why the item is out of scope. |
| `READY` | The owner, evidence, approval date, and next review are recorded. This is not a certification. |

Do not change a row to `NOT_APPLICABLE` or `READY` based on an assumption. Link
the contract, filing, policy approval, register extract, test result, or other
evidence that supports the decision.

## Documents

- [Singapore compliance register](SINGAPORE_COMPLIANCE_REGISTER.md) is the
  release-gate index and repository audit snapshot.
- [Seller, agent, and GST decision](SELLER_AGENT_GST_DECISION.md) is the
  transaction-by-transaction template that Finance and Singapore advisers must
  complete before live commerce.
- [Marketing and DNC policy](MARKETING_DNC.md) defines the current no-marketing
  baseline and the approval path for any future campaign.
- [Coach and club operations](COACH_OPERATIONS.md) covers safe recruitment,
  worker classification, insurance evidence, and workplace safety.
- [Incident ownership](INCIDENT_OWNERSHIP.md) defines minimum roles, triage,
  evidence, and regulator-decision clocks. The separate
  [chat safeguarding runbook](../CHAT_SAFEGUARDING_OPERATIONS.md) adds
  chat/online-safety-specific triage under that general ownership model.
- [Personal-data breach response](DATA_BREACH_RUNBOOK.md) adds the
  privacy-specific assessment and notification procedure under the general
  incident ownership model.
- [Privacy request operations](PRIVACY_REQUEST_RUNBOOK.md) describes the
  implemented request register and the manual review and fulfilment boundary.
- [Personal-data retention schedule](RETENTION_SCHEDULE.md) is a proposed
  decision framework whose owners, exact periods, and disposal procedures
  still require approval and evidence.
- [Vendor and subprocessor register](VENDOR_REGISTER.md) is a discovery list
  whose production entities, countries, contracts, and enablement all remain
  `UNVERIFIED/TBD` until supported by evidence.
- [PostgreSQL backup and restore verification](../operations/POSTGRES_RECOVERY.md)
  defines the fail-closed application backup exercise and RPO/RTO evidence
  template; provider backup/PITR configuration remains separately unverified.
- [Production monitoring baseline](../operations/OBSERVABILITY.md) documents
  the redacted request signals and still-open monitoring ownership and
  configuration work required before launch.

The privacy inventory and public notices may be maintained by the privacy
workstream. If it produces an approved vendor/subprocessor register, replace
the discovery register with a link to that authoritative artifact rather than
maintaining competing lists.

## Minimum production rule

The accountable executive must sign a dated release record listing every
`BLOCKED` row and its disposition. Unknown facts stay blocked. An expiry date,
regulatory change, new vendor, new data type, new contact channel, new country,
new type of seller, or changed payment flow reopens the affected decision.
Production marks the legal set approved only when
`LEGAL_DOCUMENTS_APPROVED_VERSION` and `LEGAL_DOCUMENTS_APPROVED_HASH` exactly
match the current constants. In production, that approval is required before
registration, online checkout, or Family consent writes. Setting those values
records only the technical release gate; retain the accountable approval
evidence for that exact version and content hash.
Live Stripe has a separate technical gate:
`PAYMENT_COMMERCIAL_APPROVED_VERSION` must equal the current checkout-policy
version. Do not set it while the seller/agent/GST record remains incomplete.
Neither gate is evidence of substantive approval; retain the signed decision
and supporting facts outside source control.
