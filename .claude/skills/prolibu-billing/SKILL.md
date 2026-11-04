---
name: prolibu-billing
description: Read and write Prolibu billing the way the platform expects it — list a deal's or a client's invoices, show one invoice with its payments and balance, see who owes what and what is overdue per currency, read billing metrics; create invoices from a won deal or from catalog lines, record or remove payments one invoice at a time, emit drafts and void invoices, each after a preview and a clear yes. Use it whenever someone asks to invoice a deal, register a payment or an instalment, split one payment over several invoices, check receivables or overdue invoices, void an invoice, or reports a payment that did not change the balance, a 400 when generating invoices again, or invoices in the wrong currency. Spanish triggers: "factura", "facturar el negocio", "registrar un pago", "abono", "cartera", "facturas vencidas", "cuánto nos debe", "anular la factura".
---

# Prolibu Billing

## Central idea

An invoice is a fiscal document with its own copy of a quote. Its `balance` is the total minus
its payments, and the server derives its status from that: `paid` only comes from payments
that bring the balance to exactly 0. Once emitted (`open`), its amounts, dates and contact are
locked; a mistake is fixed by voiding it and issuing a new one, never by deleting.

`scripts/billing.js` does the fragile parts in code: it checks the deal and its existing
invoices before generating, replays what the server will create, records one payment per
invoice with numeric amounts never above the balance, refuses to delete or regenerate, and
reads everything back. Your job is the conversation: which deal, invoice, amount and method,
show the preview, and write only after a clear yes.

```
node .claude/skills/prolibu-billing/scripts/billing.js <command> <domain> …
  invoices        <domain> [--deal <id>] [--contact <id>] [--status <s>] [--limit <n>]
  show            <domain> <invoiceNumber|_id>        invoice, lines, payments, balance
  receivables     <domain> [--as-of YYYY-MM-DD] [--contact <id>]
  metrics         <domain> [--months <1-36>] [--from YYYY-MM]
  subscriptions   <domain> [<subscriptionCode|_id>]   read only
  payment-methods <domain> <contactId>                read only, no card or bank data
  preview         <domain> '<plan json>'              writes nothing; returns a version
  apply           <domain> '<plan json>' --version <v> --confirmed
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written). Nothing in billing e-mails or notifies customers.

## Ask the user first

In plain business terms:

1. **Which deal, client or invoice?** A deal name, an invoice number (`INV-…`) or the
   client is enough; you look up the ids.
2. **From a deal: is it really won?** The server does not check. If it is not in the won stage,
   ask before going on.
3. **By hand: which products, quantities, currency, issue and due dates**, and whether to
   leave it as a draft or emit it now.
4. **A payment: amount, method, the date it was received, and a note.** Methods: Bank
   Transfer, Credit Card, Cash, Check, Other. If it covers several invoices, how to split it
   (propose the oldest due date first, never above a balance).

If `accounts/` has several domains, ask which one.

## Steps

1. **Read.** Find the deal with `prolibu-quotes` (`quote.js deals`), then
   `invoices <domain> --deal <dealId>`; or `show <domain> <INV-…>`; or
   `invoices <domain> --contact <id>`. Use `receivables` for "who owes what" and
   "what is overdue", and `metrics` for issued, collected and recurring revenue.
2. **Plan.** One `kind` per plan:

   ```json
   {"kind": "fromDeal", "dealId": "<id>"}
   {"kind": "manual", "contactId": "<id>", "title": "…", "issueDate": "2026-11-03",
    "dueDate": "2026-12-03", "currency": "COP", "emit": false,
    "lines": [{"pricebookEntryId": "<id>", "quantity": 2, "discountRate": 0.1}]}
   {"kind": "pay", "payments": [{"invoice": "INV-…", "amount": 600000,
    "method": "Bank Transfer", "date": "2026-10-28", "note": "…"}]}
   {"kind": "unpay", "invoice": "INV-…", "paymentId": "<payment _id from show>"}
   {"kind": "emit", "invoice": "INV-…"}
   {"kind": "void", "invoice": "INV-…"}
   ```

   - `pricebookEntryId` comes from `quote.js search <domain> "<term>" --pricebook <id>`.
   - `amount` is a number in the invoice's currency, rounded to 2 decimals at most.
   - Add `"notWonConfirmed": true` to `fromDeal` only after the user said yes to invoicing a
     deal that is not won.
3. **Preview.** Run `preview <domain> '<plan json>'`. Tell the user what will be created or
   changed: the invoices with title, dates, status, currency and total; or each payment with
   the balance before and after. Repeat every `warning` in plain words. If there are
   `blockers`, explain them and stop.
4. **Wait for an explicit yes.** Removing a payment and voiding each need their own yes.
5. **Write.** Run `apply` with the same plan, `--version <version from preview>` and
   `--confirmed`. It refuses when anything changed since the preview: preview again.
6. **Report.** Give the invoice numbers, statuses and balances that `apply` read back. On
   `problems`, show them; say which payments were recorded before a failure.

## How the platform behaves

Details and evidence are in `references/billing-model.md`. Read it for cases outside the steps.

- **Generating from a deal happens once.** A second generate answers 400 *Invoices with the
  same origin deal already exist*. The server's `deleteInvoicesWithOriginDeal` option deletes
  every invoice of the deal, paid ones and their payments included: the script never sends it.
- **The deal's payment plan makes one invoice per instalment.** Future instalments are born
  `scheduled` and open by themselves on their date. Instalments usually carry no currency, so
  the server quotes them in the account currency; the preview warns when that differs.
- **Invoices are born as drafts, and drafts do not survive an edit.** Any later change, even
  the title, turns a draft into `open`. Emit on purpose, with `emit`. Wrong dates or amounts on a
  draft are not edited: void it and create the right one by hand (each with its own yes).
- **Paid cannot be set by hand.** A `PATCH` with status `paid` comes back `open`. Record the
  payments instead.
- **Payments go only on open invoices, one invoice per payment.** A payment that covers several
  invoices becomes several payments. There is no payment-date field: the platform dates it
  today, so the real date goes into the note (the script writes it there).
- **Amounts must be numbers.** A text amount makes the server add it as text and reject a
  valid payment.
- **Deal invoices are found by `originDeal`.** `Deal.invoices` is never filled, and invoices
  made by hand are never linked to a deal.
- **Filters.** Two operators on one field in one object keep only one (`dueDate` with `$gte`
  and `$lte` silently drops one): use `$and`. Filters on `quote.*` are dropped and return
  everything: never filter on them; `receivables` groups currencies in code.
- **Fiscal numbering.** When the account numbers invoices in sequence, every create takes the
  next number for good, voided or not. The preview says so.
- **Billing can be off in the menu** while the API works. The preview says so; turning it on
  is an admin setting in the app.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| 400 "Invoices with the same origin deal already exist" | The deal was invoiced already | `invoices --deal`; void and create by hand if one is wrong |
| 400 "Invoice status must be open to add payment" | Draft, scheduled, paid or void | Emit a draft first (own yes) |
| 400 "Existing payments exceed invoice total" on a valid amount | Amount sent as text | Send a number (the script does) |
| A payment that changed no balance | Created with `POST /v2/payment` | Remove it; use `pay` |
| A draft became open after an edit | Any edit of a draft emits it | Expected; void if it was not meant |
| 400 "An issued invoice cannot be financially modified" | Amounts, dates or contact of an open invoice | Void it and issue a new one |
| Instalment invoices in the wrong currency | Plan entries without a currency | Tell the user before generating; fix the plan in the quote |
| The deal shows no invoices | `Deal.invoices` is never filled | `invoices --deal <id>` |

## Verify

- `apply` reads back every invoice it touched: count, status, total and balance must match the
  preview. Give the user the invoice numbers and the balances it returned.

## Don't

- Delete invoices or payments by hand, or send `deleteInvoicesWithOriginDeal`.
- Create payments with `POST /v2/payment` or edit them with `PATCH`: correct with `unpay` + `pay`.
- Set `status: "paid"`, or move an invoice back to `scheduled` or `draft` to edit it.
- Add amounts of different currencies together.
- Write subscriptions or payment methods, or print card, bank or gateway fields.
- Promise to e-mail an invoice or a payment link: the platform has neither. To write to the
  client, use `prolibu-messaging` with its own preview and yes.
- Move an invoice through its collection stages here: that is `prolibu-stages`.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step and `apply`
the write. A `403` means the profile's user may not do this (a user without a billing role
gets it on every invoice read): stop and say so, never retry it another way or with another
profile. The deal's quote and payment plan belong to `prolibu-quotes`. For how objects
relate, see `prolibu-platform-map`.
