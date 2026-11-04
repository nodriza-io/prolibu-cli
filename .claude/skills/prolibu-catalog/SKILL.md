---
name: prolibu-catalog
description: Create and update a Prolibu catalog the way the app's own import does it — products, price lists and each product's price in them (currency, cost, taxes, volume discounts), families, categories, groups, taxes and coupons, one record or a whole catalog loaded from an Excel or CSV file — with a preview against the account, checks for the values the server accepts silently but that break quotes, and a read-back that proves every price can be quoted. Use it whenever someone wants to add or change products, prices or price lists, load or update a catalog or price list from a spreadsheet, set up taxes, volume or quantity discounts or coupons, or reports a product that does not show in the quote editor, prices in the wrong currency, a tax charged 100 times over, a volume discount that does nothing, or an import that duplicated products. Spanish triggers: "catálogo", "lista de precios", "cargar productos desde Excel", "crear productos", "actualizar precios", "impuestos", "descuento por volumen", "cupones".
---

# Prolibu Catalog

## Central idea

A product has no price of its own. Each price is a separate record (a price-list entry) that
joins **one product to one price list**, with its own currency, cost, taxes and volume
discounts. A product without an entry cannot be quoted. Records are found again by their
**code** (`productCode`, `pricebookCode`, `taxCode`…): a load without codes creates
duplicates the next time.

`scripts/catalog.js` does the fragile parts in code: it reads the spreadsheet, matches every
record by code (prices by product and price list), refuses what would break quotes, writes in
dependency order, reads everything back and prices one unit of each price on the server.
Your job is the conversation: agree on codes, price list, currency and taxes with the user,
show the preview and write only after a clear yes.

```
node .claude/skills/prolibu-catalog/scripts/catalog.js <command> …
  sheet      <file.xlsx|file.csv> [--sheet <name>] [--rows <n>]   read a spreadsheet
  from-sheet <file> ['<mapping json>'] [--out <temp file>]        spreadsheet → plan file
  find       <domain> <object> <term>      product, pricebook, tax, productfamily, productcategory,
                                           productgroup, discountschedule, coupon, productrule
  product    <domain> <productCode> [--quantity 1,10,50]
                                           a product, its prices, and each priced by the server
  preview    <domain> '<plan json>'        writes nothing; returns a version
  apply      <domain> '<plan json>' --version <v> --confirmed
```

Plans and mappings are inline JSON or a JSON file in a temp folder. Output is JSON. Exit
codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing written).

## Ask the user first

In plain business terms:

1. **Which price list?** An existing one (look it up with `find … pricebook`) or a new one
   (name, and optional validity dates).
2. **Which currency** are the prices in? Never leave it out.
3. **How is each product identified?** A code column or an ERP id. Without codes, agree on
   one before loading (a later load must find the same products).
4. **Taxes:** which tax applies (by name, or a "VAT %" column). Exempt products get none.
   Look for an existing tax by its rate first (`find <domain> tax 19%`): names vary ("19",
   "IVA", "VAT"). Offer the one that exists before creating another.
5. **Families, categories, groups** in the spreadsheet: should names that do not exist yet be
   created, or are they typos?

If `accounts/` has several domains, ask which one.

## Steps

1. **Read.** For a file, run `sheet <file>`: note the sheets, headers and sample rows. For a
   single product, run `product <domain> <code>` or `find`.
2. **Plan.** A plan has sections, each a list of records keyed by code:
   `taxes, families, categories, groups, discountSchedules, coupons, pricebooks, products`.
   A product's prices go in its `entries`:

   ```json
   {
     "pricebooks": [{ "pricebookCode": "pl-2027", "pricebookName": "Price list 2027" }],
     "discountSchedules": [{ "discountScheduleCode": "vol-coffee", "discountScheduleName": "Coffee volume",
                             "tiers": [{ "from": 10, "to": 49, "rate": 0.05 }, { "from": 50, "rate": 0.1 }] }],
     "products": [{ "productCode": "cof-500", "productName": "Ground coffee 500 g", "productFamily": "beverages",
                    "entries": [{ "pricebook": "pl-2027", "currency": "COP", "price": 18500, "cost": 9000,
                                  "taxes": ["iva-19"], "discountSchedules": ["vol-coffee"] }] }]
   }
   ```

   - Fields are API names (read the object's schema when unsure). References take a code,
     a name or an `_id`. Only the fields given are compared and changed; lists are replaced
     whole; `null` clears a field. `"active": false` deactivates.
   - Rates are decimals (19% is `0.19`; tiers too). Coupons are the exception: 15% is `15`.
   - From a spreadsheet, run `from-sheet` with a mapping; it writes the plan to a temp file:

     ```json
     { "sheet": "Products",
       "product": { "productCode": "Code", "productName": "Name", "productFamily": "Family" },
       "entries": [{ "pricebook": { "value": "pl-2027" }, "currency": { "value": "COP" },
                     "price": "Price", "cost": "Cost", "taxRate": "VAT %" }],
       "replace": { "Family": { "Drinks": "beverages" } },
       "create": { "productCategories": true },
       "include": { "pricebooks": [{ "pricebookCode": "pl-2027", "pricebookName": "Price list 2027" }] } }
     ```

     A bare string is a column; `{"value": …}` is the same value for every row. Several price
     lists side by side are several `entries` items. `taxRate` finds the tax with that rate
     (19 or 19% → 0.19; 0 → no tax). `create` adds missing families, categories or groups
     by name. A workbook with a `datamap` sheet (the app's import format) needs no mapping.
   - Tell the user every `problems` line (rows left out, conflicting rows).
3. **Preview.** Run `preview <domain> '<plan>'`. Tell the user, in plain words:
   - the counts to create, update and leave unchanged, per kind of record;
   - every change to an existing record, `from` → `to` (prices above all);
   - every warning and every blocker. On a blocker, fix the plan with the user and preview
     again. `detailFile` holds the full list when it is long.
4. **Wait for an explicit yes.** Changes to existing products or prices need their own yes.
5. **Write.** Run `apply` with the same plan, `--version <version from preview>` and
   `--confirmed`. It refuses when anything changed since the preview: preview again.
6. **Report.** From the result: what was created and updated (ids), `problems`, and
   `quotable` (one-unit price with tax per product; `notQuotable` with the reason). For a
   volume discount, run `product <code> --quantity 1,10,50` and give the server's unit prices. If
   `saved` is false, say what was written and the error; after the fix, preview again
   (written records show as unchanged).

## How the platform behaves

Details and evidence are in `references/catalog-model.md`. Read it when a case falls outside
the steps.

- **One price per product per price list.** A second one is refused with a misleading
  "pricebook '…' already exists". The script updates the existing price instead.
- **Currency is per price and defaults silently** to the account's default currency, which
  may not be the one the user sees. The script requires it on every new price.
- **Tax rates are decimals, and the server accepts anything from −100 to 100:** a tax saved as
  `19` charges 1900%. A 0% tax makes every quote with that price fail. The script blocks both.
- **Volume discounts work only on the price.** A discount schedule on the price list is
  stored and ignored. Tiers: the first match wins; rates are decimals.
- **Coupons never discount quotes.** They are redeemed only at subscription sign-up, and take
  whole percentages.
- **Inactive or out-of-date prices cannot be quoted**, nor can prices in an inactive price
  list. Lines already in quotes are kept.
- **The app's Excel import has no preview, and its `drop` column wipes the whole product or
  price catalog first.** `from-sheet` reads those workbooks and refuses `drop`.
- **Deleting a price list deletes all its prices.** This skill never deletes; it deactivates.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| Product does not show in the quote editor | It has no price in that list, or the product, price or list is inactive or out of its dates | `product <code>`; add or activate the price |
| "pricebook '…' already exists" when adding a price | The product already has a price in that list | Update it: preview with the same product and list |
| Prices came out in the wrong currency | Created without currency | Preview with `currency` on those prices |
| Tax is 100 times too high | Tax rate saved as a percentage (19) | Set `rate` to 0.19 |
| Every quote with a product fails: "The 'rate' is required in 'tax'…" | A 0% tax on its price | Remove that tax from the price |
| Volume discount does nothing | Schedule on the price list, or rate given as 10 instead of 0.1 | Put it in the price's `discountSchedules`; decimal rates |
| A second load duplicated products | Rows without codes got random codes | Load with codes; deactivate the duplicates with the user |
| Import deleted the catalog | `drop` in the datamap | Restore from the user's backup; never use `drop` |
| "Cannot validate field against product rule" on quotes | A rule checks a field the line lacks | Show the user the product's rules; an admin decides |

## Verify

- `apply` reads back every record it wrote and compares each field sent; `saved: true` means
  all matched.
- `quotable` builds a quote line from each written price and prices one unit on the server
  (nothing is saved). Give the user those totals; never quote a number the server did not
  return.

## Don't

- Create a product without a code, or a price without currency.
- Write catalog records with the generic helper when this script covers them, or call the API
  any other way (`node -e`, curl, reading `profile.json`). If the script lacks something, say so.
- Delete products or price lists, or use the import's `drop`.
- Create a tax with rate 0 or a percentage, or attach one to a price.
- Put a discount schedule on the price list and expect it to apply.
- Pick between two records with the same name yourself; ask.
- Edit quotes here: use `prolibu-quotes`.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step and `apply`
the write. External ids go in `refId` as text (see `prolibu-external-refs`). Features, item
stock are written with the generic flow in `prolibu-platform-map`. Product rules are created
and checked with `prolibu-commercial-exceptions`; attaching them to a product or price-list
entry is done here (an entry's rules replace the product's). Bookable units and calendars are
set up with `prolibu-calendars`. Which products and prices a public quote page (`/pw`) shows
is set in `prolibu-proposal-wizard`.
