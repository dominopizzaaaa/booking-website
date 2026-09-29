# Vendor and subprocessor register

Snapshot date: 2026-09-29

Register owner: `TBD`

DPO public contact: `domksj23@gmail.com`; named approver and dated approval remain `TBD`

Overall status: `UNVERIFIED/TBD`

This is a discovery register, not an approved vendor list, data-processing
inventory, transfer assessment, security certification, or statement that each
service is enabled in production. Product source and deployment documentation
name possible services, but they do not establish the contracted legal entity,
hosting/processing country, subprocessor chain, agreement, production account,
or data actually processed. Every such field remains `UNVERIFIED/TBD` until the
owner attaches current evidence.

If the privacy workstream publishes an approved vendor/subprocessor register,
that register becomes authoritative and this discovery list should be replaced
with a link to it rather than maintained independently.

## Approval rule

Do not enable a vendor or disclose it as an approved subprocessor until the
owner records and DPO/Security approve, as applicable:

- service purpose, controller/processor/data-intermediary role, and instructions;
- contracted legal entity, account/tenant, product tier, and agreement links;
- personal-data categories, data subjects, sensitive/high-impact data, access,
  storage, logs/telemetry, support access, and onward subprocessors;
- all processing/storage/support countries and the transfer mechanism and
  comparable-protection assessment for data leaving Singapore;
- security due diligence, authentication/access, encryption, logging,
  vulnerability/incident practices, business continuity, and evidence expiry;
- breach-notification contact and contractual deadline;
- retention, deletion/return, backup deletion, export, legal hold, and exit plan;
- availability, recovery, financial/operational concentration, and fallback; and
- named business, technical, security, procurement, and privacy owners.

Marketing/advertising or session-replay capabilities require a separate DPO and
public-notice/consent review even if an already approved vendor offers them.

## Discovered services

| Service/capability observed | Repository evidence/purpose | Production enabled? | Contracted entity/account | Personal data and role | Processing/storage/support countries | Agreement / DPA / transfer safeguard | Security and incident review | Retention/deletion/exit | Owner and approval | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Railway | README deployment target for backend and PostgreSQL | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD`; may host application/account/booking/payment metadata | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `TBD` | `UNVERIFIED/TBD` |
| Vercel | README deployment target for Next.js frontend and same-origin API rewrite | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD`; request metadata and frontend delivery may be processed | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `TBD` | `UNVERIFIED/TBD` |
| PostgreSQL provider | Primary application database; README suggests Railway PostgreSQL but another provider may be configured | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | Broad application record set; exact production scope `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `TBD` | `UNVERIFIED/TBD` |
| Stripe and connected accounts | Optional live Class/package payment processing, webhooks, refunds, receipt email | `UNVERIFIED/TBD`; `PAYMENTS_MODE` controls runtime | `UNVERIFIED/TBD`; one platform account and club connected accounts may be involved | Payment/customer identifiers and transaction metadata; exact roles `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `TBD` | `UNVERIFIED/TBD` |
| Resend | Optional transactional email provider | `UNVERIFIED/TBD`; `EMAIL_PROVIDER` controls runtime | `UNVERIFIED/TBD` | Recipient name/address, template content, booking/account/security metadata; provider role `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD`; bounce/complaint ingestion is not implemented | `UNVERIFIED/TBD` | `TBD` | `UNVERIFIED/TBD` |
| Google Calendar / OAuth | Optional personal calendar projection and free/busy queries | `UNVERIFIED/TBD`; complete Calendar config controls runtime | `UNVERIFIED/TBD` | OAuth identity, encrypted refresh/access grant, Courtly event fields, bounded busy intervals | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | Disconnect cleanup exists; provider-side retention/exit `UNVERIFIED/TBD` | `TBD` | `UNVERIFIED/TBD` |
| Google Maps / Places | Optional server-side venue search; Maps links work without API key | `UNVERIFIED/TBD`; key controls Places lookup | `UNVERIFIED/TBD` | Search/location/address and request metadata; exact production data `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `TBD` | `UNVERIFIED/TBD` |
| GitHub | Source repository and CI/deployment source described in README | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | Source, issues/actions/logs/secrets metadata depending on configuration; personal data use `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `TBD` | `UNVERIFIED/TBD` |
| Domain/DNS/registrar | Needed for a production public origin and mail authentication; no provider established | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | Registrant, DNS/query and contact data `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `TBD` | `UNVERIFIED/TBD` |
| Logging, monitoring, alerting, backup, and support tools | Operationally required but no approved production services identified by this review | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | Potentially broad/high-risk logs or database copies; must be minimized | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `UNVERIFIED/TBD` | `TBD` | `UNVERIFIED/TBD` |

The absence of analytics or advertising SDKs in the reviewed dependency/source
search does not prove that deployment-level analytics, CDN logs, injected tags,
browser monitoring, or vendor dashboards are disabled. Verify the deployed
site, response headers, network requests, hosting dashboards, DNS, and vendor
accounts before release.

## Change and offboarding record

For every new capability or vendor change, create a dated row before enabling
it. For offboarding, disable keys/integrations, export required records, confirm
deletion/return including backups under the agreement, remove access and DNS/
webhooks, update public disclosures, and retain the minimum closure evidence.

| Change/vendor | Requested by | Purpose/data change | Reviewers | Decision/date | Enable/disable evidence | Deletion/exit evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |

## Authoritative starting points

- PDPC, [Guide to Managing Data Intermediaries](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Other-Guides/Guide-to-Managing-Data-Intermediaries--2020.pdf)
- PDPC, [data protection obligations](https://www.pdpc.gov.sg/overview-of-pdpa/the-legislation/personal-data-protection-act/data-protection-obligations)
- PDPC, [Guide to Cross-Border Data Transfers](https://www.pdpc.gov.sg/organisations/resources/guidance-by-topic/guide-to-cross-border-data-transfers)
