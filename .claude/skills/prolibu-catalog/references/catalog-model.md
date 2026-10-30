# Catalog model: how the platform stores products and prices

Reference for `prolibu-catalog`. Read the section you need. Quote-side behavior (what a
quote line copies from a price, how totals are computed) is in
`../prolibu-quotes/references/quote-model.md`.

## The objects

| Object | API path | Code (unique key) | Name | Notes |
| --- | --- | --- | --- | --- |
| Product | `product` | `productCode` | `productName` | The item. No price of its own. |
| Pricebook | `pricebook` | `pricebookCode` | `pricebookName` | A price list. No currency of its own. |
| PricebookEntry | `pricebookentry` | `pricebookEntryCode` | — | The price of one product in one price list. |
| Tax | `tax` | `taxCode` | `taxName` | A rate, attached to prices. |
| ProductFamily | `productfamily` | `productFamilyCode` | `productFamilyName` | Groups products in the proposal; may add an automatic charge. No `active` field. |
| ProductCategory | `productcategory` | `productCategoryCode` | `productCategoryName` | A label; a product has a list of them. |
| ProductGroup | `productgroup` | `productGroupCode` | `productGroupName` | Groups lines in the proposal, with header and footer options. |
| DiscountSchedule | `discountschedule` | `discountScheduleCode` | `discountScheduleName` | A volume discount, attached to prices. |
| Coupon | `coupon` | `couponCode` | `couponName` | A sign-up discount code for subscriptions. Not for quotes. |
| ProductRule | `productrule` | `productRuleCode` | `productRuleName` | Limits checked when a product is quoted. |

Feature (product options) and ItemStock (bookable units) exist too; this skill does not
write them.

- Every code is unique, required and generated when missing (`PRO-…`, `ENT-…`,
  `pricebook…`, `tax…`). A record can be read by its code: `GET /v2/product/<productCode>`.
- References are stored as `_id`. A write may send the referenced record's **code** instead:
  the server swaps it for the `_id`, and an unknown code answers
  `400 Document not found by primaryKey '<code>'`. A 24-hex value is always taken as an `_id`.
- Names are not unique. Accounts have names that differ only in case (two families
  "ALIMENTOS Y BEBIDAS" and "Alimentos y Bebidas" were found on a test account).

## A product and its prices

- A product has **no price**. Each price is a PricebookEntry with `pricebook`, `product`,
  `currency`, `price`, `cost`, `discountAmount`, `taxes`, `discountSchedules`,
  `pricingMethod`, `rules` and `active`.
- **One price per product per price list.** `(pricebook, product)` is a unique pair. A second
  one answers `400 pricebook '<id>' already exists` (the message names the price list, not the
  pair). To change a price, update the existing entry. A product can have prices in many
  price lists.
- A product with no price cannot be quoted: the quote editor's search only lists products
  that have entries, and a quote line is built from an entry.
- **The app writes them separately.** The main app creates a product with the generic form
  (`POST /v2/product`, flat fields) and never creates prices with it. Prices are created in
  the price-list screens: one `POST /v2/pricebookentry` per product and price list. The newer
  app's "Add to price list" posts `{pricebook, product, price: 0}` per list, and the price is
  then edited inline.
- `netUnitPrice` is computed by the server as `price − discountAmount` on every save.
  `discountAmount` on the entry is a list discount per unit: quote lines start with it.
- `pricingMethod: "Percent Of Total"` needs `percentOfTotal` (decimal) and
  `percentOfTotalBase` (`subTotal`, `netTotal` or `total`), or the save answers 400. The
  server sets `price` to 0.
- `rules` on the entry **replace** the product's `rules` for that price list.

## Currency

- Currency belongs to each price, not to the price list. It must be an ISO code from the
  server's list; anything else answers 400 with the list of allowed values.
- **A price without currency gets the account's default currency, silently.** That default is
  the account preference, which may differ from the currency the API user sees in
  `/v2/user/preferences` (that call overlays the user's own locale). On the test account a
  price sent without currency was saved in COP while the user's locale said MXN.
- A quote converts prices in other currencies with the account's exchange rates, unless the
  account forbids mixed currencies (see the quote model).

## Taxes

- `Tax.rate` is a **decimal**: 19% is `0.19`. The app shows it ×100 and stores it ÷100. The
  server accepts any value from −100 to 100, so a tax saved as `19` is accepted and charges
  1900%.
- A price lists its taxes as Tax `_id`s. A quote line copies them as objects with `rate`.
- **A 0% tax breaks quotes.** Calculation refuses a tax whose rate is 0 or not a number:
  `400 The 'rate' is required in 'tax' object and must be a number`. Every quote with that
  price fails. An exempt product has no tax.
- A Tax record does nothing until a price lists it. Creating one changes no existing quote.

## Volume discounts (DiscountSchedule)

- Applied **only** through the price's `discountSchedules` list. `Pricebook.discountSchedule`
  is stored but the quote calculation never reads it: a price list with a schedule and an
  entry without one gives no discount (checked on a live account).
- The usual form is `formula: "tiers"` with
  `formulaSettings.tiers.segments: [{from, to, segmentDiscountRate}]`. Rates are decimals.
  The metric is `netQuantity` by default (quantity × unit multiplier).
- The first segment that matches wins. A segment without `to` covers everything from `from`
  up. A segment with `from: 0` and no `to` never matches. Verified live with 5% from 10 and
  10% from 50 units: 9 units paid the list price, 10 and 49 paid 95%, 50 paid 90%.
- `floorPrice` is the lowest unit price the schedule may reach. Other formulas (`linear`,
  `stepped`, `nonLinear`, payment-based) exist; their settings sit under
  `formulaSettings.<formula>`.
- The discounted price shows in the quote line as `specialPrice`, and the difference as
  `systemDiscountAmount`.

## Active, dates, deletion

- An inactive product, inactive price or inactive price list cannot be added to a quote, and
  neither can a price list outside its `validFrom`/`validTo` window (`formatLineItem` answers
  400). Lines already in quotes are kept as they are.
- Deleting a price list **deletes all its prices**. The price list with code `standard` cannot
  be deleted. Deleting a product leaves its prices behind, pointing to nothing. This skill
  never deletes: it deactivates (`active: false`).
- `isStandard` on a price list is only a label.

## Coupons

- A coupon is checked and redeemed only when an account signs up for a subscription (the
  Subscriptions module, behind the `modules.pricing.coupons` preference). Deal quotes never
  read coupons.
- `discountType` is `percentage` or `fixed`. For a percentage, `discountValue` is a **whole
  number from 0 to 100** (15% is `15`), unlike every other rate in the catalog. Above 100 the
  save answers 400.
- `validFrom` must be before `validTo`; `duration: "repeating"` needs `durationInMonths`.
- A coupon has no product scope: any sign-up can use its code while it is active.

## Product rules

- A rule applies to a product when the product (or the price, which then replaces the
  product's rules) lists it in `rules`. Rules lock fields, set min/max values
  (quantity, price, discount rate, unit multiplier, payments, markup) and require or exclude
  other products.
- A min/max rule on a field a quote line does not carry makes that quote fail with
  `Cannot validate field against product rule`. Attach rules only when the user knows what
  they enforce.

## Families and groups

- A family can carry `autoPercentOfTotal` (enabled, percent, base, scope, productName): every
  quote with a product of that family gets an automatic charge (for example a service
  charge). Leave it unset to inherit the account preference.
- A group sets how its lines are shown in the proposal (`groupHeader`, `groupFooter`).

## The app's Excel import

- `PUT /v2/service/importdata?modelName=<Model>` with a multipart `.xlsx` (or JSON) runs as a
  background job and reports progress over a socket. There is no preview.
- A workbook with a `datamap` sheet loads several objects in order: each row names a
  `sheetName` and its `objectType`, with optional `skip`, `from`, `to` and `drop`. Column
  headers are API field names (dotted paths such as `allowEveryone.view`); references go by
  code; list cells accept `["19"]`, `['19']` or `19, 8`.
- Each row is matched by `_id` or by the object's code, then patched (only non-empty cells) or
  created. An empty cell means "do not touch"; the text `null` clears a field. Columns that are
  not fields are ignored. Prices are matched by `pricebookEntryCode`, not by the product and
  price list, so a price row without the existing entry's code fails as a duplicate.
- **`drop` wipes the whole collection first.** Only Store, Contact, Product and
  PricebookEntry can be dropped, so a `drop` on a Product or PricebookEntry sheet deletes the
  entire catalog of the account before loading.
- The team uses this format for price lists (one workbook: Tax, ProductGroup, Pricebook,
  Product, PricebookEntry). `catalog.js from-sheet` reads it, ignores unknown columns the same
  way, and refuses `drop`.

## How `catalog.js` matches and writes

- Records are matched by code; a record given only by name is matched by name (case and
  spacing ignored), and a name shared by two records is a blocker. Products always need a
  code.
- Prices are matched by product and price list, as the server's unique pair does.
- Only fields present in the plan are compared and sent. Lists (`taxes`,
  `productCategories`…) are replaced whole, as `PATCH` does. `null` clears a field.
- Write order: taxes, families, categories, groups, discount schedules, coupons, price lists,
  products, prices. Records created earlier in the same run are referenced by their new
  `_id`.
- The version covers the plan and the `updatedAt` of every matched record; any change in
  between makes `apply` stop.
- After writing, every record is read back and compared, then each written price is turned
  into a quote line (`formatLineItem`) and priced for one unit (`PUT /v2/quote/calculate`,
  which saves nothing). Up to 300 prices are checked per run.
