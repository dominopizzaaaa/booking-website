# Personal-data retention schedule

Status: proposed schedule requiring DPO, finance, legal, security, and service-owner approval

Owner contact: `domksj23@gmail.com` (DPO public contact)

Appointment evidence, named individual, alternate, and approval record: not recorded in this repository
Last reviewed: 2026-09-29

This schedule is a decision framework, not evidence that production deletion
jobs exist. Periods start when the stated business/legal purpose ends, and a
specific valid legal hold pauses disposal only for the records within its scope.
The shortest approved period wins unless law, a dispute, or a binding contract
requires longer retention.

| Record family | Proposed trigger and period | Disposal/minimisation | Approval needed |
| --- | --- | --- | --- |
| Account profile and credentials | Active account; erase after an approved deletion/closure workflow | Delete password hash, sessions, verification claims, contact/profile data; retain a non-reversible suppression marker only if required to honour deletion | DPO + Security |
| Email verification claims | Consumed/revoked/expired plus 30 days | Delete claim and delivery linkage; retain only aggregate delivery metrics | Security + DPO |
| Signup Terms/Privacy evidence | Account life plus limitation/dispute period determined by counsel | Retain version and timestamp with a pseudonymous subject reference where feasible | Legal + DPO |
| Booking/class/rental operational history | End/cancellation plus period approved for disputes, safeguarding, and service records | Remove free-text notes/contact fields first; preserve minimum schedule and party pseudonym where justified | Operations + DPO |
| Payments, refunds, settlements, invoices/tax records | Statutory accounting/tax period confirmed for the actual seller model | Keep immutable amounts, currency, provider references and minimum party key; remove unrelated profile/contact data | Finance + Legal |
| Chat messages and proposals | End of relationship plus approved safety/dispute window | Delete ordinary content or anonymise sender; retain only specifically held safety evidence | Safeguarding + DPO |
| Club/staff audit events | Approved security/audit limitation period | Preserve immutable action evidence; minimise actor email/name when no longer necessary | Security + Legal |
| Child consent/handover evidence | Child-account life plus approved consent/dispute period | Preserve minimum append-only authority evidence; restrict access; never retain raw handover tokens | DPO + Legal |
| Privacy requests and events | Closure plus approved accountability/complaint period | Retain decision and evidence references; delete supplied identity documents and exports promptly | DPO + Legal |
| Operational notifications/outbound delivery | Delivery/incident troubleshooting period, proposed 90 days unless linked to a live dispute | Delete message payload and recipient contact; retain aggregate status where useful | Operations + DPO |
| Calendar OAuth and projections | Disconnect/deletion request | Revoke provider token, delete encrypted local grant and cached busy intervals; complete remote event cleanup | Security + Product |
| Backups | Provider rotation window, target no more than 35 days unless approved otherwise | Cryptographic expiry/provider deletion; prevent ordinary restoration and replay deletion decisions after restore | Infrastructure + DPO |

Before production, replace every “proposed”, `TBD`, and approval dependency with
an owner, legal basis, exact duration, system query, deletion/anonymisation
procedure, verification evidence, and exception-review cadence. Cross-check the
systems and overseas locations in [`VENDOR_REGISTER.md`](VENDOR_REGISTER.md).
