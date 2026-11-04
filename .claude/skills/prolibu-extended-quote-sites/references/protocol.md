# Message protocol with the quote editor

Reference for `prolibu-extended-quote-sites`. The host is the V1 or V2 quote editor; the site is
the page in its iframe. Both editors speak the same contract.

## Messages

| Direction | `type` | `payload` |
|---|---|---|
| site → host | `form:get:model` | `'{"modelName":"deal"}'` (JSON string or object; missing = `deal`) |
| host → site | `form:get:model:response` | `JSON.stringify(serialized({ modelName, value: <deal> }))` |
| site → host | `form:set:model` | `'{"modelName":"deal","value":{"proposal":{"quote":{"lineItems":[…]}}}}'` |
| site → host | `form:close` | none: `{ type: 'form:close' }` |
| site → host | `close:<process>` | a raw string; `<process>` is the `?process=` query param the host adds to the URL |

Nothing else exists. `site:ready`, `suite:init`, `quote:update` and similar are ignored.

## The host never speaks first

- The site sends `form:get:model` as soon as it loads.
- V2 arms a 15 s watchdog when the iframe mounts. Any valid message from the site disarms it.
  Without one, the modal shows an error and a retry button (the iframe stays mounted, so a late
  site still recovers).
- V1 has no timeout and waits forever.
- V2 answers only `modelName: "deal"`. Any other name gets no answer, only a console warning,
  and the site waits forever. V1 answers any name, with `value: undefined` for unknown ones.

## What arrives

- The deal comes serialized by the app's postMessage serializer:
  - every object carries `__id`; a repeated object comes as `{__ref: n}`;
  - a date comes as `{__type: 'date', value: ISO}`; also `map`, `set`, `file`, `blob` types exist.
  - Deserialize before use (`deserialize()` in `assets/prolibu-extended-quote.js`).
- V2 sends the deal populated the way the deal drawer populates it, with `proposal.quote`
  **replaced by the builder's live, unsaved state**: header (currency, mode, dates…), the line
  tree flattened, and the payment plan.
- On a new, unsaved deal the draft form is sent; `lineItems` can be missing: treat it as `[]`.
- The iframe URL gets `?process=<id>` appended (if the configured URL is absolute and valid).

## What the host does with `form:set:model`

- It does **not** answer. Close with `form:close` (or `close:<process>`) after applying, or keep
  the list you sent as the current one.
- `lineItems` as an array **replaces** the whole list, in V1 and V2. Send the lines that arrived
  plus the new ones, never only the new ones.
- V2 adopts only `proposal.quote`: its header fields, `lineItems` and `paymentPlan`, as one undo
  step. Other deal keys are ignored with a console warning. A set with no `proposal.quote` (for
  example `{company}`) is ignored, not an error.
- V1 deep-merges the whole `value` into the open deal form (`updateManageModelSchema`), then
  replaces the editor's lines (`actSetLineItems`). So in V1 other deal fields, `company`
  included, DO change. Send only `proposal.quote.lineItems` so both editors behave alike.
- Neither recalculates. Totals stay provisional until **Calculate**; Save calculates first.
- V2 normalizes each incoming line (guarantees `uuid` and `productCode`). In Events mode it widens
  the event window to cover the days of the incoming lines; it never invents dates.
- A V2 `form:set:model` with a broken payload (unparseable, `value` not an object,
  `proposal.quote` not an object) shows an "unreadable payload" error.

## Origins

- V2 processes a message only if `event.source` is its own iframe's window AND `event.origin`
  equals the origin of the configured URL. Anything else is dropped; the first drop from the
  iframe logs `[extendedQuote] mensajes descartados…` once. A redirect or CDN to another origin
  therefore leaves the modal silent.
- V2 replies to `event.origin`. V1 checks nothing.
- The site should post to the parent's origin (`document.referrer`'s origin) and check
  `event.source === parent` and `event.origin` on what it receives.

## Sample (no helper)

```js
const PARENT = document.referrer ? new URL(document.referrer).origin : location.origin
const send = (type, payload) =>
  parent.postMessage(payload === undefined ? { type } : { type, payload: JSON.stringify(payload) }, PARENT)
addEventListener('message', (e) => {
  if (e.source !== parent || e.origin !== PARENT || e.data?.type !== 'form:get:model:response') return
  const deal = deserialize(JSON.parse(e.data.payload)).value
  // render with deal.proposal.quote
})
send('form:get:model', { modelName: 'deal' })
// later: send('form:set:model', { modelName: 'deal', value: { proposal: { quote: { lineItems: all } } } }); send('form:close')
```
