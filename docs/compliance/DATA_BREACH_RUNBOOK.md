# Personal-data breach response runbook

Status: operational draft, not legal advice

DPO public contact: `domksj23@gmail.com`

Appointment evidence, named individual, alternate, and after-hours route: not recorded in this repository
Last reviewed: 2026-09-29

## Immediate response

1. Preserve safety and contain the incident without destroying evidence. Record
   discovery time, reporter, systems, data categories, people/records affected,
   countries, credentials, and containment actions. Notify the DPO and security
   owner immediately.
2. Start the notifiability assessment when Courtly has credible grounds to
   believe a breach occurred. Assign one incident lead and legal/DPO reviewer;
   contact affected vendors using the current
   [`VENDOR_REGISTER.md`](VENDOR_REGISTER.md).
3. Rotate exposed secrets, revoke sessions/tokens, isolate affected integrations,
   preserve relevant logs, and prevent further disclosure. Do not delay
   containment while deciding whether notification is required.

## Clocks: law versus internal targets

| Clock | Source | Requirement/target |
| --- | --- | --- |
| Assessment | Singapore PDPA breach-notification regime | Take reasonable and expeditious steps; current PDPC guidance uses 30 calendar days after credible grounds to believe a breach occurred as an assessment benchmark. This is not a statutory outer boundary, and an unreasonable delay may breach the obligation. |
| Notify PDPC | Statutory | If notifiable, notify the PDPC as soon as practicable and no later than 3 calendar days after making the notifiability assessment. |
| Notify affected individuals | Statutory where significant harm is likely | Notify as soon as practicable, at the same time as or after notifying the PDPC, subject to statutory exceptions/directions. |
| Internal escalation | Courtly target, not statute | DPO/security acknowledgement within 4 hours; initial severity and containment plan within 24 hours; daily review until contained and assessed. |
| Data intermediary to principal | Contract/guidance target, role-dependent | Notify the controlling organisation without undue delay; set a contractual target no longer than 24 hours after awareness and verify the actual contract. |

Do not call the 30-day assessment guidance a statutory outer boundary or grace
period, and do not confuse the 3-calendar-day post-assessment statutory deadline
with the commonly stated 72-hour shorthand. Record the precise timestamps and
advice relied on.

## Assessment and notification record

Document whether the breach is likely to cause significant harm and/or is of
significant scale, including the 500-or-more-individual scale threshold, data
sensitivity, protections, recipients, recoverability, and foreseeable impact.
Have qualified counsel/DPO confirm the decision and applicable exceptions.
Record reasons even when the incident is assessed non-notifiable.

Notifications must be accurate, usable, and updated as facts develop. Include
the nature/extent of the breach, affected data, likely consequences, containment
and remediation, protective steps individuals can take, and a contact channel.
Never delay an initial required notification merely to obtain every detail.

After containment, complete root-cause review, corrective actions, vendor and
access review, deletion/retention checks, customer support plan, and lessons
learned. Keep the minimum incident evidence under an approved retention period.

## Sources

- PDPC, [Report Your Organisation's Data Breach](https://www.pdpc.gov.sg/organisations/e-services/report-your-organisations-data-breach)
- PDPC, [Guide on Managing and Notifying Data Breaches](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Other-Guides/Guide-on-Managing-and-Notifying-Data-Breaches-under-the-PDPA-15-Mar-2021.pdf)
- PDPC, [Introduction to Managing Data Breaches 2.0](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Other-Guides/Data-Breach-Management/Introduction-to-Managing-Data-Breaches-2-0.pdf)
