# Billing model: invoices, payments and subscriptions

Reference for `prolibu-billing`. Read the section you need.

## Invoice

| Field | What it is |
| --- | --- |
| `invoiceNumber` | `INV-…`. When the account numbers invoices in sequence, the server replaces it right after create with prefix + next number. |
| `title`, `contact` | Required. `company` is filled from the contact. |
| `status` | `draft`, `scheduled`, `open`, `paid`, `void`. Default `draft`. |
| `issueDate`, `dueDate` | Required; issue after due answers 400. |
| `quote` | The invoice's own copy of a quote (`quoteCurrency`, `lineItems`, totals). Recalculated on every save. |
| `balance` | Read only: `quote.total` minus the sum of its payments. |
| `payments` | Read only: ids of its Payment records. |
| `originDeal` | Read only: set only when the invoice was generated from a deal. |
| `subscription` | Read only: set only for subscription instalments. |
| `stage` | Collection pipeline (to collect, in collection, escalated, promise to pay, paid, written off). Owned by `prolibu-stages`; forced to *paid* when the status is paid. |
| `debtRecovery` | Promise-to-pay date, broken promises, escalation and payment contacts. |

### Every save

- `quote` must have at least one line and a total above 0, else 400.
- The quote is recalculated with the account's calculate scripts. After the calculation every
  line loses `pricebookEntry`: invoice lines are always copies, not catalog links.
- Automatic charges of the account (for example a service charge) are **not** added to an
  invoice, unlike `PUT /v2/quote/calculate`. The script's preview drops them for that reason.
- A quote without `quoteCurrency` takes the account currency; lines in another currency are
  converted at the rate of the moment.

### Status rules

- On create, the status is kept as sent and `balance = total`.
- On every later save, the status is derived again: `paid` when the balance is exactly 0, else
  `open`, unless the status is `void` or `scheduled`. So:
  - any edit of a draft turns it `open` (seen live with a title change);
  - `PATCH {status: "paid"}` with a balance above 0 comes back `open` (seen live);
  - removing the last payment of a paid invoice reopens it.
- Fiscal lock: on an `open`, `paid` or `void` invoice, a save that touches `quote`, `issueDate`,
  `dueDate`, `contact`, `invoiceNumber`, `originDeal` or `subscription` answers 400 *An issued
  invoice cannot be financially modified. Void it and issue a new one.* Title, notes, debt
  recovery, assignee and tags stay editable.
- A daily job opens `scheduled` invoices whose issue date has come. Past-dated drafts are not
  opened by anything.

## Generating from a deal

`POST /v2/invoice/generatefromdeal {dealId}` (the app has no button for it):

- 400 when the deal has no contact, its proposal is off, it has no quote, or the total is 0.
- It does **not** check the deal's stage. Won = stage code `deal-stage-approved`; the script
  blocks other stages until the user confirms.
- When the deal has a subscription, it hands over to the subscription calendar (out of scope).
- When invoices with that `originDeal` exist: 400, or with `deleteInvoicesWithOriginDeal: true`
  it deletes all of them, paid ones and their payments included, then generates again. Never
  sent by the script.
- Without a payment plan: one draft, issue date today, due today plus the account's
  `defaultDueDateDays`, title `<Invoice word> - <proposal title>`, the deal's whole quote.
- With a payment plan: one invoice per instalment whose total is above 0. Title from the plan's
  `titleTemplate` (`{{number}}`, `{{proposalTitle}}`) or `<Invoice word> - <title> (<instalment>)`.
  Dates from the instalment (a due date before the issue date becomes the issue date). A future
  issue date makes it `scheduled`.
- Instalment quotes are copied as they are. In real data they carry no `quoteCurrency`, so the
  invoice falls back to the account currency.
- The response is the list of created invoices. The creator becomes the assignee.

## Payments

`POST /v2/invoice/registerpayment {invoiceId, paymentMethod, paidAmount, specialNote?}`:

- 400 unless the invoice is exactly `open`.
- 400 when the amount exceeds the invoice total, or when the payments so far plus this one do.
- Creates a Payment (`PAY-…`) with `paidInvoices: [invoice]` and the invoice's currency (no
  conversion), then saves the invoice so its balance and status are recalculated.
- `paymentMethod`: `Bank Transfer`, `Credit Card`, `Cash`, `Check`, `Other`.
- `paidAmount` must be a number. With text, the server concatenates it with the amounts already
  paid and rejects a valid payment (seen live: a second payment of `"300000"` answered *Existing
  payments exceed invoice total*).
- The balance compares with exactly 0: round to the currency's decimals.
- No date field: the payment's date is its creation time.
- Not atomic: two payments at the same moment can go over the total.

`POST /v2/invoice/removepayment {invoiceId, paymentId}` deletes the Payment **without checking
that it belongs to that invoice**, then recalculates. The script checks it first.

`POST /v2/payment` creates a Payment linked to nothing: no balance changes. `PATCH` on a linked
payment answers 400. Correct a payment by removing it and registering the right one.

## Reading

- A deal's invoices: `GET /v2/invoice?xquery={"originDeal":"<dealId>"}`. `Deal.invoices`
  exists but nothing writes it.
- Filters kept by the server: `originDeal`, `contact`, `status`, `dueDate`, `balance`.
  Filters on `quote.*` are dropped (the call returns everything).
- Two operators on one field (`{"dueDate":{"$gte":A,"$lte":B}}`) keep only one. Use
  `{"$and":[{"dueDate":{"$gte":A}},{"dueDate":{"$lte":B}}]}`.
- Overdue = `status` open, `balance` above 0, `dueDate` before today.
- A payment's invoices: `GET /v2/payment?xquery={"paidInvoices":"<invoiceId>"}`.
- `GET /v2/invoice/metrics?months=<1-36>&from=YYYY-MM`: issued, due, collected, MRR/ARR,
  recognised revenue, top clients and renewals, over every non-void invoice of the account,
  converted to the account currency. It ignores who may see which invoice.

## Subscriptions (read only here)

- `Subscription` holds a contract (`startDate`, `endDate`, `paymentInterval`, `autoRenew`) and a
  calendar of instalments in `payments` (each with `issueDate`, `dueDate`, `quote`, `invoice`).
- Status is derived, not stored: cancelled, pending (starts later), expired, active.
- Creating one from a deal needs the account's subscriptions setting, a won deal and a
  subscription offer in the quote. Generating its invoices and cancelling (irreversible) have
  their own endpoints. None of this is in the skill's first version.
- It is not the account's own Prolibu plan (`SubscriptionPlan`), which is on the never list.

## Payment methods (read only here)

`PaymentMethod` stores a contact's card or bank account at a gateway. Only `gateway`,
`isDefault`, `isVerified` and `active` are read. Card holder, expiry, last digits, bank data and
gateway ids are never read or printed.

## Account settings

- `modules.billing.general.enabled` only shows or hides the Billing menu.
- `modules.billing.invoices.defaultDueDateDays` is used only when generating from a deal.
- `modules.billing.invoices.ascendingDocumentNumber` turns on sequential numbering. Each create
  takes the next number, even a test or a voided invoice.
- These are admin settings in the app; the skill never changes them.

## Nothing reaches the customer

No platform code e-mails an invoice or a payment, and invoices have no public link or payment
link. Internal notifications to users, account webhooks and calculate scripts can run on save.
To write to a client, use `prolibu-messaging`.
