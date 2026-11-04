# Endpoint contract, verified

Read this when a case falls outside the steps in `SKILL.md`. Everything here was checked
against the server code and with live calls.

## The Endpoint record

| Field | Notes |
| --- | --- |
| `endpointName` | Required. Display name. |
| `routeName` | Required, unique across **all** endpoints of the account (any method). 1–63 of `A-Z a-z 0-9 - _`. The URL lookup is case-sensitive: use lowercase. |
| `method` | `GET`, `POST` (default), `PUT` or `DELETE`. Only decides the URL shown in the app; the route answers every verb. |
| `script` | Required. The Script `_id`. |
| `active` | Default `true`. Off → 400 "Endpoint is not active". |
| `authentication.enabled` | Default `true`. |
| `authentication.requiredRoles` | Role ids. Checked only when authentication is on. Admins always pass. |
| `endpointCode` | Generated (`ENP-…`). Read-only. |

`GET /v2/endpoint/<_id or endpointCode>` reads one; the list takes
`xquery={"routeName":"<name>"}`. A `PATCH` merges `authentication` key by key but replaces
`requiredRoles` whole; `scripts/endpoint.js` always sends `authentication` complete.

## The request

```
https://<domain>/v2/endpoint/<get|post|put|delete>/<routeName>[?query]
```

- The verb segment is matched without case, and must be the HTTP verb you send:
  `POST …/get/x` answers an HTML 404 "Cannot POST".
- Any verb segment reaches the endpoint, whatever its `method`.
- An `Origin` header from a site that is not the account's domain, `*.prolibu.com`,
  localhost, or an origin an admin allowed in the account's security settings gets an HTML
  404 (CORS). Browsers always send `Origin`; most servers do not.
- Body parsing, by `Content-Type`:

  | Content-Type | `eventData.body` |
  | --- | --- |
  | `application/json` | parsed object (invalid JSON → 400 "Invalid JSON", the script never runs) |
  | `text/plain` | the raw text, as a string |
  | `application/x-www-form-urlencoded` | parsed object, values are strings |
  | none | `{}` |

## Authentication

| Request | Public endpoint | Authenticated endpoint |
| --- | --- | --- |
| No `Authorization` header | runs, `authenticated: false` | 401 "Authentication required to access this endpoint" |
| `Bearer <valid token>` | runs, `authenticated: true` | runs, `authenticated: true` |
| `Bearer <invalid>` or any other scheme | **401** | 401 |
| Only the session cookie, or `?apiKey=` | runs, `authenticated: false` | 401 |

Expired token and inactive user also give 401. A valid caller without any `requiredRoles`
gets 403 "Forbidden, you do not have the required role to access this endpoint".

## What the script receives

Globals: `eventName` (`'EndpointRequest'`), `eventData`, `variables`, `setVariable`, `axios`,
`localDomain`, `env`, `scriptCode`, `console`, `output` (starts `null`), and `requestUser`
only when the caller is authenticated.

| `eventData` | Contents |
| --- | --- |
| `endpoint` | `{ _id, endpointCode, endpointName, routeName, method, url }`. `url` prints the verb in uppercase; it is informational. |
| `authenticated` | `true` when a valid token came in. |
| `headers` | Every request header, lowercase names, including `authorization` and `cookie`. |
| `query` | Query string; values are strings. |
| `body` | See the table above. |

`requestUser` keys: `_id`, `firstName`, `lastName`, `email`, `company`, `isAdmin`, `roles`.
Ids do not survive the trip into the sandbox: `_id` arrives as `{}`, and `company` and the
items of `roles` are ids too. Identify the caller by `email`; restrict by role with
`requiredRoles` on the Endpoint, not in code.

There is no `require` at run time, no `Buffer`, `crypto`, `TextEncoder`, `atob`, `btoa` or
`fetch`. The CLI's bundle brings what you `require` from the repo (`lib/utils/hmacSha256.js`
is pure JavaScript). Use `axios` for HTTP.

## The response

| Situation | Status | Body |
| --- | --- | --- |
| Success | 200 | `{ "authenticated": <bool>, "output": <value> }` |
| `output` never set | 200 | `{ "authenticated": <bool>, "output": null }` |
| Script threw or a promise rejected | 400 | `{ "statusCode": 400, "error": "<the message>" }` |
| Script ran past `timeout` (default 30000 ms, 5000–300000) | 400 | `… "error": "Script execution timeout"` |
| Endpoint inactive | 400 | `… "error": "Endpoint is not active"` |
| Script inactive | 400 | `… "error": "Script is not active"` (translated) |
| Invalid JSON body | 400 | `… "error": "Invalid JSON"` |
| Authentication | 401 | `{ "statusCode": 401, "error": … }` |
| Missing role | 403 | `{ "statusCode": 403, "error": … }` |
| Unknown `routeName` | 404 | `{ "statusCode": 404, "error": "Not found" }` (translated) |
| Path verb ≠ HTTP verb, or origin not allowed | 404 | HTML page "Cannot <VERB> …" |
| Caller's IP banned on the account | 429 | `{ "error": "Suspicious activity detected." }` |

Error texts follow the account's language. There is no per-endpoint rate limit.

## Webhook receiver with a shared secret

Public endpoint (`authentication.enabled: false`), `POST`. The sender puts the secret in a
header of its own (never in `Authorization`, which would give 401).

```js
/* global eventData, output, variables */
const Events = require('../../../../lib/vendors/prolibu/EventManager');
const { timingSafeEqual } = require('../../../../lib/utils/hmacSha256');

const getVar = (key) => (variables || []).find((v) => v.key === key)?.value;

Events.on('EndpointRequest', async () => {
  const secret = getVar('hookSecret');
  const sent = String(eventData.headers['x-hook-secret'] || '');
  if (!secret || !timingSafeEqual(secret, sent)) {
    output = { ok: false };   // not a throw: a 400 tells a prober the route exists
    return;
  }
  // Treat the body as untrusted. Prefer re-reading the object from the sender by id.
  output = { ok: true };
});

(async function main() { await Events.init(); })();
```

## HMAC signatures

`lib/utils/hmacSha256.js` gives `hmacSha256Hex(key, message)`, `hmacSha256Bytes`,
`sha256Hex` and `timingSafeEqual`. The catch is the message: providers sign the **raw
bytes** of the body, and the script only gets the parsed body.

- `text/plain` body: `eventData.body` is the raw text. Sign-check it directly.
- JSON body: rebuild it with `JSON.stringify(eventData.body)`. That equals the raw bytes
  only when the sender sent compact JSON: no spaces or line breaks, no escaped `\/` or
  `\uXXXX`, numbers written the way JavaScript prints them (`10`, not `10.0`), and no
  integer-like keys after other keys. Verified: compact JSON with accents matches; pretty
  JSON, `10.0` or `\/` do not.
- Check the exact recipe in the provider's docs: some sign `timestamp + "." + body`, some
  prefix the header with `sha256=`, some use base64 instead of hex.

```js
const { hmacSha256Hex, hmacSha256Bytes, timingSafeEqual } = require('../../../../lib/utils/hmacSha256');

// base64 without btoa or Buffer (checked against Node's crypto).
function toBase64(bytes) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63]
      + (i + 1 < bytes.length ? A[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? A[n & 63] : '=');
  }
  return out;
}

Events.on('EndpointRequest', async () => {
  const raw = typeof eventData.body === 'string' ? eventData.body : JSON.stringify(eventData.body);
  const secret = getVar('hookSecret');
  const header = String(eventData.headers['x-signature'] || '');
  const expected = hmacSha256Hex(secret, raw);                  // or toBase64(hmacSha256Bytes(secret, raw))
  if (!secret || !timingSafeEqual(expected, header.replace(/^sha256=/, ''))) {
    output = { ok: false };
    return;
  }
  output = { ok: true };
});
```

When the signature cannot match (pretty JSON you cannot change), use a shared-secret header,
or verify by re-reading the object from the provider's API by id.

## API proxy (keep a third-party key off the browser)

Authenticated endpoint. A page on a Prolibu Site calls it with the visitor's session token
(see `prolibu-sites`); the script calls the provider with a key from `variables` and
returns only what the page needs.

```js
// In the site
const res = await fetch('/v2/endpoint/post/weather-lookup', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ city: 'Bogota' }),
});
const { output } = await res.json();
```

```js
// In the script
Events.on('EndpointRequest', async () => {
  const city = String(eventData.body.city || '').slice(0, 80);
  if (!city) { output = { ok: false, reason: 'city is required' }; return; }
  try {
    const { data } = await axios.get('https://api.provider.example/v1/weather', {
      params: { q: city }, headers: { 'x-api-key': getVar('providerKey') }, timeout: 10000,
    });
    output = { ok: true, temperature: data.temp };          // a subset, never the raw reply
  } catch (err) {
    console.error('provider failed', err.response && err.response.status);
    output = { ok: false, reason: 'provider unavailable' };  // no provider message, no key
  }
});
```

To read or write the Prolibu account itself, the script uses its own API key from
`variables` with `lib/vendors/prolibu/ProlibuApi` (`new ProlibuApi({ apiKey })`), never the
caller's token from the headers. Give that key the least privilege the job needs.
