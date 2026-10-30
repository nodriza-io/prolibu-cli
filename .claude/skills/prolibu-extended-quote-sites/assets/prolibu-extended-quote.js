/*!
 * prolibu-extended-quote.js — OPTIONAL helper for Prolibu Sites used as an "Extended quote".
 * It implements what SKILL.md describes: the messages with the quote editor and the search for
 * real catalog products. No dependencies: copy this file next to the site's index.html, or paste
 * it into an inline <script>.
 *
 *   const host = ProlibuQuote.connect()          // call it AS SOON AS the page loads
 *   const deal = await host.getDeal()            // the deal, with the editor's LIVE quote
 *   const { items } = await ProlibuQuote.searchProducts('chair', { currency: host.quote().quoteCurrency })
 *   const line = await ProlibuQuote.lineItemFromEntry(items[0].entryId, { quantity: 3 })
 *   host.applyLineItems([...host.quote().lineItems, line])   // ALWAYS the full list
 *   host.close()
 *
 * Contract (do not invent another one): form:get:model → form:get:model:response → form:set:model → form:close.
 */
/* global window */
(function (global) {
  'use strict'

  const MSG = Object.freeze({
    GET: 'form:get:model',
    GET_RESPONSE: 'form:get:model:response',
    SET: 'form:set:model',
    CLOSE: 'form:close',
  })

  // Line fields the pricing engine KEEPS when it calculates. Everything else (product, price list,
  // catalog taxes, images…) is stamped again by the server from the catalog.
  const EDITABLE_FIELDS = new Set([
    'productName', 'description', 'quantity', 'unitMultiplier', 'numberOfPayments', 'currency',
    'cost', 'price', 'startDate', 'endDate', 'discountRate', 'discountAmount', 'internalNotes',
    'specialNotes', 'percentOfTotal', 'percentOfTotalBase', 'taxes', 'hiddenLineItemsValues',
    'customFields', 'snippets',
  ])

  class QuoteSiteError extends Error {
    constructor (code, message, extra) {
      super(message)
      this.name = 'ProlibuQuoteError'
      this.code = code
      Object.assign(this, extra)
    }
  }

  // ─── Session and API ───────────────────────────────────────────────────────────

  // Sites built with prolibu-cli may carry `window.__PROLIBU_CONFIG__.apiBaseUrl`
  // (https://<domain>/v2). Without it, a site hosted by Prolibu is on the SAME origin as the app.
  const cliConfig = global.__PROLIBU_CONFIG__ || {}
  const config = {
    baseUrl: cliConfig.apiBaseUrl ? new URL(cliConfig.apiBaseUrl).origin : global.location.origin,
    getToken: readAppToken,
  }

  /** The app's session token. It only exists when the site is on the same origin as the app. */
  function readAppToken () {
    let raw = null
    try { raw = global.localStorage.getItem('apiKey') } catch { return null }
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) // the app stores it as a JSON string
      return typeof parsed === 'string' ? parsed : null
    } catch {
      return raw
    }
  }

  function configure (overrides) {
    Object.assign(config, overrides || {})
  }

  async function api (path, query, { signal } = {}) {
    const token = config.getToken()
    if (!token) {
      throw new QuoteSiteError('NO_SESSION',
        'No Prolibu session on this origin. Serve the site on the same domain as the app (a Prolibu Site).')
    }
    const url = new URL(path, config.baseUrl)
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
    }
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      const message = (body && (body.error || body.message)) || `${res.status} ${res.statusText}`
      const code = /too many/i.test(message) ? 'TOO_MANY' : `HTTP_${res.status}`
      throw new QuoteSiteError(code, message, { status: res.status, body })
    }
    return body
  }

  /**
   * Searches the catalog with the SAME endpoint as the quote editor's search box. Returns one row
   * per price-list entry (a product in 2 price lists = 2 rows).
   *
   * @param {string} term  at least 2 characters (shorter terms make the server answer "Too many products found")
   * @param {{ pricebookId?: string, currency?: string, page?: number, limit?: number,
   *           xquery?: object, signal?: AbortSignal }} [opts]
   * @returns {Promise<{ items: Array, hasMore: boolean, total: number }>}
   */
  async function searchProducts (term, { pricebookId, currency, page = 1, limit = 20, xquery = {}, signal } = {}) {
    const trimmed = String(term || '').trim()
    if (trimmed.length < 2) return { items: [], hasMore: false, total: 0 }
    const body = await api('/v2/quote/productsearch', {
      term: trimmed,
      pricebookId,
      page,
      limit,
      xquery: { active: true, ...xquery },
    }, { signal })
    const products = (body && body.data) || []
    const pagination = (body && body.pagination) || {}
    const items = products.flatMap((product) => (product.pricebookEntries || []).map((entry) => ({
      entryId: entry._id,
      productId: product._id,
      productName: product.productName,
      productCode: product.productCode,
      description: product.description,
      price: entry.price,
      currency: entry.currency,
      pricebookId: entry.pricebook && entry.pricebook._id,
      pricebookName: (entry.pricebook && entry.pricebook.pricebookName) || '',
    })))
    return {
      items: currency ? items.filter((item) => item.currency === currency) : items,
      hasMore: Number(pagination.lastPage) > Number(page),
      total: Number(pagination.count) || 0,
    }
  }

  /**
   * Every product of one price list, one row per entry (an empty search term lists them all).
   * @param {string} pricebookId
   * @param {{ currency?: string, limit?: number, signal?: AbortSignal }} [opts]
   */
  async function listPricebook (pricebookId, { currency, limit = 100, signal } = {}) {
    if (!pricebookId) throw new QuoteSiteError('BAD_ARGS', 'Missing the price list id.')
    const body = await api('/v2/quote/productsearch', {
      term: '', pricebookId, page: 1, limit, xquery: { active: true },
    }, { signal })
    const rows = []
    for (const product of (body && body.data) || []) {
      for (const entry of product.pricebookEntries || []) {
        const pricebook = entry.pricebook && typeof entry.pricebook === 'object' ? entry.pricebook : { _id: entry.pricebook }
        if (pricebook._id !== pricebookId) continue
        if (currency && entry.currency !== currency) continue
        rows.push({
          entryId: entry._id,
          productId: product._id,
          productName: product.productName,
          productCode: product.productCode,
          description: product.description,
          price: entry.price,
          currency: entry.currency,
          pricebookId,
          pricebookName: pricebook.pricebookName || '',
        })
      }
    }
    return rows
  }

  /**
   * The signed-in user's time zone from their profile, or null when the profile has none
   * (then the account's zone applies, which only admins can read: pass it in explicitly).
   */
  async function userTimeZone ({ signal } = {}) {
    const me = await api('/v2/user/me', {}, { signal })
    return (me && me.profile && me.profile.locale && me.profile.locale.timeZone) || null
  }

  /**
   * The REAL line as the server builds it for that price-list entry (with `pricebookEntry`,
   * `product`, `pricebook`, taxes, a new `lineId`…). This is the line: do not rebuild it by hand.
   * `overrides` accepts editable fields only (quantity, dates, discount…).
   */
  async function lineItemFromEntry (pricebookEntryId, overrides = {}, { signal } = {}) {
    if (!pricebookEntryId) throw new QuoteSiteError('BAD_ARGS', 'Missing the price-list entry id.')
    const line = await api('/v2/quote/formatlineitem', { pricebookEntryId }, { signal })
    if (!line || !line.pricebookEntry) {
      throw new QuoteSiteError('NOT_A_PRODUCT', 'The server did not return a product line for that entry.')
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (!EDITABLE_FIELDS.has(key)) {
        throw new QuoteSiteError('NOT_EDITABLE', `"${key}" is not editable on a product line: calculation overwrites it from the catalog.`)
      }
      line[key] = value
    }
    // Every new line gets its own uuid, as the app does: payment plans and approvals point to it.
    if (!line.uuid && global.crypto && typeof global.crypto.randomUUID === 'function') line.uuid = global.crypto.randomUUID()
    return line
  }

  // ─── Host serialization (the app's postMessage serializer) ──────────────────────

  /** The host sends the deal serialized: objects with `__id`, refs `{__ref}` and dates `{__type:'date'}`. */
  function deserialize (obj) {
    const byId = new Map()
    ;(function collect (value) {
      if (!value || typeof value !== 'object' || value.__ref != null) return
      if (value.__id != null) byId.set(value.__id, Array.isArray(value) ? [] : {})
      Object.values(value).forEach(collect)
    })(obj)
    return (function resolve (value) {
      if (value === null || value === undefined || typeof value !== 'object') return value
      if (value.__ref != null) return byId.get(value.__ref)
      if (value.__type === 'date') return value.value // ISO string: what the editor expects back
      if (value.__type === 'map') return new Map(value.entries.map(([k, v]) => [resolve(k), resolve(v)]))
      if (value.__type === 'set') return new Set(value.values.map(resolve))
      const target = value.__id != null ? byId.get(value.__id) : (Array.isArray(value) ? [] : {})
      for (const [key, v] of Object.entries(value)) {
        if (key !== '__id') target[key] = resolve(v)
      }
      return target
    })(obj)
  }

  /** Plain JSON (no functions, Maps or `__id`) to send back to the host. */
  const plain = (value) => JSON.parse(JSON.stringify(value))

  // ─── Messages with the quote editor ─────────────────────────────────────────────

  function parentOrigin () {
    try {
      if (global.document.referrer) return new URL(global.document.referrer).origin
    } catch { /* unreadable referrer */ }
    return global.location.origin
  }

  /**
   * Connects to the quote editor. Call it on load: the editor's modal shows an error if the site
   * does not talk to it within 15 s (getDeal() is that first message).
   */
  function connect ({ timeoutMs = 10000 } = {}) {
    const origin = parentOrigin()
    const embedded = global.parent && global.parent !== global
    // Lines that were ALREADY in the quote (by identity or by lineId/uuid) pass without checks.
    const knownLines = new Set()
    let knownObjects = new WeakSet()
    let lastDeal = null
    const isKnown = (line) => knownObjects.has(line) || Boolean(lineKey(line) && knownLines.has(lineKey(line)))

    function remember (lines) {
      knownLines.clear()
      knownObjects = new WeakSet()
      for (const line of lines) {
        if (line && typeof line === 'object') knownObjects.add(line)
        const key = lineKey(line)
        if (key) knownLines.add(key)
      }
    }

    function post (message) {
      if (!embedded) throw new QuoteSiteError('NOT_EMBEDDED', 'The site is not open inside the quote editor (iframe).')
      global.parent.postMessage(message, origin)
    }

    function getDeal () {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup()
          reject(new QuoteSiteError('NO_HOST', 'The quote editor did not answer form:get:model. Is the site open from "Extended quote"?'))
        }, timeoutMs)
        function onMessage (event) {
          if (event.source !== global.parent || event.origin !== origin) return
          if (!event.data || event.data.type !== MSG.GET_RESPONSE) return
          cleanup()
          try {
            const raw = typeof event.data.payload === 'string' ? JSON.parse(event.data.payload) : event.data.payload
            const data = deserialize(raw)
            lastDeal = (data && data.value) || data || {}
            remember(quote().lineItems)
            resolve(lastDeal)
          } catch (err) {
            reject(new QuoteSiteError('BAD_PAYLOAD', `Could not read the deal: ${err.message}`))
          }
        }
        function cleanup () {
          clearTimeout(timer)
          global.removeEventListener('message', onMessage)
        }
        global.addEventListener('message', onMessage)
        try {
          post({ type: MSG.GET, payload: JSON.stringify({ modelName: 'deal' }) })
        } catch (err) {
          cleanup()
          reject(err)
        }
      })
    }

    /** The quote from the last getDeal(), with `lineItems` always an array (it can be missing on a new deal). */
    function quote () {
      const q = (lastDeal && lastDeal.proposal && lastDeal.proposal.quote) || {}
      return { ...q, lineItems: Array.isArray(q.lineItems) ? q.lineItems : [] }
    }

    /**
     * Replaces ALL the quote's lines with `lineItems`. The host does not add: whatever is not sent
     * here is removed from the editor. Rejects NEW lines without `pricebookEntry` (they would be
     * virtual); virtual lines that were already in the quote pass untouched.
     */
    function applyLineItems (lineItems, { allowVirtual = false } = {}) {
      if (!lastDeal) throw new QuoteSiteError('NO_DEAL', 'Call getDeal() before applying lines.')
      if (!Array.isArray(lineItems)) throw new QuoteSiteError('BAD_ARGS', 'lineItems must be an array.')
      const newVirtual = lineItems.filter((line) => !(line && line.pricebookEntry) && !isKnown(line))
      if (newVirtual.length && !allowVirtual) {
        throw new QuoteSiteError('VIRTUAL_LINES',
          `${newVirtual.length} new line(s) without pricebookEntry would be virtual. Build them with lineItemFromEntry().`,
          { lines: newVirtual })
      }
      const sent = plain(lineItems)
      post({ type: MSG.SET, payload: JSON.stringify({ modelName: 'deal', value: { proposal: { quote: { lineItems: sent } } } }) })
      // The editor now holds THIS list: quote() reflects it, so a second "Apply" without closing
      // does not duplicate the lines just added.
      const proposal = lastDeal.proposal || {}
      lastDeal = { ...lastDeal, proposal: { ...proposal, quote: { ...(proposal.quote || {}), lineItems: sent } } }
      remember(sent)
    }

    function close () {
      post({ type: MSG.CLOSE })
    }

    return { getDeal, quote, applyLineItems, close, embedded, origin }
  }

  function lineKey (line) {
    return (line && (line.lineId || line.uuid || line._id)) || null
  }

  // Offset of an IANA time zone at a given instant, in ms (positive east of UTC).
  function zoneOffsetMs (epoch, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(epoch))
    const get = (type) => Number(parts.find((p) => p.type === type).value)
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - epoch
  }

  function midnight (y, m, d, timeZone) {
    if (!timeZone) return new Date(y, m - 1, d).toISOString()
    const wall = Date.UTC(y, m - 1, d)
    let epoch = wall
    for (let i = 0; i < 2; i += 1) epoch = wall - zoneOffsetMs(epoch, timeZone)
    return new Date(epoch).toISOString()
  }

  /**
   * Dates of a ONE-day line in a `quoteMode: 'Events'` quote, stamped the way the editor does it:
   * start = midnight of that day, end = midnight of the NEXT day (exclusive).
   * The editor uses the user's time zone (profile, then account). Pass it as `timeZone`
   * (e.g. 'America/Bogota'); without it the browser's zone is used and the day can shift.
   * @param {string} ymd 'YYYY-MM-DD' (the value of an <input type="date">)
   * @param {string} [timeZone] IANA time zone
   */
  function eventDay (ymd, timeZone) {
    const [y, m, d] = String(ymd || '').split('-').map(Number)
    if (!y || !m || !d) throw new QuoteSiteError('BAD_ARGS', 'Expected a date as YYYY-MM-DD.')
    return { startDate: midnight(y, m, d, timeZone), endDate: midnight(y, m, d + 1, timeZone) }
  }

  global.ProlibuQuote = {
    connect, searchProducts, listPricebook, lineItemFromEntry, eventDay, userTimeZone, api, configure, deserialize,
    QuoteSiteError, EDITABLE_FIELDS, MSG,
  }
})(window)
