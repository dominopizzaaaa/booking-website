# Courtly chat safeguarding operations runbook

**General incident ownership and on-call roster:** [Incident ownership and notification decisions](./compliance/INCIDENT_OWNERSHIP.md)

**Applies to:** account and SESSION chat reports, user blocks, linked safeguarding cases, and emergency or legal escalations

**Last reviewed:** 2026-09-29
**Status:** launch-control specification; use only when the general ownership matrix has tested primary and alternate coverage, and the secure case workspace and controls described below are available

This is an internal response runbook, not a public policy or legal opinion. It turns a report or block into a traceable safeguarding case. It does not transfer a club's responsibility for its coaches, Classes, venues, supervision, or safeguarding process to Courtly. The general incident matrix is authoritative for named roles, alternates, after-hours routes, organisation-wide severity, and notification ownership; this runbook adds only the chat-safeguarding and OSRAA workflow.

## 1. Non-negotiable operating boundaries

- **Courtly is not an emergency service.** A person in immediate danger in Singapore should call Police **999**. If it is unsafe to speak, Police Emergency SMS **70999** is available. Abuse, neglect, domestic violence, or sexual-harassment concerns may also be reported to the 24-hour National Anti-Violence and Sexual Harassment Helpline (NAVH) at **1800-777-0000**. Do not tell someone to wait for Courtly to act before seeking emergency help.
- **Do not claim continuous monitoring.** Courtly does not promise to pre-screen or proactively read every message. Operators review reports, linked evidence, and properly escalated cases. Admin visibility for safety is not a promise of universal or real-time surveillance.
- **Do not claim an unstaffed service.** A 24/7 critical queue is the recommended launch standard, not a statement that Courtly currently has 24/7 personnel. Until the [incident ownership matrix](./compliance/INCIDENT_OWNERSHIP.md) has a tested primary, alternate, after-hours route, and handover, publish the actual staffed hours and tell reporters that the channel is not continuously monitored. Do not publish an SLA that the roster cannot meet.
- **A block is not a booking cancellation or a safety determination.** It is a user's contact boundary. It suppresses ordinary interpersonal contact to the extent the product supports, but must not hide mandatory `SESSION` lifecycle/system communications needed to operate an existing Class, such as joining/leaving, cancellation, rescheduling, reminders, or coach assignment. A report creates a triage record; a block alone does not.
- **Preserve first; investigate proportionately.** Do not ask a reporter to re-download, forward, or repeatedly view distressing content when Courtly can preserve the server-side record. Do not confront a reported person, contact a guardian, or disclose a reporter's identity reflexively.

## 2. Queue readiness and case-specific duties

Before enabling in-product reporting, maintain one published route into a single safeguarding queue and test it end to end. Email-only intake is not sufficient for a claimed 24/7 response unless it pages the duty operator and is continuously covered.

Use the current primary, alternate, and after-hours routes in the [general incident ownership matrix](./compliance/INCIDENT_OWNERSHIP.md). Do not maintain a competing roster here. If that matrix is `TBD`, `BLOCKED`, stale, or untested, safeguarding coverage is not operational and Courtly must not claim otherwise.

For each chat case, the rostered incident commander or safeguarding lead must record these case-specific assignments in the restricted case/duty log:

- the **case owner**, who acknowledges, classifies, preserves evidence, and owns the chat-case clock;
- the **safeguarding decision lead** for an S0/S1 case, normally the rostered safeguarding lead;
- the **evidence custodian**, working with the rostered security/engineering lead for export, integrity, and containment;
- an independent **second reviewer** for the high-impact decisions listed in section 10; and
- for an OSC/OSRAA notice, the **notice owner and verifier** working with the rostered legal/regulatory liaison.

These are assignments within a case, not additional organisation-wide owners. Escalations to the incident commander, safeguarding lead, DPO/privacy lead, security/engineering lead, or legal/regulatory liaison always use the authoritative matrix. At handover, reconcile every `NEW`, `TRIAGED`, `IN_REVIEW`, `ACTION_PENDING`, and `WAITING_EXTERNAL` case. Record owner, next action, deadline, and paging status. An unattended urgent case is escalated through the matrix; it is never silently carried to the next business day.

Club-side **Assign to me** records the account's stable ID as the current owner and keeps the displayed name as an audit-friendly snapshot. Removing that person's safeguarding-review permission or revoking their staff access clears their current assignments and appends a case event; restoring access never restores those assignments. Legacy name-only assignments are not silently matched to an account and remain unverified until explicitly reassigned. Platform assignment remains a free-text case-owner label; it is distinct from the authenticated named platform operator recorded on each review or enforcement event.

### Current platform authentication boundary

Production safeguarding access requires an environment-configured named operator. The signed admin session binds the operator's stable ID and expiry, and safeguarding review and direct-account-chat restriction events snapshot that operator's name, email, and stable ID. Removing the operator or rotating their password hash invalidates existing sessions. A non-production shared `ADMIN_PASSWORD` may remain for compatibility, but those legacy sessions cannot read safeguarding reports or platform conversations and cannot run enforcement actions.

Named authentication and mutation attribution do not replace operational controls. Record each access and decision in the restricted duty log with UTC timestamp, case ID, purpose, data viewed or exported, action requested, and second reviewer where applicable. The console still has no durable audit event for every read, no least-privilege platform roles, and no general suspension, restoration, or content-moderation capability; those remain launch controls for scaled operations.

Club `SAFEGUARDING` staff access is a club-workspace permission preset; it is not Courtly platform-operator identity and must not be used to conceal or substitute for platform accountability.

## 3. Intake, categories, and severity

### 3.1 Minimum intake record

Create one case for each report, or link it to an existing case only after confirming the same incident or continuing pattern. Record:

- case ID, intake channel, received timestamp, reporter account (if known), subject accounts, thread/message/report IDs, club and booking IDs where relevant;
- reporter's own words, requested outcome, whether they have blocked the person, and a safe way/time to contact them;
- whether a child or vulnerable person is involved; whether the alleged actor is a guardian, coach, club, or person with authority over them;
- threat details: immediacy, location, planned time, access to the person, weapon or means, injury, coercion, extortion, disappearance, or self-harm indicators;
- category, severity, confidence/unknowns, owner, deadlines, actions, disclosures, legal hold, and linked cases; and
- the exact content snapshot and preservation manifest described in section 8.

Do not force the reporter to identify a legal offence. Operators classify facts, not people: write “message threatens X” rather than “user is a criminal.” Do not downgrade merely because the report is anonymous, incomplete, historic, or concerns conduct that moved off-platform.

### 3.2 Categories

Use one primary category and every applicable secondary category:

| Category | Examples and triage cues |
| --- | --- |
| Immediate physical safety | Credible imminent threat, person en route, active assault, abduction, serious injury, current child danger |
| Child sexual abuse or exploitation | Grooming, sexualised contact with a child, solicitation, sexual imagery, sextortion, arranging secret contact |
| Child abuse, neglect, or boundary breach | Physical/emotional abuse, unsafe supervision, coercive coach conduct, unnecessary private contact, guardian-authority concern |
| Sexual harm | Sexual harassment, non-consensual intimate content, assault allegation, coercion, stalking with sexual context |
| Threats, violence, stalking, or coercive control | Threats to harm, persistent location/contact pursuit, doxxing tied to danger, domestic/family violence |
| Harassment, bullying, hate, or discrimination | Repeated unwanted contact, humiliation, targeted abuse, protected-trait hostility |
| Self-harm or suicide concern | Expressed intent, plan, means, farewell message, encouragement of self-harm |
| Privacy or intimate-data abuse | Doxxing, exposure of child/contact/location data, unauthorised private or intimate material |
| Fraud, impersonation, or account compromise | False identity/club, credential theft, payment scam, compromised account used to contact others |
| Spam or lower-level misuse | Unwanted promotion, irrelevant solicitation, isolated profanity, non-safety policy breach |
| Other / uncertain | Insufficient facts or a credible concern outside the categories; never use this to avoid urgent triage |

### 3.3 Severity and initial action targets

These are **Courtly prudential chat-case targets**, not OSRAA statutory deadlines and not a statement of current staffing. They do not replace the general `SEV-0`–`SEV-3` declaration and paging targets in the [incident ownership matrix](./compliance/INCIDENT_OWNERSHIP.md). When a chat case is also a general incident, record both classifications and follow the shorter target. “Acknowledge” means a human-readable receipt with emergency guidance; “assess” means a trained human has reviewed the available context and recorded a safety decision.

| Severity | Test | Acknowledge target | Human assessment / containment target | Escalation |
| --- | --- | --- | --- | --- |
| **S0 Critical** | Immediate or credible imminent danger; active child sexual exploitation; live abduction/assault; specific imminent self-harm or violence | Automated immediately; human within **15 min** | Begin immediately; initial containment and incident-commander page within **15 min** | Incident commander + safeguarding lead; emergency flow; privacy/legal and engineering as needed |
| **S1 High** | Serious but not confirmed imminent: grooming, child abuse, sexual harm, credible threats/stalking, intimate image abuse, repeated evasion, compromised authority account | Immediately; human within **1 h** | Within **4 h** | Safeguarding lead through matrix; second reviewer for restrictions/disclosure |
| **S2 Standard** | Harassment, bullying, discrimination, privacy misuse, impersonation/fraud without an immediate threat, repeated unwanted contact | Within **4 staffed h** | Within **1 staffed day** | Queue lead if target at risk or pattern emerges |
| **S3 Low** | Spam, isolated incivility, off-topic content, unclear non-urgent concern | Within **1 staffed day** | Within **3 staffed days** | Queue lead on repeat/linkage or new risk facts |

Any child involvement, power imbalance (coach/student, club/player, guardian/child), credible off-platform access, prior reports, block evasion, or approaching Class may raise severity. Reassess after every material fact. A timer pauses only in `WAITING_REPORTER` for information genuinely needed to decide a non-urgent matter; safety containment, legal deadlines, and external-notice clocks never pause.

## 4. Critical and immediate-danger flow

For S0, do the following concurrently where safe; do not wait to complete a questionnaire.

1. **Tell the reporter to seek emergency help.** If the danger is in Singapore, say: “Call Police 999 now. If it is unsafe to speak, SMS 70999.” For suspected child/adult abuse, neglect, domestic violence, or sexual harassment, also give NAVH **1800-777-0000** (24 hours). Never guarantee what an authority will do. If the reporter is outside Singapore, direct them to local emergency services.
2. **Ask only safety-critical questions:** whether danger is happening now; the person's location; who is at risk; how the alleged actor can reach them; and whether Police/NAVH has been contacted. Do not conduct an evidential interview or ask a child leading questions.
3. **Page the incident commander and safeguarding lead** through the current [incident ownership matrix](./compliance/INCIDENT_OWNERSHIP.md), declare the general incident severity, and open an incident bridge/private channel. Keep one chat case owner and one chronological log.
4. **Preserve evidence immediately** before content/account action. Preserve message and thread IDs, exact server records, membership/booking context, relevant login/session and change logs, report metadata, and linked prior cases.
5. **Apply the least harmful effective containment** available: prevent new ordinary direct contact, revoke sessions for a compromised or dangerous account, restrict the implicated feature/account, and warn an operational club lead only when doing so does not endanger the reporter or child. Do not cancel a Class automatically if that could strand or expose someone; coordinate a safe operational outcome.
6. **Refer or disclose only through the authorised process.** Record who decided, factual basis, recipient, exact fields/files disclosed, transmission method, time, reference number, and follow-up. Preserve a copy of the request and response.
7. **Keep the reporter informed safely** without revealing investigative detail, another person's private information, or action that would create retaliation risk. Set the next check-in.

When contacting emergency services, distinguish observed platform facts from reporter allegations and operator inference. Never delay an urgent call to obtain a perfect export, guardian approval, or second reviewer. Obtain retrospective review as soon as the immediate danger is contained.

## 5. Case lifecycle, ownership, and decisions

Use the following operational states even if the initial case tool represents them as tags:

```text
NEW -> TRIAGED -> IN_REVIEW -> ACTION_PENDING -> RESOLVED -> CLOSED
                    |              |
                    +-> WAITING_REPORTER / WAITING_EXTERNAL
                    +-> REFERRED_TO_AUTHORITY

Any non-terminal state -> MERGED (with destination case ID)
RESOLVED or CLOSED -> REOPENED -> IN_REVIEW
```

- `NEW`: received, receipt recorded, no human classification yet.
- `TRIAGED`: category, severity, child/power factors, deadlines, and owner recorded.
- `IN_REVIEW`: evidence preserved; context, linked reports, and proportional response assessed.
- `ACTION_PENDING`: decision recorded; a technical, club, legal, or communications action remains outstanding.
- `WAITING_REPORTER`: a specific non-urgent question was asked through a safe channel with a follow-up date.
- `WAITING_EXTERNAL`: waiting for club, provider, legal, regulator, or authority; owner and next chase remain mandatory.
- `REFERRED_TO_AUTHORITY`: referral recorded; Courtly still owns platform containment and follow-up.
- `RESOLVED`: immediate actions complete, outcome/reason/review path recorded, monitoring window set if needed.
- `CLOSED`: quality check complete, reporter told what can safely be shared, retention disposition set.
- `MERGED`: immutable pointer to the continuing case; never delete the duplicate intake.
- `REOPENED`: new evidence, recurrence, appeal, or failed control; preserve the prior decision.

Only one current owner is accountable. Club self-assignment is an explicit acceptance and creates an audit entry; unassignment and later self-assignment form the current supported club handover path. It does not reset deadlines. Every material report update requires a non-empty rationale, and every decision must record facts considered, policy/category, proportionality, alternatives, duration, reporter-risk analysis, child considerations, decision-maker, reviewer, and review/expiry date. The platform's free-text assignment remains an operational owner label rather than an authorization identity; the separately authenticated named platform operator is snapshotted on every mutation.

## 6. Reporting, blocking, and mandatory SESSION communications

Keep these controls separate:

- **Report:** sends a specific message/thread/account concern into case triage and preserves the reporter's selected context. It does not itself tell the reported person or decide a breach.
- **Block:** is immediate user-directed contact control. It should prevent new ordinary `ACCOUNT` text/proposal contact between the blocker and blocked account and keep the block private. It does not automatically create a case unless the user also reports, the block-evasion detector fires, or another defined high-risk signal requires review.
- **SESSION operations:** an existing booking can produce mandatory system/lifecycle lines and may require a safe path for cancellation, rescheduling, venue changes, or coach assignment. A person-level block must not silently suppress those system records, change booking/payment state, remove safeguarding evidence, or imply the blocker must receive free-form messages from the blocked person. If participant-generated SESSION text cannot yet be selectively suppressed, flag this product limitation and arrange a club-mediated channel or case-specific restriction.
- **Platform enforcement:** restriction/suspension is a Courtly decision after triage (or emergency containment), not an extension of the reporter's block.

Do not reveal whether someone blocked or reported another user. Do not invite the reported person to rebut before preserving evidence and evaluating retaliation or evidence-destruction risk. Treat attempts to contact through another account, coach assignment, club account, or new conversation as possible block evasion and link them to the original case.

## 7. Reporter privacy and least privilege

- Default the reporter's identity and contact details to **case-team only**. Share with the reported person or club only when necessary, lawful, and assessed for retaliation risk; prefer a factual allegation summary with identifiers redacted. Never promise absolute anonymity because due process or law may require disclosure.
- Show each operator only the minimum messages and surrounding context needed. Avoid browsing unrelated conversations “for completeness.” Bulk exports require recorded purpose and approval.
- Use case IDs in operational chat, not names, usernames, child DOB, message text, or intimate material. Keep evidence in the approved restricted store, not personal downloads, screenshots in general chat, or email attachments.
- Separate roles where practicable: intake may see reporter contact; investigators see evidence; decision-makers see the necessary record; communications staff receive an approved summary. Review access at case closure and revoke temporary access.
- Never send passwords, full card data, government identifiers, or unnecessary sexual/intimate material through the report channel. Where illegal or highly sensitive imagery may be involved, do not duplicate, transform, or hash files casually; escalate through the matrix to the incident commander and legal/regulatory liaison for a controlled preservation method.

## 8. Children, guardians, and trusted adults

Child safety overrides convenience, not evidence or lawful authority. Courtly age policy treats under 13 as `CHILD`, 13–17 as `TEEN`, and 18+ as `ADULT` using the Singapore date. A guardian-managed child has no direct login or chat capability, so a report concerning that child may come from a guardian, club, coach, another participant, or outside channel.

When a child may be involved:

1. raise severity for grooming, sexual content, secrecy, threats, coercion, off-platform contact, coach/guardian power, or a near-term Class; preserve the surrounding conversation and booking/roster context;
2. use plain, age-appropriate language; accept what the child volunteers; do not promise secrecy, ask “why,” press for repeated accounts, seek graphic detail, or conduct a credibility test; record their words as accurately as possible;
3. do not assume the reporter is an authorised guardian. Verify any requested account action against the live `GuardianChildLink` and exact permission; never rely only on a supplied child ID, surname, email, `parentName`, or a club-local student record;
4. do not automatically notify a guardian when the guardian may be implicated, notification may increase danger, the young person has a competing safety/privacy interest, or an authority asks Courtly not to. The rostered incident commander decides with safeguarding and legal/regulatory input;
5. do not expose child DOB, exact age, contact details, guardian details, or presence to another user. Give a club only the minimum it needs for immediate supervision or service safety; and
6. for suspected abuse or neglect in Singapore, provide or use NAVH **1800-777-0000** as appropriate; for imminent danger, Police **999** (or SMS **70999** if unsafe to speak). Record referral details without telling the child that a particular outcome is guaranteed.

Guardian consent to account features does not waive a child's safety or privacy, make the guardian a SESSION participant, or authorise unrestricted disclosure of chat or case records. A guardian request to delete or export data does not override an active legal hold or permit destruction of safeguarding evidence; route it through the privacy process and explain only the lawful outcome.

## 9. Evidence preservation, integrity, and access logging

Preservation is a read-only capture, not a content edit. For every S0/S1 case and any case likely to be disputed, referred, or subject to notice:

1. identify the scope before changes: report, message, thread, accounts, memberships, club, booking, proposals, timestamps, relevant session/auth events, and prior linked cases;
2. export through an approved read-only procedure in native structured form where possible. Retain stable IDs, server timestamps, message kind/event, sender ID/role/name snapshot, thread kind, membership/booking context, and database/export version;
3. produce a manifest listing every file/object, query or export method, scope, operator, UTC acquisition time, and source system. Calculate a SHA-256 digest of each exported artifact and the final manifest; store hashes separately from the working copy;
4. seal the original read-only. Analyse a copy. Never “clean up,” annotate inside, rename without mapping, recompress, or convert the only original. Document any unavoidable transformation and hash both versions;
5. log every view, export, disclosure, copy, and deletion with named person, UTC time, case ID, purpose, object scope, and recipient. Review access logs for S0/S1 before closure; and
6. place a legal hold when litigation, Police/regulator contact, an OSC matter, credible threat, child exploitation concern, or preservation request is reasonably anticipated. Confirm scope and custodians, suspend scheduled deletion/anonymisation and conflicting data-subject deletion, and record hold issue/review/release decisions.

A hash demonstrates that the preserved bytes later checked match the captured artifact; it does not by itself prove truth, authorship, completeness, or lawful collection. Keep server records and provenance. Do not access a user's external device/account or solicit material Courtly is not authorised to obtain.

## 10. Account controls: restrict, suspend, restore

The terms describe possible feature restriction, access removal, suspension, or termination, but the general `User.accountStatus` values (`ACTIVE`, `CONSENT_REQUIRED`, and `DELETION_REQUESTED`) are child-policy states—not a general safeguarding suspension system. A named platform operator may apply or restore only the implemented direct-account-chat restriction recorded against a safeguarding case. Restoration is allowed only through the case that owns the active restriction and requires an audited rationale; another active case prevents it. The console does not provide general suspension, termination, or named two-person approval. Do not represent the rest of the control ladder as implemented; escalate to engineering and use only documented reversible containment.

Apply the least restrictive control that adequately reduces risk:

| Control | When appropriate | Required safeguards |
| --- | --- | --- |
| Contact restriction | Risk is limited to free-form contact or one relationship | Preserve evidence; keep mandatory SESSION system communications; test block-evasion paths |
| Feature restriction | Chat/proposals/directory or another feature creates the risk | Scope and duration; explain safe alternatives; verify booking/payment operations remain coherent |
| Temporary account restriction | Urgent containment while facts are reviewed; compromise or serious risk | Revoke active sessions where necessary; time-box; preserve access needed for support/appeal where safe |
| Suspension | Serious or repeated breach, credible safety risk, or required legal action | Second reviewer unless delay would endanger someone; record rationale, scope, notice decision, expiry/review |
| Termination | Sustained unacceptable risk or final serious enforcement | Legal/privacy review; two-person approval; retained-evidence and dependent-booking/payment plan |

For S0 emergency containment, the rostered incident commander—or the safeguarding lead acting under recorded delegated emergency authority—may act immediately and obtain a second-person review within **one hour**. Otherwise require two-person review before suspension/termination, viewing intimate material beyond triage scope, broad export, reporter-identity disclosure, or authority disclosure. The reviewer must inspect the evidence and proportionality—not merely countersign.

Before action, check linked CLUB, COACH, staff, guardian, child, and SESSION relationships. A club account is an institution; disabling it may affect many people. A coach can belong to multiple clubs. A guardian account may control several child identities. Do not silently change a child's guardian link, booking participation, money record, or immutable history as an enforcement shortcut.

Restoration requires evidence that the risk is controlled, not just passage of time. Verify account ownership if compromise is suspected; rotate credentials/revoke old sessions; confirm block and case boundaries; decide which features return; notify only appropriate parties; set a monitoring/review date; and record both approvers. Never erase the report, enforcement event, or evidence on restoration. Appeals go to a reviewer who did not make the original final decision where staffing permits.

## 11. Retention, legal hold, and data disclosure

Maintain an approved retention schedule by record type—chat, report, case notes, evidence exports, access logs, decisions, and authority correspondence. This runbook intentionally does **not** invent fixed deletion periods. The rostered DPO/privacy lead or legal/regulatory liaison must document purpose, lawful basis or exception, minimum necessary period, backup treatment, and deletion/anonymisation method. Review retained S0/S1 and child cases at least annually and remove working duplicates when no longer needed, subject to holds.

Legal hold overrides routine deletion only within its documented scope. Record issuer, reason, systems/people covered, start date, periodic review, and written release. A hold is not permission for unrelated access or indefinite “keep everything.”

For any request from Police, a regulator, court, OSC, lawyer, club, guardian, or other third party:

1. preserve the request and relevant data; verify sender, authority, jurisdiction, scope, deadline, and confidentiality/non-disclosure requirement through an independent official channel;
2. route it through the [incident ownership matrix](./compliance/INCIDENT_OWNERSHIP.md) to the DPO/privacy lead or legal/regulatory liaison; emergency voluntary disclosure still requires incident-commander approval and documented necessity unless delay creates immediate danger;
3. map requested identifiers to Courtly records, reject ambiguity, and disclose the minimum responsive data in a secure, logged transfer;
4. never disclose a reporter's identity, child data, unrelated messages, credentials, or full-account export merely because a club/guardian asks; apply the correct authority and exceptions; and
5. record approval, exact material, redactions, recipient, transfer details, legal basis/instrument, time, and any challenge or follow-up. Notify the user only when lawful and safe.

Potential personal-data breaches are routed immediately to the privacy/security incident process for containment and assessment against PDPA obligations; the safeguarding case does not replace breach assessment or notification.

## 12. OSRAA / Online Safety Commission readiness

Singapore's Online Safety (Relief and Accountability) Act 2025 (OSRAA) and the Online Safety Commission (OSC), operational from **29 June 2026**, create statutory processes for specified online harms. Operational readiness is required even while Courtly obtains advice on whether a particular service, report, notice type, or prescribed-provider obligation applies. This section is not a conclusion that Courtly is a prescribed online service provider or that every chat report falls within OSRAA.

### 12.1 Intake readiness

- Maintain a monitored legal-notice address and use the primary, alternate, and after-hours legal/regulatory route in the [incident ownership matrix](./compliance/INCIDENT_OWNERSHIP.md); train support to recognize OSC/OSRAA correspondence and page that route immediately. Do not leave a notice in the ordinary safeguarding SLA.
- Capture the complete notice, service method, actual receipt time/timezone, notice ID, issuing authority, statutory provision, content/account identifiers, required action, deadline, confidentiality terms, and contact details. Preserve headers/envelope and verify authenticity through published OSC channels.
- Open a linked legal-notice record and safeguarding case where risk is present. Obtain current legal advice on applicability, computation of time, scope, preservation, permissible challenge/review, user notice, and conflicts with another order.
- Preserve responsive data and maintain the ability to locate a thread/message/account by stable identifier, restrict access/content without destroying evidence, produce a reasoned decision, and prove what occurred when.

### 12.2 Clocks and response

The OSRAA notice regulations and prescribed-provider/reporting regulations include specific requirements and, for applicable prescribed providers/notices, short **6-, 24-, or 48-hour** periods. Those statutory periods must be read from the served instrument and current legislation; they are **not** Courtly's internal S0–S3 targets and must never be inferred from the category alone. On receipt:

1. record the legal deadline verbatim and calculate a conservative internal deadline with legal review and engineering margin;
2. page the legal/regulatory liaison, incident commander, and security/engineering lead through the current matrix; assign one accountable notice owner and independent verifier in the linked records;
3. preserve first, then execute only the action actually required across all identified copies/paths; test the outcome from an appropriate user perspective;
4. respond in the prescribed form/channel with the required statements and evidence; keep immutable copies of submission and delivery proof; and
5. continue reporter safety, retention, appeal, and disclosure controls independently of statutory completion. A notice marked “done” is not necessarily a safeguarding case resolved.

The OSC's online-harassment guidance says affected people should first report the harmful content to the platform and preserve evidence because removal may otherwise make later Police or legal action harder. Courtly should make both steps possible: an obvious reporting route, a confirmation/reference, rapid preservation, and a block/contact-control option that does not destroy the source record.

Before launch and quarterly thereafter, counsel or the rostered legal/regulatory liaison must verify Courtly's status against the current Act, prescribed-provider regulations, notice regulations, reports regulations, OSC guidance, and any service changes. Record the review; do not copy a prescribed provider's duty onto Courtly as a factual legal obligation without that analysis.

## 13. Reporter and subject communications

Use neutral, safety-aware wording. Acknowledgements should include case reference, staffed-hours/response expectation, emergency contacts, how to add information safely, and a warning not to send passwords/card data or repeatedly download intimate material. Never promise a particular sanction, confidentiality that cannot be kept, or a deadline controlled by Police, NAVH, a club, or OSC.

Tell the reporter when the case is triaged, when materially delayed, and when Courtly's review closes, but disclose only what is safe and lawful (for example, “we applied measures under our policy,” not another person's private account details). When notifying the reported person, state the rule/factual conduct at a useful level, control and duration, review route, and preservation/non-retaliation expectation. Withhold or delay notice when it could create danger, retaliation, evidence loss, or violate an authority's direction; document why and set a review date.

## 14. Quality, metrics, and oversight

Review weekly operational health and monthly trends without exposing unnecessary message content. At minimum measure:

- report volumes by category/severity/channel, child involvement, repeat subjects, repeat reporters, clubs, and block-evasion linkage;
- p50/p90/p99 human acknowledgement, assessment, containment, resolution, and reporter-update times; target misses and unattended periods must be visible, not averaged away;
- S0/S1 page success, time to the rostered incident commander and safeguarding lead, emergency referrals, OSRAA notice receipt-to-owner and on-time response;
- assignment churn, reopened/appealed cases, decision changes, false merges, duplicate reports, and restoration outcomes;
- action consistency by comparable category/severity, with periodic sampling for under-enforcement, over-enforcement, child handling, bias, and retaliation risk;
- preservation completeness, hash/manifest success, access/export/disclosure logs, legal-hold review, and unauthorised-access events;
- reporter experience, including safe-contact failures and whether reporters received closure; and
- staffing coverage, workload, secondary-review delay, training completion, and operator wellbeing/debrief needs.

Metrics are diagnostics, not quotas. Never reward faster closure, more suspensions, or fewer referrals without quality review. Restrict dashboards to aggregated data; suppress small cohorts where people could be identified.

Sample at least 10% of closed S1 cases (all if volume is low), a risk-based sample of S2/S3, and every S0, authority disclosure, OSRAA notice, termination, and restored suspension. Record corrective actions and owners.

## 15. Drills, escalation, and launch checklist

Run quarterly tabletop drills and an annual end-to-end exercise covering at least:

- imminent child danger during an upcoming Class;
- grooming that shifts from ACCOUNT chat to off-platform contact;
- a user block while mandatory SESSION lifecycle lines continue;
- named-operator credential/session compromise and unauthorized past views;
- an urgent OSC notice with a short statutory clock;
- evidence export/hash failure, legal hold versus deletion request, and a Police disclosure; and
- false-positive suspension, appeal, and safe restoration.

Each drill must use the primary, alternate, and after-hours routes in the [incident ownership matrix](./compliance/INCIDENT_OWNERSHIP.md) and exercise paging (including outside staffed hours if 24/7 is claimed), alternate takeover, reporter communication, evidence manifest, two-person control, product behavior, and closure. Time every handoff. Track findings to an owner and due date; repeat failed steps within 30 days.

Escalate immediately when an SLA will be missed, no trained operator is available, a privileged operator is implicated, evidence integrity is uncertain, a child/guardian conflict exists, a block can be evaded, a mandatory SESSION path exposes free-form contact, an account control causes booking/payment harm, or a legal deadline/authority is unclear. “Need legal advice” does not pause preservation or immediate life-safety action.

Do not claim production readiness until all of the following are evidenced:

- staffed-hours statement and the authoritative on-call matrix match; primary and alternate paging pass a live test;
- reporting and blocking behavior is tested for ACCOUNT and SESSION chats, including system/lifecycle lines and evasion paths;
- secure case store, evidence export, SHA-256 manifest, legal hold, access logging, and restoration procedures work;
- enforcement controls are explicit, reversible where appropriate, session revocation is tested, and two-person review is operable;
- child/guardian escalation, reporter safe-contact, club coordination, Police/NAVH referral, and data disclosure scripts are approved;
- named platform-operator authentication, attributable actions, access review, and an approved break-glass procedure are operational; and
- current OSRAA applicability/deadlines and PDPA retention/disclosure/breach procedures have been reviewed by the responsible legal/privacy owner.

## 16. Official Singapore sources

Always verify the current text and contact details at use time. These links were reviewed for this runbook on 2026-09-29.

- Singapore Police Force, **Contact Us** — Police 999 and Emergency SMS 70999: <https://www.police.gov.sg/contact-us>
- Singapore Police Force, **SMS 70999** — intended for emergencies when it is not safe to talk or the caller cannot speak: <https://www.police.gov.sg/SMS-70999>
- Ministry of Social and Family Development, **Contact Us** — NAVH 1800-777-0000 and 24-hour operating hours: <https://www.msf.gov.sg/contact-us-feedback>
- Ministry of Law, **The Online Safety Commission Begins Operations on 29 June 2026**: <https://www.mlaw.gov.sg/the-online-safety-commission-begins-operations-on-29-june-2026/>
- Singapore Statutes Online, **Online Safety (Relief and Accountability) Act 2025**: <https://sso.agc.gov.sg/Act/OSRAA2025>
- Online Safety Commission, **Frequently Asked Questions**: <https://www.osc.gov.sg/what-you-can-report/frequently-asked-questions/>
- Online Safety Commission, **Online Harassment** — platform-first reporting and evidence-preservation guidance: <https://www.osc.gov.sg/what-you-can-report/online-harassment/>
- Singapore Statutes Online, **Online Safety (Relief and Accountability) (Notices) Regulations 2026**: <https://sso.agc.gov.sg/SL/OSRAA2025-S401-2026>
- Singapore Statutes Online, **Online Safety (Relief and Accountability) (Prescribed Online Service Providers) Regulations 2026**: <https://sso.agc.gov.sg/SL/OSRAA2025-S397-2026>
- Singapore Statutes Online, **Online Safety (Relief and Accountability) (Reports) Regulations 2026**: <https://sso.agc.gov.sg/SL/OSRAA2025-S396-2026>
- Personal Data Protection Commission, **Data protection obligations** — accountability, protection, retention limitation, access/correction, transfer, and breach notification: <https://www.pdpc.gov.sg/dp-obligations>
