# Payment receipts

Courtly issues a durable payment receipt after a verified Stripe success for a
Package or Class checkout. It does not issue a receipt for a failed or pending
attempt, package-credit use, an offline ledger entry, or a simulated payment.
Rentals remain simulated and are outside this receipt flow.

## Document contract

Each receipt has a unique immutable number (`RCT-YYYYMMDD-…`) and snapshots the
exact merchant, purchaser, item, platform-role, cancellation, policy, amount,
currency, and review-hash facts accepted for that checkout. It stores no card
number, CVC, client secret, or raw provider payload. A database trigger makes
the issued document immutable, while a deferred constraint verifies that it
matches the successful checkout and its single student-payment ledger row.
Direct deletion and truncation are rejected. An explicit owning payment,
checkout, or whole-business teardown may cascade the receipt as part of the
same deletion lifecycle; application cleanup must never delete a receipt on
its own.

The document is deliberately titled **Payment receipt**, never **Tax invoice**.
It shows club declarations as supplied at checkout and explicitly states that
Courtly does not use the receipt to decide the unresolved contracting seller,
supplier, payment-recipient, refund-owner, or GST-supplier roles. A future tax
invoice may be generated only after those facts and required invoice fields are
approved; existing receipt snapshots must not be rewritten.

Refund status is live derived state. The original issued snapshot stays fixed;
the API reads linked `PaymentRefund` results and the ledger reversal to return
`NONE`, `PENDING`, `PARTIALLY_REFUNDED`, `REFUNDED`, `FAILED`, or `CANCELLED`.

## Access and delivery

An authenticated student can list only receipts whose `userId` is their own,
read one receipt, or open/download its printable HTML document through:

- `GET /api/payments/receipts`
- `GET /api/payments/receipts/:id`
- `GET /api/payments/receipts/:id/document`
- `GET /api/payments/receipts/:id/document?download=1`

The Profile screen exposes View and Download actions. When transactional email
is configured, live fulfillment queues one `PAYMENT_RECEIPT` outbox event in
the same transaction, using `payment-receipt:<receipt-id>` as its dedupe key.
Normal transactional preferences and hard suppression apply. The email links
to the authenticated document endpoint and contains no card data.
