---
name: prolibu-quotes
description: Add, change or remove products on a Prolibu deal's quote (proposal) the way the app does it — find the deal, pick real catalog products from the right price list, set quantities, discounts and event days, preview the server's totals, then save after the user agrees. Use it whenever someone asks to quote, price or add products or services to a deal, change a quantity or discount on a quote, remove a line, or reports quote lines that came out "virtual", totals that look wrong, lines that vanished after saving, or a 409 when saving a quote. Spanish triggers: "cotización", "cotizar", "agregar productos al negocio", "propuesta", "descuento en la cotización", "líneas virtuales".
---

# Prolibu Quotes

## Central idea

A deal's quote lives inside the deal (`proposal.quote`). A line is **real** when the server
built it from a price-list entry: it has `product` and `pricebookEntry`. A line made up by hand
is **virtual**: it skips the catalog, its taxes and its rules. The app never makes up catalog
lines, and neither does this skill.

`scripts/quote.js` does the fragile parts in code, so they cannot be forgotten:

- it builds new lines with the server's `formatLineItem`;
- it keeps every existing line and quote field exactly as stored;
- it lets the server compute every total;
- it saves the whole quote in one call, then reads it back.

Your job is the conversation: understand the request, choose the deal, the price list and the
products with the user, show the preview and save only after a clear yes.

```
node .claude/skills/prolibu-quotes/scripts/quote.js <command> <domain> …
  deals      <domain> <part of the deal name>
  show       <domain> <dealId>
  pricebooks <domain>
  search     <domain> <term> [--pricebook <id>] [--currency <ISO>] [--limit <n>]
  preview    <domain> '<plan json>'
  apply      <domain> '<plan json>' --deal-version <dealVersion from preview> --confirmed
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written).

## Ask the user first

In plain business terms:

1. **Which deal?** A name is enough; you look up the id.
2. **Which products, and how many?** For an events quote, also **which day** each one is for.
3. **Which price list?** Only ask when the deal's currency leaves more than one choice.
4. **Any discount?** As a percentage or an amount per unit.

If the account has several domains under `accounts/`, ask which one.

## Steps

1. **Find the deal.** Run `deals <domain> "<name>"`. If several match, list them and ask.
2. **Read it.** Run `show <domain> <dealId>`. Note:
   - the quote currency and mode;
   - each line's `uuid`;
   - any `blockers`. If there is a blocker, explain it in plain words and stop.
3. **Pick the price list.** Run `pricebooks <domain>` for the active ones.
   - A price list has no currency of its own; each entry has one, and `search` shows it.
   - Prefer entries in the quote currency. Other currencies are converted in the totals.
   - If the user did not name a price list and more than one fits, ask.
4. **Find each product.** Run `search <domain> "<term>" --pricebook <id>`. Use the
   `pricebookEntryId` of the row the user means.
   - Several plausible rows: ask.
   - Nothing found: tell the user the product is not in that price list and stop for that
     product.
   - Never invent a line: no virtual line unless the user explicitly asks for a custom line,
     and then it is done in the app.
5. **Write the plan** as JSON. Pass it inline, in single quotes; a path to a JSON file in a
   temp folder also works.

   ```json
   {
     "dealId": "<deal _id>",
     "add":    [{ "pricebookEntryId": "<id>", "quantity": 2, "discountRate": 0.1, "day": "2026-11-05" }],
     "update": [{ "uuid": "<line uuid>", "quantity": 5 }],
     "remove": [{ "uuid": "<line uuid>" }]
   }
   ```

   - Fields you may set: `quantity`, `unitMultiplier`, `numberOfPayments`, `discountRate`
     (decimal: 10% = 0.1), `discountAmount` (per unit), `price` (only when the user asks to
     override the list price), `startDate`, `endDate`, `description`, `internalNotes`,
     `specialNotes`, `customFields`.
   - `day` (YYYY-MM-DD) sets an events line's dates in the user's time zone. If the script
     says it cannot find one, ask the user for the account's time zone and add
     `"timeZone": "<IANA zone>"` to the plan.
6. **Preview.** Run `preview <domain> '<plan json>'`. It calculates on the server and writes
   nothing. Tell the user, in plain language and in the quote currency:
   - what is added, changed and removed;
   - the new total, compared with the old one;
   - `serverAddedLines`: included products or an automatic service charge, added by the
     account's own rules;
   - every `warning`;
   - that saving turns the deal's proposal on, if `turnsProposalOn` is true.
7. **Wait for an explicit yes.** Changing or removing existing lines needs its own yes.
8. **Save.** Run `apply <domain> '<same plan json>' --deal-version <dealVersion> --confirmed`,
   with `dealVersion` from the preview. It refuses when the deal changed since that preview
   (preview again and show the user), or when the deal is blocked.
9. **Report.** On `"saved": true`, give the user the saved total and the deal name. On
   `problems`, show them and say nothing was hidden.

## How the platform behaves

The details and their consequences are in `references/quote-model.md`. Read it when a case
falls outside the steps above.

- **The server owns the totals.** Every save is recalculated, and any total you send is
  overwritten. Never quote a number that did not come from `preview` or `apply`.
- **A save replaces the whole quote.** Omitted fields reset: currency, code, payment plan,
  approvals. This is why only the script writes quotes.
- **Lines are identified by `uuid`.** Payment plans and approvals point to it. `lineId`
  changes on every calculation.
- **A discount travels as a pair.** When both are set, `discountAmount` wins. The script sets
  the other one to 0.
- **Automatic charges come back.** A "Service Charge" added by the account returns on every
  calculation. Remove it only if the user insists, with `"dismissAutoCharge": true` on that
  `remove` entry.
- **Closed deals are locked.** A deal in an end-of-flow stage (Approved, Denied) rejects quote
  changes unless an admin allowed edits in end-flow stages. Do not look for a way around it.
  Only when the user confirms an admin turned that on, add `--allow-end-flow-stage` to `apply`.
- **Approvals can make a save stale.** An approval in the meantime makes the save answer 409.
  Run preview again and show the user the new result.
- **The AI assistant's proposal tools are not for this.** If the Prolibu MCP server is
  connected, its `createProposal`, `updateProposal` and `calculateQuote` tools only make
  virtual lines, and `updateProposal` turns catalog lines into virtual ones. Use this skill
  for catalog products.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| New lines show as virtual, without taxes | Built by hand, without `pricebookEntry` | `search` + `add` with `pricebookEntryId` |
| Lines or the payment plan vanished after saving | A partial quote was saved | Only save through `apply` |
| Totals are `null` | A catalog line has no `price` | Rebuild it from `formatLineItem` (the script does) |
| A discount change has no effect | Only the rate was sent; the stored amount wins | Send the pair (the script does) |
| A removed service charge came back | It is automatic | `dismissAutoCharge`, only if the user insists |
| "Custom exchange rates has been disabled…" | A line's currency differs from the quote's, and the account forbids it | Use a price list in the quote currency |
| "Virtual line items has been disabled…" | A line without a product, on an account that forbids them | Use catalog products |
| 400 "This deal is in the … stage" | Closed deal | Tell the user; an admin decides |
| 409 when saving | An approval changed the quote | Preview again |

## Verify

- `apply` reads the deal back. Every added line has `product` and `pricebookEntry` and is not
  virtual, and every line that was there before is still there.
- The total you report is the saved one, in the quote currency.

## Don't

- Write a quote with the generic API helper or a hand-made `PATCH`.
- Add a "Service Charge" or any automatic line by hand.
- Change `uuid`, `isVirtual`, `pricebookEntry`, `taxes` or `commercialException`.
- Search without `--pricebook` and pick an entry the user did not choose: it may come from a
  price list they cannot see.
- Retry a blocked or rejected save another way.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step and `apply`
the write. For a site that adds products from inside the quote editor, see the
`prolibu-extended-quote-sites` skill. For objects and how they relate, see
`prolibu-platform-map`.
