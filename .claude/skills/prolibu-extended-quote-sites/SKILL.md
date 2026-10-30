---
name: prolibu-extended-quote-sites
description: Build, publish and fix a Prolibu Site that works as an "Extended quote" — a page the quote editor opens in a modal so sellers can pick real catalog products (or anything custom) and send the lines back into the deal's quote. Covers the message protocol with the quote editor (V1 and V2), reading the session, searching products and building real lines, events-quote dates, publishing with this CLI and switching the feature on. Use it whenever someone wants a custom product picker, configurator or calculator inside the quote editor, or reports that an extended-quote site creates virtual lines, deletes existing lines when applying, duplicates lines, or shows an error or stays silent when it opens. Spanish triggers: "cotización extendida", "extended quote", "sitio dentro del cotizador", "configurador de productos".
---

# Prolibu Sites as an "Extended quote" with real products

## Central idea

The Extended quote is a web page the quote editor opens in an iframe:

1. the page asks the editor for the deal;
2. the user picks products;
3. the page sends the quote lines back.

No MCP and no library are needed: only `postMessage` with the editor and `fetch` to the
Prolibu API.

A quote line is **real** when it has `pricebookEntry`; without it the server marks it
`isVirtual` and does not link it to the catalog. A real line is never built by hand:
**search it with `GET /v2/quote/productSearch` and get it built with
`GET /v2/quote/formatLineItem`**.

`assets/prolibu-extended-quote.js` implements everything below, and `assets/example/index.html`
is a complete site that uses it. Copy them into the site, adapt them, or write your own code
following this guide. The helper exposes `connect`, `searchProducts`, `listPricebook` (a whole
price list), `lineItemFromEntry`, `eventDay`, `userTimeZone`, `deserialize` and `api` (any
authenticated `GET`); extend the page, not the helper.

## 1. Messages with the quote editor

The host is the V1 or V2 quote editor, and it never speaks first.

| Direction | `type` | `payload` (JSON string) |
|---|---|---|
| site → host | `form:get:model` | `{"modelName":"deal"}` (V2 only answers `deal`) |
| host → site | `form:get:model:response` | `{ modelName, value: <deal> }`, serialized (see below) |
| site → host | `form:set:model` | `{"modelName":"deal","value":{"proposal":{"quote":{"lineItems":[…]}}}}` |
| site → host | `form:close` | no payload: `{ type: 'form:close' }` |

```js
const PARENT = document.referrer ? new URL(document.referrer).origin : location.origin
const send = (type, payload) =>
  parent.postMessage(payload === undefined ? { type } : { type, payload: JSON.stringify(payload) }, PARENT)
addEventListener('message', (e) => {
  if (e.source !== parent || e.origin !== PARENT || e.data?.type !== 'form:get:model:response') return
  const deal = deserialize(JSON.parse(e.data.payload)).value   // deserialize: see below
})
send('form:get:model', { modelName: 'deal' })                   // AS SOON AS the page loads
```

- **Speak first, on load.** In V2, if no valid message from the site arrives within 15 s, the
  modal shows an error. V1 has no timeout, but waits just the same.
- **The deal arrives serialized** with the app's postMessage serializer:
  - every object carries `__id`;
  - a repeated reference comes as `{__ref: n}`;
  - dates come as `{__type:'date', value: ISO}`.

  Deserialize before using it; `deserialize()` in the helper is about 25 lines you can copy.
  What you send back is plain JSON.
- **`value.proposal.quote` is the editor's LIVE quote**, not saved yet:
  - `quoteCurrency`, `quoteMode`, `startDate`/`endDate` and `lineItems`;
  - on a new deal `lineItems` can be missing: treat it as `[]`.
- **`form:set:model` REPLACES all the lines** when `lineItems` is an array, in V1 and V2. Send
  `[...linesThatArrived, ...newLines]`, never only the new ones.
- **Send only `proposal.quote.lineItems`.**
  - V2 also adopts the quote header and the payment plan if you send them, and ignores the
    rest of the deal.
  - V1 deep-merges whatever you send into the deal form that is open.
  - The site reads the currency and the mode; it does not change them.
  - `company` cannot be written from the site.
- **Exact origin.** V2 only accepts messages from the iframe's `contentWindow` and from the
  origin of the configured URL. A redirect to another domain leaves the modal silent, and the
  console shows `[extendedQuote] mensajes descartados` once. V1 does not check, but do not
  rely on that.
- **Send back the lines that arrived as they came** (deserialized, plain JSON): they are what
  the editor already holds, with their `uuid`.
- **The host does not answer `form:set:model`.** After applying, close with `form:close`. If
  the site stays open, take the list you sent as the current one, so you do not duplicate it.
- **Adopting does not recalculate.** Totals stay provisional until the user presses
  **Calculate**, and the deal is saved with the app's Save, which always calculates first.

## 2. Session and API

- **Host the site as a Prolibu Site.** `https://<domain>/site/<siteCode>/` serves `index.html`
  on the SAME origin as the app, so the site can read the user's session from `localStorage`.
  - The key is `apiKey`. V2 stores it as a JSON string (with quotes); V1 and the realtime
    connection store it plain. `JSON.parse` it and fall back to the raw value, as the helper
    does.
  - Then call `fetch` on `https://<domain>/v2/...` with `Authorization: Bearer <token>`.
  - The site's other files (`.js`, `.css`) are served by a redirect to storage. Fine for
    `<script>` and `<link>`; a `fetch()` to them is cross-origin.
- **The token never goes in the URL** (`?token=`), and it is not requested over `postMessage`:
  the host does not send it.
- **Outside the app's domain there is no session.** An API key embedded in the site is public
  to anyone who opens it: avoid it.

### Search products

`GET /v2/quote/productSearch?term=<text>&limit=20&page=1&xquery={"active":true}[&pricebookId=<id>]`

It is the quote editor's search. It answers `{ data: [product], pagination: { page, lastPage,
count } }`. Each product brings `productName`, `productCode` and `description`, plus
`pricebookEntries: [{ _id, price, currency, pricebook: { _id, pricebookName } }]`: show one row
per entry.

- `xquery` goes as a JSON string.
- An empty `term` lists everything. Search from 2 characters on, so the list stays useful.
- **Pass `pricebookId` whenever the site knows the price list** (fixed per client or per
  currency). Without it, a product's entries can include price lists the user cannot see.
- The quote has no price list of its own: filter entries by `currency === quoteCurrency`. If
  the quote has no `quoteCurrency` yet, do not filter; show each row's currency. Do not invent
  a default currency.
- Inactive entries and price lists can still come back; `formatLineItem` rejects them with 400.

### Build the line

`GET /v2/quote/formatLineItem?pricebookEntryId=<entry._id>` → **that response IS the line**:
the object comes directly, with no `data` wrapper.

- **What it carries:** `pricebookEntry`, `product`, a populated `pricebook`, taxes, the
  catalog `price` and a new `lineId`.
- **When it fails:** 400 when the entry, product or price list is inactive or out of its
  validity window.
- **Give it a `uuid`** (`crypto.randomUUID()`), as the app does for every new line. Payment
  plans and approvals point to it.
- **Change only editable fields:** `quantity`, `unitMultiplier`, `startDate`, `endDate`,
  `discountRate` (decimal), `discountAmount` (per unit), `internalNotes`, `specialNotes`,
  `description`, `customFields`. On calculation the server reloads everything else from the
  catalog.
- **Charged quantity** = `quantity` × `unitMultiplier` (from the line, else the quote, else 1).
- **`quoteMode === 'Events'`:** each line carries the dates of its day, as the editor stamps
  them.
  - `startDate` = midnight of that day; `endDate` = midnight of the **next** day (exclusive).
  - Use the user's time zone (profile, then account): `ProlibuQuote.eventDay('2026-11-05',
    'America/Bogota')`. `await ProlibuQuote.userTimeZone()` reads the profile's; when it is
    `null`, the account's applies, and only admins can read that one: make it a setting of the
    site.
  - `endDate = startDate` is wrong. Lines of the same event share the same dates.
- **`price` is editable too.** If you send it, the engine uses **your** price instead of the
  catalog's. Leave it as it comes unless the client asks for a manual price.
- **To edit an existing line,** find it by `uuid` among the lines that arrived, change only
  editable fields and send the full list. When you change a discount, send both
  `discountRate` and `discountAmount`, with the other one set to 0: when both are set,
  `discountAmount` wins.

## 3. Publish with this CLI and switch it on

1. **Lay out the site by hand.** `site create` asks interactive questions an agent cannot
   answer.

   ```
   accounts/<domain>/sites/<prefix>/
     config.json          {"siteType": "Static"}
     public/index.html    your page (start from assets/example/index.html)
     public/prolibu-extended-quote.js   copied from assets/
   ```

   `index.html` must be at the root of `public/`: the package is zipped from there, and
   without it the server answers 400.
2. **Publish a test copy.** Show the user what will be published and where, wait for a yes,
   then run `./prolibu site dev --domain <domain> --prefix <prefix> --no-git`. It creates or
   updates the Site `<prefix>-dev` and prints its URL. Do not use `--watch`: a local server has
   no session and the editor cannot reach it.
3. **Switch it on.** An admin sets the URL `https://<domain>/site/<siteCode>/` in the account
   preferences, under deals › quote › extended quote (`modules.sales.deals.quote.extendedQuote
   = { enabled: true, url }`), or in a workspace's `extendedQuote`. The workspace wins only
   when it has both `enabled` and `url`. Tell the user what to set; do not change account
   preferences yourself.
4. **Test on a NEW test deal** in a non-production account, never with client data.
5. **Publish for real** with `./prolibu site prod --domain <domain> --prefix <prefix> --no-git`,
   after its own yes. Each publish replaces the whole package.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| Virtual lines | Line built by hand without `pricebookEntry` (or with `unitPrice`, which does not exist: it is `price`) | `formatLineItem` |
| Existing lines disappear on apply | Only the new lines were sent | Full list |
| Applying twice duplicates lines | The new lines were added to the old list twice | After sending, take what you sent as the current list |
| The modal errors after 15 s (V2) | The site waited for the host to speak first | `form:get:model` on load |
| Silent modal, nothing answers | Site on another origin (redirect, CDN, short link) | `https://<domain>/site/<siteCode>/` |
| 401 or no token | Site outside the app's domain, or expired session | Prolibu Site; sign in again |
| 400 "All line items must have the same currency." | Entry in another currency, on an account that enforces one per quote | Filter by `quoteCurrency` |
| 400 "Custom exchange rates has been disabled…" | Entry in another currency, on an account that forbids them | Filter by `quoteCurrency` |
| An event line lands on another day | `endDate = startDate`, a date without time, or the browser's time zone | Midnight to midnight in the user's time zone |
| Odd dates, `__id` or `[object Object]` | Payload used without deserializing | Deserialize |
| Made-up protocol (`site:ready`, `suite:init`…) | Assumed a contract that does not exist | Only the 4 messages in the table |

For what the server keeps or overwrites on each line, the automatic service charge and
currency rules, see `../prolibu-quotes/references/quote-model.md`.

## Verify before handing over

- [ ] After **Calculate** and save, the deal (`node .claude/skills/prolibu-quotes/scripts/quote.js
      show <domain> <dealId>`) shows every new line as `catalog`, not `virtual`.
- [ ] The previous lines are still there, and applying twice does not duplicate.
- [ ] The new lines' currency is the quote's; in Events, each line falls on its day.
- [ ] Tested in the quote editor the account uses (V1, V2 or both).

Publishing follows [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): summary, explicit
yes, run, read back. For general Site behavior, see `prolibu-sites`.
