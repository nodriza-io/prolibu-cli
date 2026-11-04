# Commercial exceptions and product rules: how the platform behaves

Verified against the server code and a non-production account. Read it when a case falls
outside the steps in `SKILL.md`.

## ProductRule (`/v2/productrule`, primary key `productRuleCode`)

| Field | Meaning |
| --- | --- |
| `productRuleName` | Required. |
| `productRuleCode` | Unique; the server makes one (`prule…`) when absent. |
| `lockedFields.<field>` | `true` = the line must keep the catalog value. `productName`, `description`, `quantity`, `unitMultiplier`, `numberOfPayments` and `contentBlocks` compare with the product; `upfrontPaymentRate`, `currency`, `cost`, `price`, `taxes`, `discountAmount`, `startDate` and `endDate` with the price-list entry. There is no `discountRate` lock: lock `discountAmount`, or set `maxDiscountRate` to 0. |
| `min…` / `max…` | `Quantity`, `Price`, `DiscountRate`, `UnitMultiplier`, `NumberOfPayments`, `UpfrontPaymentRate`, `MarkupRate`. Rates are decimals. |
| `mustIncludeProducts` / `mustExcludeProducts` | Products that must, or must not, be in the same quote. |

- Rules live on `Product.rules` and `PricebookEntry.rules`. An entry with rules replaces the
  product's rules; an entry without rules uses the product's.
- The server validates nothing on save: min above max, negative values and rates above 1 are
  stored. The script refuses them.
- `PATCH` with a limit set to `null` removes that limit. `PATCH` of `lockedFields` merges the
  keys sent with the stored ones; send `false` to unlock.
- Deleting a rule leaves its id on products and entries (no clean-up). Not done by this skill.

## How a quote is checked

Every quote calculation and deal save:

1. Calculates the lines first (a discount rate becomes a discount amount, markup is derived),
   then checks the rules on those calculated values.
2. Reads the exception the quote points to (`quote.commercialException._id`). A pointer to a
   pending, rejected or withdrawn exception fails the whole quote ("La excepción comercial no
   está aprobada."). An approved one with an empty list lifts every rule of the deal.
3. For each line uses the live rules (not the snapshot stored on the line) and throws at the
   first violation. The message is translated and carries no structured details.

Checks per rule, in order: locked fields, then each `min`/`max` key, then include/exclude.

- `min…` on a field the line does not carry answers "Cannot validate field against product
  rule"; `max…` on a missing field passes.
- `minPrice` / `maxPrice` compare the line's list `price`, not the price after discount. A
  seller can go under a minimum price with a discount unless `maxDiscountRate` is also set.
- An exception rule for a line + field skips the check when it has no `value` (the field is
  free), or requires the line to hold exactly that value (the field is pinned).

`diagnose` runs the same checks locally on every line. When the server accepts the quote, it
checks the server's calculated values. When the server stops at a broken rule, it keeps that
message and checks the other lines on their stored values, turning a discount rate into an
amount (and back) itself; other derived values, such as markup, may then differ from the
server's.

## CommercialException (`/v2/commercialexception`)

| Field | Notes |
| --- | --- |
| `deal` | Required. The workspace is copied from the deal. |
| `requestType` | `Request` (a seller asks) or `Direct` (a manager unlocks; the default). |
| `status` | `Pending`, `Approved`, `Rejected`, `Cancelled`, `Superseded`. Quotes honor `Approved` and `Superseded`. |
| `ignoreProductRules` | `[{uuid, rules: [{field, value, originalValue, requestedValue}]}]`. `uuid` is the quote line's. |
| `justification` | Required on a request, up to 2000 characters. |
| `approver` | Required on a request: a decider in the deal's workspace or an active admin. Only this person is notified. |
| `decisionComment` | Required to reject. |
| `appliedIn` | Set by the platform when the approval was written into the quote. |

### Request

- `POST` with `requestType: "Request"`, exactly one line and one field, and a `value`.
  `originalValue` is what the approver sees as "current" and what a cloned deal is reset to;
  the server does not check it. The app sends the value of an already-approved rule for that
  field, else the line's current value; so does the script.
- The requester must be an admin, or in the deal's scope and its owner, collaborator, or
  allowed to edit deals there (403 otherwise).
- One pending request per deal + line + field (400 with `details.pendingId`).
- A request on a line that is not in the saved quote is accepted and can be approved, but
  nothing is written (`lineMissing`). The script blocks it.
- The approver gets a platform notice and an e-mail whatever their settings. The platform
  drops a notice whose author is the recipient.

### Edit and withdraw

- `PUT /v2/commercialexception/editRequest {id, value?, justification?, approver?}`: creator
  only, pending only; the line and the field do not change. The approver is notified again,
  with e-mail.
- `PUT /v2/commercialexception/cancel {id}`: creator only, pending only. The approver is
  notified by their settings.

### Decide

- `PATCH /v2/commercialexception/<id> {status, decisionComment?, approvedValue?}`. Any other
  changed field answers 400. Only `Pending` → `Approved` or `Rejected`.
- Who: an admin, or a user with the decide permission whose workspaces include the deal's (or
  any, when the deal has none), who did not create the request and does not own the deal.
  **Admins skip every check, including deciding on their own deal.**
- `approvedValue` (a counteroffer) is stored as the rule's `value`; the asked value moves to
  `requestedValue`. Numbers must be ≥ 0, a discount rate ≤ 1. It is not checked against the
  rule.
- On approval the platform creates a new `Direct` exception (the current one plus this rule),
  writes the value into the line (a discount travels as a pair: the other half becomes 0),
  points the quote to it and saves the deal through its normal hooks (recalculation, deal
  scripts and webhooks). The previous approved exception becomes `Superseded`, and
  `appliedIn` is set.
- If the deal refuses the save (closed stage, another rule still broken), the new `Direct`
  exception is set `Cancelled` with "apply failed: …", and the request stays `Approved`
  without `appliedIn`.
- The requester and the deal owner get a notice (platform, e-mail, pop-up by their settings)
  saying whether the approval was applied.

### Things this skill leaves to the app

- **Direct unlock** (a manager frees a field, a line or the whole deal without a request): it
  needs a new exception plus a quote save that changes the pointer.
- **Delete**: allowed to managers by the API, but deleting the exception a quote points to
  makes the next save drop the pointer and keep the excepted values, so the save then fails a
  rule.

## Quote saves and approvals

- A quote editor opened before an approval and saved afterwards with the old pointer answers
  409 (`staleQuote`). `prolibu-quotes` handles it by previewing again.
- Approvals of one deal are applied one after the other inside one server process only.
