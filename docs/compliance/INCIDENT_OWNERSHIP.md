# Incident ownership and notification decisions

Effective internal baseline: 2026-09-29

Accountable executive: `TBD`

Status: `BLOCKED` until every role has a tested primary and alternate

This runbook covers platform security/privacy, safeguarding, payment, vendor,
and workplace incidents. It is not legal advice and does not declare an
incident reportable or non-reportable. The designated owner must record each
decision against current law, contracts, affected people, and facts.
Chat reports and online-safety notices use the more detailed
[`CHAT_SAFEGUARDING_OPERATIONS.md`](../CHAT_SAFEGUARDING_OPERATIONS.md) under
this general incident roster and decision-log structure.

## Named roster

Do not put personal secrets in this repository. Link the access-controlled
on-call system and retain a dated export or exercise record.

| Role | Primary | Alternate | After-hours route | Authority | Last exercised |
| --- | --- | --- | --- | --- | --- |
| Accountable executive | `TBD` | `TBD` | `TBD` | Business decisions and regulator notifications | `TBD` |
| Incident commander | `TBD` | `TBD` | `TBD` | Coordinate, assign, declare severity, close | `TBD` |
| DPO / privacy lead | `domksj23@gmail.com` (public contact; named individual not recorded) | `TBD` | `TBD` | PDPA assessment and notices | `TBD` |
| Security/engineering lead | `TBD` | `TBD` | `TBD` | Containment, evidence, recovery | `TBD` |
| Safeguarding lead | `TBD` | `TBD` | `TBD` | Child/adult safety and external referral | `TBD` |
| WSH owner / relevant club | `TBD` | `TBD` | `TBD` | Care, scene control, MOM/WICA/insurer decision | `TBD` |
| Payments/finance lead | `TBD` | `TBD` | `TBD` | Provider, fraud, ledger, refunds, financial notice | `TBD` |
| Communications/support lead | `TBD` | `TBD` | `TBD` | Approved status and affected-person communications | `TBD` |
| Legal/regulatory liaison | `TBD` | `TBD` | `TBD` | Privilege, compulsory requests, regulator/law-enforcement route | `TBD` |
| Vendor/procurement owner | `TBD` | `TBD` | `TBD` | Supplier escalation and contractual notice | `TBD` |

Named application access does not itself appoint an incident owner, authorize
a decision, or provide an approved break-glass mechanism. Do not use general chat or ordinary
support tickets for secrets, full identity documents, payment credentials, or
suspected abuse imagery.

## First response

1. Protect life and immediate safety. Contact emergency services or the
   approved safeguarding route when needed; the app is not an emergency service.
2. Record discovery time in UTC and Singapore time, reporter, affected service,
   factual summary, suspected data/people/venues, and a stable incident ID.
3. Page the incident commander and specialist owner. Declare severity and set
   the next update time; do not wait for perfect information.
4. Contain proportionately while preserving evidence. Record every material
   action, actor, timestamp, command/change reference, and reason.
5. Start parallel decision logs for affected people and safety, PDPA, WSH/WICA,
   payment/provider, contract/vendor, law enforcement, insurer, and any other
   regulator. “No notification” also requires owner, rationale, evidence, time,
   and reviewer.
6. Recover through reviewed changes, verify integrity and access, monitor for
   recurrence, communicate approved facts, and retain follow-up actions to close.

## Severity and response targets

These are internal maximum targets, not statements of statutory deadlines. A
shorter contractual or legal clock wins.

| Severity | Example | Acknowledge / page | Initial control target | Executive update |
| --- | --- | --- | --- | --- |
| SEV-0 | Imminent threat to life, active child abuse, or uncontrolled critical compromise | Immediately | Immediate safety/emergency response | Immediate |
| SEV-1 | Likely serious harm, material sensitive-data exposure, live payment compromise, major outage, reportable workplace event | 15 minutes | 1 hour | 1 hour |
| SEV-2 | Limited impact with credible escalation risk | 1 hour | 4 hours | 4 hours |
| SEV-3 | Low-impact contained issue or near miss | 1 business day | 2 business days | As agreed |

## Notification decision ledger

Create one row per authority, contractual recipient, insurer, vendor, club, or
affected group. Do not collapse separate clocks into one conclusion.

| Recipient/regime | Trigger facts considered | Clock starts | Deadline/target | Decision | Decision owner/time | Sent by/time/reference |
| --- | --- | --- | --- | --- | --- | --- |
| PDPC | Notifiable-data-breach assessment: likely significant harm and/or significant scale; current law/guidance | Determination that breach is notifiable | As soon as practicable and, for PDPC, no later than 3 calendar days after determination under current guidance | `TBD` | `TBD` | `TBD` |
| Affected individuals | Likely significant harm and safe/appropriate contact | Current statutory trigger | As soon as practicable, at the same time as or after PDPC where required | `TBD` | `TBD` | `TBD` |
| MOM / WSH / WICA | Death, injury/medical leave or light duty, dangerous occurrence, occupational disease, and identity of duty holder | Event/notice/diagnosis as applicable | Use current MOM category-specific rule; many reports use a 10-day period and some require prompt preliminary notice | `TBD` | `TBD` | `TBD` |
| Police / emergency / safeguarding authority | Immediate danger, suspected offence, child/adult protection duty | On awareness | Immediate or as advised | `TBD` | `TBD` | `TBD` |
| Payment provider / banks | Credential, payment, fraud, dispute, webhook, connected-account impact | Contract/scheme trigger | Current contract/scheme deadline | `TBD` | `TBD` | `TBD` |
| Vendor/customer/club | Contract, data-processing, service, or safety obligation | Contract trigger | Contract deadline | `TBD` | `TBD` | `TBD` |
| Insurer/broker | Circumstance, claim, injury, cyber or liability event | Policy trigger | Policy deadline | `TBD` | `TBD` | `TBD` |

For a suspected personal-data breach, log when credible grounds first existed
and assess reasonably and expeditiously. Current PDPC guidance describes a
30-calendar-day benchmark for assessment, while cautioning that unreasonable
delay breaches the obligation. Treat 30 days as a guidance benchmark, not a
statutory outer boundary, grace period, or entitlement to wait. If determined
notifiable, start the three-calendar-day PDPC clock from that determination and
notify affected individuals as required.

## Evidence and communications

- Preserve original data, logs, message/content IDs, configuration, provider
  notices, and decision records with access control and integrity metadata. Use
  a documented legal hold; do not indiscriminately duplicate personal data.
- For suspected child sexual-abuse or intimate material, do not ask a reporter
  to download, forward, email, or repeatedly view it. Capture identifiers and a
  minimal description and use the trained restricted workflow.
- Separate the factual incident record from privileged advice. Limit access by
  role and log exceptional access.
- Status messages must be accurate about known facts, impact, actions and next
  update. Never promise there was no exposure before assessment or claim a
  regulator, insurer, certification, or vendor has approved the response.
- A provider acknowledgement is not proof of delivery. Record retries, bounces,
  complaints, unreachable guardians/customers, and alternate safe contact.

## Recovery and closure

Closure requires containment, restored service/integrity, completed notification
decisions, affected-person support, credential/secret rotation where needed,
vendor and insurer follow-up, ownership and due dates for corrective actions,
and a blameless review. Verify corrective actions and update the compliance
register, vendor register, risk assessments, training, and tests.

## Exercises

Run at least twice yearly and after major architecture/owner changes:

- leaked database credentials with suspected child and guardian data access;
- compromised named-operator credential or admin session and unauthorized chat inspection;
- Resend/Stripe/Google/Railway/Vercel incident with incomplete vendor facts;
- serious coach/participant safeguarding report outside business hours;
- court injury that may engage WSH, WICA, venue and insurer obligations; and
- simultaneous deletion request and preservation/legal-hold need.

Record timestamps, missed contacts, evidence gaps, notification decisions,
communications, recovery, and remediation owners.

## Authoritative starting points

- PDPC, [Guide on Managing and Notifying Data Breaches](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Other-Guides/Guide-on-Managing-and-Notifying-Data-Breaches-under-the-PDPA-15-Mar-2021.pdf)
- PDPC, [report an organisation's data breach](https://www.pdpc.gov.sg/organisations/e-services/report-your-organisations-data-breach)
- MOM, [what and when to report](https://www.mom.gov.sg/workplace-safety-and-health/work-accident-reporting/what-and-when-to-report)
- MOM, [report a work-related accident](https://www.mom.gov.sg/workplace-safety-and-health/work-accident-reporting/report-a-work-related-accident)
- Safe Sport Singapore, [reporting toolkit](https://www.safesport.sg/reporting-toolkit/)
