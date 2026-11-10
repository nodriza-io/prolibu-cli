# Quote model: how the platform stores and prices a quote

Reference for `prolibu-quotes` and `prolibu-extended-quote-sites`. Read the section you need.

## Where the quote lives

- A deal's quote is embedded in the deal: `Deal.proposal.quote`. It is not a separate record.
  The `/v2/quote` collection holds reusable quotes (shown as a library in the app); editing a
  deal never touches it.
- `proposal` also holds `title` and `enabled`. With `enabled: true` the deal must have a
  `contact` and a `proposal.title`, and every save that carries `proposal.quote` (or moves the
  deal to another stage) is recalculated by the server.
- `PATCH /v2/deal/<id>` with `{proposal: {…}}` merges `proposal` key by key (so `title` and
  `enabled` survive when you omit them) but **replaces `proposal.quote` as a whole**. Any quote
  field you leave out is lost or reset: `quoteCode` gets a new random code, `quoteCurrency`
  falls back to the account currency, and `commercialException`, `paymentPlan`, `quoteMode`,
  custom `exchangeRates`, notes and `autoPercentOfTotal.dismissed` disappear. `lineItems` is
  replaced as a whole array too.
- The app always saves in two steps: `PUT /v2/quote/calculate` with the full quote, then
  `PATCH /v2/deal/<id>` with `{proposal: {title, enabled: true, quote: <calculated quote>}}`.
  The title is the existing one, else `quoteName`, else the deal name.

## Pricing endpoints

| Call | What it does |
| --- | --- |
| `GET /v2/quote/productSearch?term=&pricebookId=&limit=&page=&xquery={"active":true}` | The quote editor's search. Returns `{data: [product], pagination}`; each product has `pricebookEntries[]` with `_id`, `price`, `currency` and a populated `pricebook`. Path is case-insensitive. |
| `GET /v2/quote/formatLineItem?pricebookEntryId=<id>` | Builds the catalog line for one price-list entry. The response body **is** the line (no `data` wrapper). |
| `PUT /v2/quote/calculate` | Prices a quote and returns it calculated (no wrapper). Saves nothing. Body: the quote itself, plus optional `refreshFields`. Runs the account's quote scripts, as the app does. |

`productSearch` details:

- `term` is optional (empty lists everything), up to 100 characters. `limit` defaults to 10.
- Without `pricebookId`, products are limited to price lists the user can see, but each
  product's `pricebookEntries` may include entries from **other** price lists. With
  `pricebookId`, that list's entries come back without an access check. Pick the price list
  with the user and pass it.
- `xquery={"active":true}` filters products. Inactive entries and price lists can still
  appear; check `active` on the entry and the price list.

`formatLineItem` details:

- Fills `pricebookEntry`, `product`, a populated `pricebook`, `price`, `cost`, `currency`,
  `taxes` (objects with `rate`), the product's fields and a fresh `lineId`.
- Answers `400` for a missing entry ("Not found." — 400, not 404), an inactive entry or price
  list, or a price list outside its `validFrom`/`validTo` window.
- It does **not** set `uuid`. Give each new line its own (`crypto.randomUUID()`).

## Line identity

- **`uuid`** is the stable identity of a line. Payment plans (`originalLineItemId`),
  commercial exceptions and calendar events point to it. The server adds one when it is
  missing and never changes an existing one. Never regenerate or drop it.
- **`lineId`** is rebuilt from the catalog on every calculation, and two lines from the same
  entry can share it. Do not use it to identify a line.
- Lines have no `_id`.

## What calculation keeps and what it overwrites

On a catalog line (has `pricebookEntry`, not `isVirtual`), calculation re-stamps everything
from the catalog **except the editable fields**, which the client wins:

`productName, description, quantity, unitMultiplier, numberOfPayments, currency, cost, price,
startDate, endDate, discountRate, discountAmount, internalNotes, specialNotes, percentOfTotal,
percentOfTotalBase, taxes, hiddenLineItemsValues, customFields, snippets`

`refreshFields` (calculate only) lists editable fields to reload from the price list instead.
The app offers `price, cost, discountRate, discountAmount, quantity, currency, taxes`.

Non-catalog keys such as `uuid`, `includedLineIds`, `itemStock` and `excludeFromPercentOfTotal`
are kept as sent. If the entry, product or price list was deactivated after the line was
added, calculation keeps the line as sent, without error.

## Virtual lines

- A line without `pricebookEntry` is virtual: the server sets `isVirtual: true` and a missing
  `price` becomes 0. A line sent with `isVirtual: true` skips the catalog even if it has a
  `pricebookEntry`. Never set `isVirtual` by hand.
- `modules.pricing.quotes.allowVirtualLineItems` (default true) is enforced by the server for
  lines without `product`: when off, they fail with "Virtual line items has been disabled by
  the administrator."

## Discounts and taxes

- Rates are decimals: 10% is `0.1`.
- `discountAmount` is per unit: net unit price = price − discountAmount.
- When both `discountAmount` and `discountRate` are non-zero, `discountAmount` wins and the
  rate is recomputed from it. A calculated line carries both, so a discount change must send
  the pair (the other one set to 0).
- `taxes` is an array of objects with a non-zero numeric `rate`, applied after discounts and
  added together. Tax ids, or `rate: 0`, make calculation fail with 400.
- A catalog line without `price` yields `NaN` totals (`null` in JSON) with no error. Always
  start from `formatLineItem`, or send `refreshFields: ["price", "taxes"]`.
- Quote-level totals: `subTotal`, `discountAmount`, `taxAmount`, `total`, and `convertedTotal`
  in the account currency. The server overwrites any totals the client sends.

## Time-limited discounts

The quote can make its discounts expire: `quote.timeSensitiveDiscounts`.

| Field | Who writes it | Meaning |
| --- | --- | --- |
| `enabled` | the user | The clock is on. |
| `strategy` | the user | `Real-Time` or `Limited-Time`, exactly. |
| `startFrom`, `endAt` | the user | The window, as instants. The app's editor works in whole days; the API takes any hour. |
| `numberOfNotifications` | the user | Stored (at most 5), but nothing sends notices from it. |
| `lostDiscountAmount`, `remainingDiscountAmount`, `discountAppliedAt`, `finalized`, `cutRate` | the server | Recomputed on each calculation. Never send them back. |

How the server prices it, on every calculation, for the moment of the calculation only:

- The clock runs on **every line that has a discount**, not on one product. The percentage
  stays on each line (`discountRate` / `discountAmount`).
- Before `startFrom` or after `endAt`, every discount is 0, whatever the strategy.
- **Limited-Time**: inside the window, the full discount.
- **Real-Time**: inside the window, `discount × (1 − elapsed / window length)`. 10% on
  1,000,000 for one day is 100,000 off at the start, 50,000 after 12 hours, 0 at the end.
- The first calculation with the clock on stores each line's discount as
  `originalDiscountAmount` / `originalDiscountRate`, and later calculations start from that
  original. A new discount on that line is ignored unless the original is removed (the script
  removes it for every line whose discount the plan changes).
- With `enabled: false`, every line gets its original discount back and the originals are
  removed: turning the clock off restores the full discount, with no end date.
- Under the clock, the stored `discountRate` of a line is not the rate that was asked for.
  Read `originalDiscountRate`, and the amounts.
- `PUT /v2/quote/calculate` takes no date: there is no server call that prices another
  moment. The quote builder has a simulator for that.

With the deal:

- A deal save that carries the quote or a stage recalculates it, and sets `finalized` when
  the stage is an end-of-flow stage. The proposal the customer sees then stops its countdown
  and keeps the discount reached at that moment.
- Reopening the deal (moving it out of the end-of-flow stage) after the window ended
  recalculates the quote: every discount becomes 0, and stays 0 if the deal is approved
  again.
- The proposal shows the countdown when its template includes the quote block.

## Lines the server adds

- **Included products.** A catalog line whose product has `includedProducts` and no
  `includedLineIds` gets those products inserted right after it, from the same price list.
- **Automatic percent-of-total charge** (for example a 10% "Service Charge"), when
  `modules.pricing.quotes.autoPercentOfTotal.enabled` is on (or per product family). The line
  is virtual, priced as a percent of the base, and marked with
  `meta.percentOfTotal.source` = `preference` or `productFamily`. Never add it by hand (it
  would be charged twice) and never edit it. Removing it only sticks if the same calculation
  adds its key `"<source>:<productFamilyId or empty>:<scopeKey>"` to
  `quote.autoPercentOfTotal.dismissed`; otherwise it comes back.
- Percent-of-total lines never count in another percent-of-total line's base.

## Currency

- `quoteCurrency` defaults to the account currency. Lines in other currencies are converted
  with the account's exchange rates (or the quote's custom `exchangeRates`).
- `modules.pricing.quotes.enforceSingleCurrencyPerQuote` (default off) rejects mixed
  currencies: "All line items must have the same currency." A line without `currency` counts
  as a different one.
- `allowNonDefaultCurrency` off rejects a line whose currency differs from the quote's, with
  the misleading message "Custom exchange rates has been disabled by the administrator."

## Events mode

- `quoteMode` accepts only `'Events'`; standard quotes store `null`.
- Each line of an events quote covers one day: `startDate` = midnight of that day and
  `endDate` = midnight of the next day (exclusive), in the user's time zone (profile, then
  account). Lines of the same day share those dates. `endDate = startDate` is wrong.

## Commercial exceptions

- An approved exception is referenced by `quote.commercialException` (`{_id}`). Keep the
  pointer exactly as stored; never write rules inline (fails with "Locked field cannot be
  changed") and never change fields a line lists in `rules[].lockedFields`.
- A save answers **409** `staleQuote` ("The quote changed because of an approval; reload to see
  the changes.") when the pointer sent no longer matches the stored one after an approval.
  Reload the deal, rebuild the change and ask again.

## Closed deals

A deal in a stage with `endFlowStage: true` (for example Approved or Denied) rejects edits to
its quote with 400 ("This deal is in the "…" stage…"), unless an admin turned on
`modules.sales.deals.stageRules.allowEditInEndFlowStages`. Only the stage, tasks, notes and a
few tracking fields can still change.

## Extended quote configuration

The quote editor opens an extended-quote site from the workspace's `extendedQuote`
(`{enabled, url}`) when it has both, otherwise from the account preference
`modules.sales.deals.quote.extendedQuote` (`{enabled, url}`).
