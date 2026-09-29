# Seller, agent, and GST decision record

Status: `BLOCKED` until completed and approved

Decision date: `TBD`

Effective date: `TBD`

Finance owner: `TBD`

Legal/tax reviewer: `TBD`

This template records commercial and tax conclusions for Courtly's actual
contracts and flows. It is not legal or tax advice. Product vocabulary such as
`CLUB`, `paymentRoute`, “platform,” “connected account,” or “payout” does not
determine who legally makes a supply, acts as agent, issues an invoice, or must
account for GST. Stripe configuration does not decide those questions either.

## Current engineering facts to verify

- New Classes, packages, and rentals belong to a club. New booking snapshots
  use `paymentRoute: CLUB`.
- In Stripe mode, package and Class PaymentIntents are created in the club's
  connected-account context. Courtly does not currently add an application fee.
- Rental checkout is currently simulated. Club-to-coach payouts are manually
  recorded ledger entries, not automated settlement.
- Public amounts are club-entered integer minor units and rendered in SGD. A
  club can now self-declare its legal name, registration number, support email
  and address, GST registration status and number, and (when it declares that
  it is GST registered) whether displayed prices include GST. Live checkout is
  gated on the required declarations. Courtly does not verify those entries,
  determine the legal seller or GST treatment from them, or calculate/store a
  tax rate or tax amount.
- Those facts are implementation observations only. Finance must reconcile
  them to contracts, money movement, refunds, invoices, customer support, and
  accounting before adopting a conclusion.
- Production live Stripe is independently fail-closed unless
  `PAYMENT_COMMERCIAL_APPROVED_VERSION` equals the current checkout-policy
  version. Set it only after this record is complete and signed; changing legal
  publication settings does not satisfy this gate.

## Decision sequence

Complete this sequence for each row in the transaction matrix. Attach sources
and advice rather than answering from a product label.

1. Identify every party: customer, service-performing club, coach, venue,
   platform operator, payment provider, and any other contracting entity.
2. Identify what each party supplies and to whom. Separate the underlying
   coaching/rental/package supply, platform service, payment service, and any
   fee.
3. Record the contract and checkout representation: who makes the offer, sets
   price and terms, accepts the booking, bears performance/refund risk, handles
   complaints, and appears on the receipt or invoice.
4. Decide whether Courtly acts as principal, disclosed agent, undisclosed
   agent, marketplace operator under a specific rule, or only a software
   provider. Cite the exact facts and reviewed authority.
5. Identify the supplier for GST, place/time/value of supply, registration
   status and liability, rate/treatment, invoice issuer, and record keeper.
6. Decide the public price presentation and checkout total. Include every
   unavoidable tax, surcharge, service fee, and booking fee in the headline
   total or disclose a genuinely incalculable charge prominently.
7. Reconcile payment settlement, refunds, disputes, chargebacks, credits,
   discounts, coach payouts, and accounting entries with the conclusion.
8. Obtain approval, implement, test, and store evidence. Any changed fact
   invalidates the decision until it is re-reviewed.

## Transaction matrix

Duplicate rows if different club types or contract variants produce different
answers. `TBD` means the flow must not take live customer money.

| Flow | Customer | Performer / fulfiller | Contracting seller | Courtly capacity | Supplier(s) for GST | Who sets final price | Who receives funds first | Who issues receipt / tax invoice | Refund / complaint owner | GST treatment and inclusive display | Evidence and approval | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Single Class | Student/guardian (`TBD` contractual payer rules) | Club and roster coach (`TBD` allocation) | `TBD` | `TBD` | `TBD` | Club in product; verify contract | Club connected account in current Stripe design | `TBD` | `TBD` | `TBD` | `TBD` | `BLOCKED` |
| Finite Class series | Student/guardian (`TBD`) | Club and roster coach | `TBD` | `TBD` | `TBD` | Club in product | Club connected account in current Stripe design | `TBD` | `TBD` | `TBD` | `TBD` | `BLOCKED` |
| Class package | Student | Club / eligible coaches | `TBD` | `TBD` | `TBD`; assess voucher/credit character with adviser | Club in product | Club connected account in current Stripe design | `TBD` | `TBD` | `TBD` | `TBD` | `BLOCKED` |
| Rental package | Student | Club / venue | `TBD` | `TBD` | `TBD`; assess voucher/credit character with adviser | Club in product | Simulated only today; live design `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `BLOCKED` |
| Venue rental | Student | Club / venue | `TBD` | `TBD` | `TBD` | Club in product | Simulated only today; live design `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `BLOCKED` |
| Platform fee or subscription | Club / other party (`TBD`) | Courtly operator | `TBD` | `TBD`; determine capacity if implemented | `TBD` | Not implemented | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` | `BLOCKED` |
| Club-to-coach payout | Club | Coach | `TBD` | Ledger software only in current product; verify | `TBD` | Parties outside product contract | Club; payout is recorded manually | `TBD` | Club | `TBD` | `TBD` | `BLOCKED` |
| Refund / chargeback | Original customer and seller | Original supplier | Follow approved original-flow decision | `TBD` | Credit-note/adjustment owner `TBD` | Original price | Provider/account per approved flow | `TBD` | `TBD` | `TBD` | `TBD` | `BLOCKED` |

## Per-club seller onboarding record

Where the product contains a corresponding field, its value is a club-supplied
declaration used for checkout display and gating; it is not verification. Do
not treat a registration number, Stripe account, or checkbox alone as evidence
of GST status or seller authority. Record independent evidence and the wider
onboarding review below.

| Field | Recorded value | Evidence | Verified by/date | Expiry/recheck |
| --- | --- | --- | --- | --- |
| Registered entity name | `TBD` | `TBD` | `TBD` | `TBD` |
| Trading name | `TBD` | `TBD` | `TBD` | `TBD` |
| UEN / entity type | `TBD` | `TBD` | `TBD` | `TBD` |
| Registered/business address | `TBD` | `TBD` | `TBD` | `TBD` |
| Contract signer and authority | `TBD` | `TBD` | `TBD` | `TBD` |
| GST registration status and effective date | `TBD` | IRAS evidence `TBD` | `TBD` | Monthly threshold monitor |
| GST registration number if applicable | `TBD` | `TBD` | `TBD` | `TBD` |
| Approved price-display wording | `TBD` | Legal/Finance approval `TBD` | `TBD` | On status/rate change |
| Receipt/tax-invoice issuer and sequence | `TBD` | Sample document `TBD` | `TBD` | Annual |
| Stripe account legal entity and settlement currency | `TBD` | Provider record `TBD` | `TBD` | On account change |
| Refund, complaint, and chargeback owner | `TBD` | Contract/runbook `TBD` | `TBD` | Annual |

## Implementation acceptance checklist

- [ ] Terms, booking page, checkout review, payment descriptor, receipt, and
      refund copy name the same approved parties and roles.
- [ ] Public price is the final unavoidable amount; GST-inclusive treatment or
      non-registration wording follows the approved seller-specific decision.
- [ ] Server-calculated total, currency, tax treatment, and item description
      are snapshotted and cannot be changed by the browser.
- [ ] Receipt/tax-invoice fields and numbering meet the approved requirements.
- [ ] Refund, cancellation, partial payment, package credit, discount, and
      chargeback examples reconcile to the ledger and GST decision.
- [ ] Supplier registration status is rechecked before a status/rate effective
      date and when turnover monitoring escalates.
- [ ] Test/live provider accounts map to the verified seller; no shared or
      ambiguous connected-account ID is used.
- [ ] Finance has tested reporting and record retention against sample flows.
- [ ] Legal/tax reviewer and accountable executive signed the dated decision.
- [ ] The approved version was recorded in
      `PAYMENT_COMMERCIAL_APPROVED_VERSION` only after every applicable row was
      unblocked; rollback removes or changes that value before traffic resumes.

## Authoritative starting points

- IRAS, [GST registration liability](https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/gst-registration-deregistration/do-i-need-to-register-for-gst)
- IRAS, [displaying and quoting prices](https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/basics-of-gst/invoicing-price-display-and-record-keeping/displaying-and-quoting-prices)
- IRAS, [invoicing customers](https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/basics-of-gst/invoicing-price-display-and-record-keeping/invoicing-customers)
- IRAS, [GST and e-commerce](https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/specific-business-sectors/e-commerce)
- IRAS, [recovering expenses: reimbursement and disbursement](https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/charging-gst-(output-tax)/common-scenarios---do-i-charge-gst/recovering-expenses-(re-billing))
- CCCS, [Guidelines on Price Transparency](https://www.cccs.gov.sg/legislation/consumer-protection-fair-trading-act/price-transparency-guidelines)
