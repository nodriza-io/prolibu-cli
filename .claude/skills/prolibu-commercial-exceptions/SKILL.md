---
name: prolibu-commercial-exceptions
description: Handle Prolibu commercial exceptions and product rules the way the app does — find every product rule that blocks a deal's quote (the server only reports the first), ask a manager for an exception on one line and one field, edit or withdraw your own pending request, approve as asked, approve another value or reject, check whether an approval reached the quote, and create or edit product rules (limits, locked fields) with checks the server skips. Use it whenever someone cannot save a quote because of a rule ("no puede ser superior a", "está bloqueado", "viola la regla de la excepción comercial", "La excepción comercial no está aprobada"), wants a discount, price or quantity beyond what a product allows, has exceptions to approve or reject, says an approved exception did not show up in the quote, or wants to create or change a product rule. Spanish triggers: "excepción comercial", "solicitar excepción", "aprobar excepción", "regla de producto", "descuento máximo", "fuera de la regla".
---

# Prolibu Commercial Exceptions

## Central idea

A **product rule** limits the lines of a quote: minimum and maximum values (quantity, price,
discount rate, payments…), fields locked to the catalog value, products that must or must not
be in the same quote. Rules sit on a product or on a price-list entry; an entry's rules
replace the product's. Every quote save and calculation checks the live rules and stops at the
first broken one.

A **commercial exception** lets one line break one rule. A seller asks (a request with a
justification and an approver); a manager approves, approves another value, or rejects. An
approval **pins** the line: the field must then hold exactly the approved value, and any later
change to it needs a new request. The platform writes the approval into the quote itself; when
it cannot (line not saved, proposal off, closed stage), the request still reads "Approved".

`scripts/exception.js` does the fragile parts in code: it checks the rules on the values the
server calculates (a discount rate becomes a discount amount before the check), lists every
violation, refuses requests the platform would accept but never apply, validates rule values
the server does not, and reads every write back. Your job is the conversation: agree the deal,
line, field, value and people with the user, show the preview, and write only after a clear yes.

```
node .claude/skills/prolibu-commercial-exceptions/scripts/exception.js <command> <domain> …
  deals           <domain> <part of the deal name>
  diagnose        <domain> <dealId> [--try '[{"uuid":"…","discountRate":0.18}]']
  requests        <domain> [--deal <id>] [--status Pending] [--mine] [--to-me]
  approvers       <domain> <dealId>
  request-preview <domain> '<plan>'  →  request  … --version <v> --confirmed --reaches-people
  edit-preview    <domain> '<plan>'  →  edit     … --version <v> --confirmed --reaches-people
  cancel-preview  <domain> '<plan>'  →  cancel   … --version <v> --confirmed --reaches-people
  decide-preview  <domain> '<plan>'  →  decide   … --version <v> --confirmed --reaches-people [--self-approval]
  rules           <domain> [<term>]
  rule            <domain> <ruleId|ruleCode>
  rule-preview    <domain> '<plan>'  →  rule-apply … --version <v> --confirmed
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written). Every command takes `--profile <name>` when the user picks one.

## Ask the user first

In plain business terms:

1. **Which deal, which product line, which field and which value?** Rates are decimals:
   18% is `0.18`.
2. **For a request:** the justification (required, the approver reads it) and who approves
   (pick from `approvers`). Say that the approver gets a platform notice and an e-mail.
3. **For a decision:** approve as asked, approve another value, or reject. A rejection needs
   the reason the seller will read.
4. **For a rule:** its name, which limits or locks, and which products it will go on.

If `accounts/` has several domains, ask which one.

## Steps

1. **Find the deal.** `deals <domain> "<name>"`; if several match, ask.
2. **Diagnose.** `diagnose <domain> <dealId>`. To see why a change fails before saving it,
   add `--try` with the line edits. Explain each `violation` with its `message`: line, field,
   limit, value. `server` is the platform's own first error. `requests` shows earlier requests
   and whether each approval reached the quote (`appliedIn`, `notInQuote`).
3. **Plan the write.** One plan per command:

   | Command | Plan |
   | --- | --- |
   | request | `{"dealId","uuid","field","value","justification","approver"}` (approver: `_id` or e-mail) |
   | edit | `{"id","value"?,"justification"?,"approver"?}` (only your own pending request) |
   | cancel | `{"id"}` (only your own pending request) |
   | decide | `{"id","decision":"approve"\|"reject","approvedValue"?,"comment"?}` |
   | rule | `{"rule"?: "<id or code>", "set": {…}}` (no `rule` creates one) |

   Rule fields: `productRuleName`, `productRuleCode` (create only), `lockedFields`
   (`{"price": true}`), `min`/`max` + `Quantity`, `Price`, `DiscountRate`, `UnitMultiplier`,
   `NumberOfPayments`, `UpfrontPaymentRate`, `MarkupRate`, and `mustIncludeProducts` /
   `mustExcludeProducts` (product ids or codes). `null` removes a limit from an existing rule.
4. **Preview.** Run the `-preview` command. Tell the user what changes, who is told
   (`reachesPeople`), every `warning`, and for a decision whether the value will reach the
   quote and the new total (`reachesQuote`). If there are `blockers`, explain them and stop.
5. **Wait for an explicit yes** to exactly that, including who gets notified. A self-approval
   (`selfApproval: true`) needs the user to confirm it knowing the platform allows it only
   because the key is an admin's.
6. **Write.** Run the write command with the preview's `version`, `--confirmed` and, for
   requests and decisions, `--reaches-people` (plus `--self-approval` when flagged). It
   refuses when anything changed since the preview: preview again and show the user.
7. **Report.** The request's status; for an approval, `inQuote.applied` and the line value;
   for a rule, the saved limits. A new rule does nothing until attached with `prolibu-catalog`.

## How the platform behaves

Details and evidence are in `references/exceptions-model.md`. Read it when a case falls
outside the steps.

- **The server reports one violation at a time.** `diagnose` lists all of them. When the
  server refuses the quote, the other lines are checked on their stored values (see `notes`):
  trust `server.message` for the first one.
- **Rules check calculated values.** A discount rate on a line whose discount amount is locked
  breaks the lock, not a rate limit. `request-preview` says which field to ask for.
- **An approval is a pin, not a new limit.** Moving the field back within the normal limits
  also fails; that needs a new request.
- **An approval may not reach the quote.** It is written only when the line is in the saved
  quote, the proposal is on and the deal is not in a closed stage. Otherwise it stays
  "Approved" with no effect. The script blocks such requests and warns before such decisions.
- **One pending request per line and field.** Edit it instead of asking again.
- **Who decides.** Anyone with the decide permission in the deal's workspace, or any admin. The
  named approver is only who gets notified. Nobody may decide on their own request or deal,
  except an admin.
- **Price limits compare the list price, not the price after discount.** To bound discounts
  use `maxDiscountRate`.
- **The server accepts broken rules:** min above max, negative values, rates above 1. The
  script refuses them. A `min` on a field a line lacks (markup, upfront payment) refuses the
  line; a `max` on it never triggers.
- **Changing a rule re-checks every open quote** with those products on its next save.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| "'discountRate' no puede ser superior a 0.1…" | A max limit | `diagnose`, then request an exception |
| "El campo de 'discountAmount' está bloqueado…" after setting a discount rate | The rate becomes an amount; the amount is locked | Request on `discountAmount` |
| "El valor proporcionado viola la regla de la excepción comercial…" | The field is pinned by an approval | Keep the approved value, or ask again |
| "La excepción comercial no está aprobada." | The quote points to a pending, rejected or withdrawn exception | A manager fixes it in the app |
| Approved, but the quote did not change | Line not saved, proposal off, or closed stage | `requests` shows `notInQuote`; save the line and ask again |
| A minimum price is not enforced with a big discount | Price limits ignore discounts | Add `maxDiscountRate` |
| A seller sees exceptions of deals they cannot open | Approvers see every exception with no workspace | Explain it; `prolibu-access-review` shows why |

## Verify

- Request, edit and cancel read the record back: status `Pending` or `Cancelled`, new values.
- `decide` reads the request and the deal back: `inQuote.applied` true means the line holds
  the approved value and the quote points to the new exception.
- `rule-apply` reads the rule back and lists any field that did not save.

## Don't

- Delete an exception, or unlock a line or the whole deal without a request. Those are the
  manager's tools in the app.
- Change quote lines here: that is `prolibu-quotes` (it keeps the exception pointer intact).
- Attach a rule to a product or price-list entry here: that is `prolibu-catalog`.
- Send a request on a line the user has not saved yet.
- Write rates as percentages (`18` instead of `0.18`).
- Retry a 403 with another profile: the user lacks the permission.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. Each `-preview` is the summary step. For
how objects relate, see `prolibu-platform-map`.
