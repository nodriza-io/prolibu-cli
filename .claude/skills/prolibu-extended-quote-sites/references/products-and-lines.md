# Searching products and building real lines

Reference for `prolibu-extended-quote-sites`. Engine rules (what the server keeps or reloads on
calculate, discounts, service charge, currencies, events) are in
`../../prolibu-quotes/references/quote-model.md`; this file covers what a site needs.

## Search

`GET /v2/quote/productSearch?term=<text>&limit=20&page=1&xquery={"active":true}[&pricebookId=<id>]`

- The quote editor's own search. Answers `{ data: [product], pagination: { page, lastPage, count } }`.
- Each product: `productName`, `productCode`, `productFamily`, `productCategories`… and
  `pricebookEntries: [{ _id, price, currency, active, pricebook: { _id, pricebookName } }]`.
  Show one row per entry.
- `xquery` is a JSON string. Default `limit` is 10. An empty `term` lists everything.
- Without `pricebookId`, a non-admin gets products from the price lists it can see, but each
  product's `pricebookEntries` may include entries of other price lists.
- With `pricebookId`, the server does not check that the user may see that price list. Use only
  price lists the seller is meant to quote from (a setting of the site, not a free input).
- The quote has no price list: filter entries by `currency === quoteCurrency`. With no
  `quoteCurrency` yet, show each row's currency; never invent one.
- Inactive entries and price lists can still come back; `formatLineItem` rejects them.

## Build the line

`GET /v2/quote/formatLineItem?pricebookEntryId=<entry._id>` → the response body IS the line.

- Carries `pricebookEntry`, `product`, a populated `pricebook`, `price`, `cost`, `currency`,
  taxes and a new `lineId`.
- `400` when the entry is missing, inactive, its product or price list is inactive, or the price
  list is outside `validFrom`/`validTo`.
- Add a `uuid` (`crypto.randomUUID()`): payment plans, approvals and calendar events point to it.
- Change only editable fields: `quantity`, `unitMultiplier`, `startDate`, `endDate`,
  `discountRate` (decimal), `discountAmount` (per unit), `internalNotes`, `specialNotes`,
  `description`, `customFields`. Everything else is reloaded from the catalog on calculate.
- `price` is editable too: if sent, the engine uses it instead of the catalog's.
- A line without `pricebookEntry` is saved as virtual; `unitPrice` is not a field (it is `price`).
- To edit a line that arrived, find it by `uuid`, change editable fields only, send the full list.
  When changing a discount, send both `discountRate` and `discountAmount` (the other one 0):
  when both are set, `discountAmount` wins.
- `cost` comes back in the product data. Do not show it on the page unless the account wants
  sellers to see it.

## Events mode (`quoteMode === 'Events'`)

- Each line covers one day: `startDate` = midnight of that day, `endDate` = midnight of the next
  day (exclusive), in the user's time zone (profile, then account).
- `ProlibuQuote.eventDay('2026-11-05', 'America/Bogota')` builds both.
  `await ProlibuQuote.userTimeZone()` reads the profile's; when it is `null` the account's
  applies, and only admins can read that: make it a setting of the site.
- `endDate = startDate`, a date without time or the browser's zone put the line on another day.

## The helper (`assets/prolibu-extended-quote.js`)

Exposes `connect` (`getDeal`, `quote`, `applyLineItems`, `close`), `searchProducts`,
`listPricebook`, `lineItemFromEntry`, `eventDay`, `userTimeZone`, `deserialize`, `api` (any
authenticated GET) and `configure`. `applyLineItems` refuses hand-built lines without
`pricebookEntry` unless `allowVirtual: true`, and remembers what it sent so a second apply does
not duplicate. `assets/example/index.html` is a complete picker built on it.
