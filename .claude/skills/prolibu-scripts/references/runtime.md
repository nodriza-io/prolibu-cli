# Script runtime: what the platform does with your code

Read this when a case falls outside the steps in `SKILL.md`: a global you are unsure of, an
event's payload, how a hook changes a record, schedules, or where an error went.

## How a run works

1. Something starts the run (table below) with an `eventName` and an `eventData`.
2. The platform loads the script by `_id` (from a cache), refuses it if it is inactive, and
   refuses it if its `lifecycleHooks` name an object the account has not enabled for hooks.
3. It starts a worker thread and runs `code` in a fresh JavaScript context with the globals
   below. The value of the code's **last statement** is awaited if it is a promise.
4. When that promise settles, the run ends and the worker is killed. The result is
   `{ output, eventData, error, errorStack?, timeMs }`: `output` is the global you assigned,
   `eventData` is read back from the context (hooks use it, see below).
5. If the time budget (`timeout`) runs out first, the worker is killed and the result is
   `{ output: null, error: "Script execution timeout" }`.

Async work that the last statement does not wait for is cut off without an error. That is why
the entry ends with `(async function main() { await Events.init(); })();`.

## Globals

| Global | What it is |
| --- | --- |
| `axios` | HTTP client (validates TLS certificates). Calls to the account's own host carry an internal origin header; that is all, they carry no identity. |
| `console.log/info/warn/error` | `log` only streams to `./prolibu script … --watch`. `info`, `warn` and `error` also go to the account log. |
| `output` | Starts `null`. Assign your result to it. Do not declare your own `output`. |
| `eventName`, `eventData` | What started the run and its payload (table below). |
| `variables` | `[{ key, value }]` as they were when the run started. |
| `setVariable(key, value)` | Async. Saves the pair on the script right away and resolves with `{ variables }`. The `variables` global does not change in this run. `null` or `undefined` values are rejected. |
| `localDomain` | The account's host, for calls to its own API. |
| `scriptCode` | This script's code, e.g. `my-hook-dev`. |
| `env` | `"prod"` when `scriptCode` ends with `-prod`, else `"dev"`. The CLI's production copy is `<prefix>`, so it gets `"dev"` too. |
| `locale` | The account's locale preferences. |
| `lifecycleHooks` | The objects listed on the script. |
| `requestUser` | Only when someone called the script: `_id`, `firstName`, `lastName`, `email`, `company`, `isAdmin`, `roles`. Absent in hooks and schedules: test with `typeof requestUser !== 'undefined'`. |
| `ai` | `ai.ask({ agent, prompt, … })` and `ai.run({ agent, input, … })` call the account's AI agents. Refused when the script itself was started by an agent or by another script's change. |
| `origin` | Who started the run and how deep the chain is. |
| `setTimeout`, `setInterval`, `setImmediate`, `clearTimeout`, `clearInterval` | Timers. |
| `URLSearchParams` | Query strings. |
| ECMAScript built-ins | `JSON`, `Date`, `Math`, `Promise`, `Map`, `Set`, `RegExp`, `Intl`, typed arrays, `WebAssembly`, `globalThis`, `eval`. |

**Not available:** `require`, `module`, `exports`, `process`, `global`, `Buffer`, `crypto`,
`fetch`, `URL`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `structuredClone`,
`queueMicrotask`, `clearImmediate`. The CLI's bundling makes up for the first ones (see
`cli.md`). For hashing use `lib/utils/hmacSha256` (SHA-256, HMAC-SHA256, constant-time
compare); `lib/vendors/fasa/FasaApi.js` has a pure-JS base64 (`FasaApi.toBase64`). The
server's clock is UTC: format dates with `Intl` and an explicit `timeZone`.

## What starts a run

| `eventName` | Started by | `eventData` | `requestUser` |
| --- | --- | --- | --- |
| `ApiRun` | `GET /v2/script/run?scriptId=<_id>&…` (also the app's Run button) | `{ query, body }` | the caller |
| `ScheduledTask` | the script's cron | `{ scheduledAt, periodicity }` | absent |
| `EndpointRequest` | an Endpoint record pointing at the script (see `prolibu-endpoints`) | `{ endpoint, authenticated, headers, query, body }` | the caller, if authenticated |
| `<Model>.beforeCreate` · `afterCreate` · `beforeDelete` · `afterDelete` | a record of that object | `{ doc }` | absent |
| `<Model>.beforeUpdate` · `afterUpdate` | a record of that object | `{ doc, payload, beforeUpdateDoc }` | absent |
| `Contract.beforeGenerate` | generating a contract from a template | `{ payload }` | absent |
| `Quote.calculate` | every quote calculation, when the script has `runOnQuoteCalculate: true` | `{ quote, origin }` | the caller |
| `Quote.runScripts` | a quote line whose product lists the script | `{ quote, lineItem, origin }` | the caller |
| `AiAction.<actionCode>` | an AI agent's script action | `{ input, variables, conversationId, origin }` | the conversation's user |

`EventManager` (`lib/vendors/prolibu/EventManager.js`) passes `ApiRun`, `ScheduledTask` and
`EndpointRequest` through. Any other name is `<Prefix>.<event>`, and its handler is dropped
(with a `[WARN] … ignored` console line) unless `<Prefix>` is in the script's
`lifecycleHooks`. So for `Quote.*`, `AiAction.*` and `Contract.beforeGenerate`, check
`eventName` yourself instead of `Events.on`.

Record payloads are JSON copies: dates and ids are strings, and encrypted fields are masked.

## Lifecycle hooks

- **Two switches.** The account must have hooks on and the object listed:
  `GET /v2/preference/read` → `preference.integrations.lifecycleHooks` =
  `{ enabled, enabledEntities }` (admins only). The app shows it under Preferences ›
  Integrations › Lifecycle hooks. Only an admin changes it. Then the script must be active
  and list the object in `lifecycleHooks`.
- Saving a script whose `lifecycleHooks` name an object that is not enabled fails with
  "The specified model is not enabled for lifecycle hooks." (or "Lifecycle hooks are not
  enabled."). A script already saved that way fails on **every** run, manual runs included.
- **Every active script that lists the object runs, one after the other,** on each event.
  The CLI's dev and production copies share `config.json`, so both run unless one is inactive.
- **Changing the record.** After a run the platform compares the `eventData.doc` and
  `eventData.payload` it sent with what the script left, and copies back the top-level fields
  that changed. In a `before…` event, changes to `eventData.doc` are saved with the record.
  Changing `eventData.payload` in `beforeUpdate` does not change what is saved (the payload
  is already applied to `doc`).
- **Errors.** If the run has an `error`, the request that changed the record fails with
  `"<message> - Lifecycle script [<scriptName>]"`. In a `before…` event nothing is saved,
  which is how a script blocks a change. In an `after…` event the record is already saved;
  only the response is an error.
- **No loop guard.** A hook that writes to the same object through the API starts itself
  again. Write only when the value actually changes, or check a field the write sets.
- The hook runs inside the user's request: its time adds to the save.

## Schedules

- Set `scheduledTask: { periodicity: "<cron>", timeZone: "<IANA zone>" }` and `active: true`
  with a `PATCH /v2/script/<_id>`. The CLI never sends these, so a deploy keeps them.
- The cron is validated on save; `timeZone` is required. Five fields, or six with seconds; on
  production accounts the seconds field must be `0` or `*` (at most once per minute).
- The schedule lives in memory on the account's leader server; a change made on another
  server is passed to it. `GET /v2/script/schedulerStatus` (admins) shows the registry of the
  server that answered: `replicaLeader`, `registeredTasks` (`scriptId`, `active|cron|zone`),
  `lastLoadAt`, `lastLoadError`. Call it a few times to reach every server.
- A tick is skipped while the previous run of the same script is still going.

## Variables

- `variables` is part of the record: anyone who can read the script can read them. Keep
  secrets there (never in `code`), and give the script a key with only the permissions it
  needs.
- `setVariable` saves immediately and is visible on the next run. Store strings
  (`String(n)`, `JSON.stringify(obj)`).
- Every `./prolibu script dev|prod` replaces the whole list with `config.json`'s. Values a
  script saved with `setVariable` (tokens, cursors) are lost on the next deploy unless they
  are also in `config.json`.

## Reading and writing account data

There is no database access. Call the account's REST API with the global `axios` and a key
stored in `variables`; `lib/vendors/prolibu/ProlibuApi.js` wraps it:

```js
const ProlibuApi = require('../../../../lib/vendors/prolibu/ProlibuApi');
const { getRequiredVars } = require('../../../../lib/utils/variables');
const { apiKey } = getRequiredVars({ apiKey: 'prolibu-api-key' });
const api = new ProlibuApi({ apiKey }); // domain defaults to localDomain
const page = await api.find('contact', { limit: 10, select: 'firstName email' }); // { pagination, data }
```

A call without a key answers 401: the script has no identity of its own. The usual API rules
apply (list envelope `{ pagination, data }`, `PATCH` replaces arrays and mixed fields whole).

## Errors and logs

- `GET /v2/script/run` answers **200 even when the script fails**: read `error` and
  `errorStack`. The `at line N` numbers point at `dist/bundle.js`, not `index.js`.
- It answers 4xx when the run is refused: not found, inactive, no permission, hooks not
  enabled.
- Stored log lines: `GET /v2/log?logType=Script&sort=-createdAt` with `status` `Info`,
  `Warning` or `Failure`, `message`, and `meta.{scriptId, scriptCode, eventName,
  errorStack}`. Every failed run adds a `Failure` line. Lines expire after 7 days. The list
  cannot be filtered by script on the server; `scripts/script.js logs` filters it locally.
- `console.log` is never stored. It only reaches a `--watch` session, live.

## Stale code when running by code

The run endpoint caches the script under the id you pass. Saving the script clears the entry
for its `_id` only. If you run by `scriptCode`, that entry is never cleared and later runs
keep executing the old code. Hooks, schedules, endpoints and `scripts/script.js run` all use
`_id`.
