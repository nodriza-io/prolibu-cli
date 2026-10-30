---
name: prolibu-endpoints
description: Expose a custom inbound URL on a Prolibu account — an Endpoint record that runs one of your Scripts at /v2/endpoint/<verb>/<routeName> and answers { authenticated, output }. Covers writing the EndpointRequest handler, publishing it with this CLI, creating or changing the Endpoint, choosing authenticated or public, role gating, webhook receivers with a shared secret or an HMAC signature, the API-proxy pattern, and testing the URL with and without a token. Use it whenever someone wants an inbound API, a webhook or callback URL, a server-side action a site or another system can call, or reports an endpoint answering 401, 403, 404 or 400, "requestUser is not defined", an empty output, or a signature that never matches. Spanish triggers: "endpoint", "webhook entrante", "URL de callback", "API propia", "recibir un webhook", "exponer un script".
---

# Prolibu Endpoints

## Central idea

An endpoint is two records:

1. a **Script** with the logic, written and published with this CLI;
2. an **Endpoint** that binds `https://<domain>/v2/endpoint/<verb>/<routeName>` to that script.

The platform runs the script with `eventName === 'EndpointRequest'`, the script sets `output`,
and the caller gets `{ "authenticated": <bool>, "output": <output> }`.

The CLI has no command for Endpoint records. `scripts/endpoint.js` does that part in code: it
validates the plan, resolves the script, refuses route names the server rejects, writes only
what changed, reads it back, and calls the URL with or without a token.

```
node .claude/skills/prolibu-endpoints/scripts/endpoint.js <command> <domain> …
  list    <domain> [<part of routeName>]
  show    <domain> <routeName>
  roles   <domain> <part of a role name>
  preview <domain> '<plan json>'
  apply   <domain> '<plan json>' --confirmed
  call    <domain> <routeName> --confirmed [--no-auth] [--method <verb>] [--data '<json>']
          [--query 'a=1&b=2'] [--header 'name: value']
```

Output is JSON. Exit codes: 0 ok, 1 API error (or a call that did not answer 2xx), 2 usage
(nothing sent), 3 blocked (nothing written).

## Ask the user first

1. **Who calls it?** A page on a Prolibu Site, a server, or a third-party webhook.
2. **With a Prolibu token or public?** Public means anyone with the URL runs the script.
3. **If public, how does the sender prove itself?** A shared-secret header, or an HMAC
   signature (which header, which encoding, signed over what).
4. **Only some roles?** Name them; you look up the ids with `roles`.
5. **Which account and which route name?** Short, lowercase, with hyphens: `orders-push`.

## Steps

1. **Write the handler** in `accounts/<domain>/scripts/<prefix>/index.js`. Do not run
   `./prolibu script create`: it prompts. Start from this:

   ```js
   /* global eventData, output, variables */
   const Events = require('../../../../lib/vendors/prolibu/EventManager');

   const getVar = (key) => (variables || []).find((v) => v.key === key)?.value;
   const caller = () => (typeof requestUser === 'undefined' ? null : requestUser);

   Events.on('EndpointRequest', async () => {
     const { body, query, headers } = eventData;
     // … your logic; expected failures go back as data, not as a throw
     output = { ok: true };
   });

   (async function main() { await Events.init(); })(); // keep this the last statement
   ```

   The CLI bundles with esbuild, so `require` of repo files works (`lib/vendors/*`,
   `lib/utils/*`) and of npm packages that do not need Node built-ins.
2. **Decide where the secrets live** (third-party keys, the webhook secret). Pick one:
   - In the app, on the Script's variables. Then create `config.json` yourself **without**
     a `variables` key: `{ "lifecycleHooks": [] }`.
   - In the folder: `config.json` with `"variables": [{ "key": "…", "value": "…" }]`. Do not
     commit that folder to a shared remote.

   Every publish replaces the script's variables with `config.json`'s `variables` when the
   key is there. Without a `config.json`, the first publish writes one with
   `"variables": []`, which then wipes the variables set in the app.
3. **Publish the script** after a yes:
   `./prolibu script dev --domain <domain> --prefix <prefix> --no-git`. It creates or updates
   the Script `<prefix>-dev`. Never add `--watch`: it waits for key presses.
4. **Preview the Endpoint.** Plan, inline in single quotes:

   ```json
   { "routeName": "orders-push", "endpointName": "Orders push", "method": "POST",
     "script": "<prefix>-dev", "authentication": { "enabled": true, "requiredRoles": [] } }
   ```

   `script` takes a scriptCode or a Script `_id`. `authentication.enabled` is required on a
   new endpoint. Run `preview <domain> '<plan>'`. Tell the user the action (create, update,
   none), the URL, each change and every warning.
5. **Apply after a clear yes**: `apply <domain> '<same plan>' --confirmed`. It reads the
   endpoint back and lists `problems` if something did not stick.
6. **Test both ways**, after telling the user it runs the script:
   `call <domain> <routeName> --confirmed --data '{…}'` and the same with `--no-auth`.
   An authenticated endpoint must answer 401 without a token; a public one must reject a
   wrong secret in `output`.
7. **Go live.** Publish the prod copy (`./prolibu script prod --domain <d> --prefix <p>
   --no-git`, Script `<prefix>`), then preview and apply the plan with `"script": "<prefix>"`.

## How the platform behaves

The full contract, the webhook and proxy examples, and every error shape are in
`references/endpoint-contract.md`. Read it for anything outside these steps.

- **URL.** `https://<domain>/v2/endpoint/<verb>/<routeName>`, verb in lowercase (the match
  is case-insensitive). The verb in the path must equal the HTTP verb you send, or Express
  answers an HTML 404. Any verb reaches the endpoint, whatever its `method`; the script
  cannot tell which one was used.
- **routeName** is unique across all methods (a second `orders` is rejected), 1–63 letters,
  digits, `-` or `_`, and looked up case-sensitively.
- **Authentication** is on by default. It reads only `Authorization: Bearer <token>` (or
  Basic `apiKey:<token>`). The session cookie and `?apiKey=` alone do not count. On a public
  endpoint, any `Authorization` header that is not a valid token gives 401.
- **Roles.** `requiredRoles` lets through admins and users with at least one of those
  roles; others get 403. It applies only when authentication is on.
- **What the script gets.** `eventData = { endpoint, authenticated, headers, query, body }`.
  - `headers`: every request header in lowercase, including `authorization` and `cookie`.
  - `query`: values are strings.
  - `body`: JSON → object, `text/plain` → string, form-urlencoded → object, nothing → `{}`.
    Invalid JSON is rejected with 400 before the script runs. The raw bytes are not
    available.
- **`requestUser` exists only when the caller is authenticated.** Reading it on an anonymous
  call throws `requestUser is not defined`; use `typeof` as in the template. Its `email`,
  names and `isAdmin` are usable; `_id`, `company` and `roles` arrive as empty objects.
- **The caller's token is not for the script.** To read or write the account, the script
  uses its own key from `variables` (`lib/vendors/prolibu/ProlibuApi`).
- **Errors** are `{ statusCode, error }`, not the envelope: 400 for a throw, a rejection, a
  timeout (default 30 s), or an inactive endpoint or script; 401; 403; 404. A thrown
  message reaches the caller verbatim.
- **Origins.** A request whose `Origin` is not the account's domain, `*.prolibu.com`,
  localhost or an origin an admin allowed gets an HTML 404. Browsers always send `Origin`;
  most servers do not.
- **No rate limit per endpoint.** A 429 means the caller's IP was banned account-wide.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| 401 "Authentication required…" | No Bearer token on an authenticated endpoint | Send `Authorization: Bearer <token>`, or make it public on purpose |
| 401 on a public endpoint | The sender adds its own `Authorization` header | Put its secret in another header (`x-…-secret`) |
| 403 "Forbidden, you do not have the required role…" | Caller lacks `requiredRoles` | Give the role, or change the roles |
| HTML 404 "Cannot POST …" | Path verb ≠ HTTP verb, or a browser origin not allowed | Match them; call from the account's domain |
| JSON 404 | Unknown or differently cased `routeName` | `list` and copy the exact name |
| 400 "requestUser is not defined" | Anonymous call, script reads `requestUser` | `typeof requestUser === 'undefined'` |
| 400 "Endpoint is not active" / "script is not active" | One of the two is off | Turn it on in the plan or the app |
| 400 "Script execution timeout" | The script ran past its timeout | Do less per call, or raise `timeout` (max 300000 ms) |
| 200 with `output: null` | `output` never set, or `Events.init()` is not the last statement | Set `output`; keep the template's last line |
| Variables vanished after a publish | `config.json` has `variables` (or was auto-created) | Step 2 |
| HMAC never matches | Sender signs bytes that `JSON.stringify(body)` does not rebuild | `references/endpoint-contract.md`, "HMAC" |

## Verify

- `show <domain> <routeName>`: right script (the prod one when live), `active`, the auth
  you agreed.
- `call` with and without a token answers as expected, and the response has `output`.

## Don't

- Echo, log or store `eventData.headers`: they carry the caller's token and cookies.
- Put a third-party key in a site bundle or a URL; keep it in the script's variables.
- Throw provider errors or anything with a credential; return `{ ok: false, reason }`.
- Plan one `routeName` for two verbs, use uppercase route names, or leave a live endpoint on
  a `-dev` script.
- Create the Endpoint with a hand-made `POST /v2/endpoint`; use `scripts/endpoint.js`.

## Writing to an account

Publishing the script and every `apply` or `call` follow
[`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads only, plain summary,
explicit yes, write, read back. The script sandbox in general is in `prolibu-scripts`;
pages that call an endpoint are in `prolibu-sites`; outbound webhooks are in
`prolibu-webhooks`.
