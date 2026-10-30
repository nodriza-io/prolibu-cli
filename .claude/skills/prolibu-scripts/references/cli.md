# The CLI's script commands, in detail

Read this when you need a command or flag that `SKILL.md` does not use, or when the CLI does
something unexpected. Run every command from the repo root: paths are relative to it.

## Files of a script

```
accounts/<domain>/
  profile.json                 { "apiKey": "…" }   never read or print it
  scripts/<prefix>/
    index.js                   entry (another one with --file <name>, without .js)
    config.json                sent to the account on every deploy
    settings.json              local build options, never sent
    README.md                  sent as `readme` when not empty (copied into config.json first)
    lib/                       your modules; --watch also watches this folder
    test/<name>.test.js        optional jest tests
    dist/bundle.js             written by each deploy: what was uploaded as `code`
```

`config.json`:

| Key | Sent as | Notes |
| --- | --- | --- |
| `variables` | `variables` | `[{ "key", "value" }]`. Replaces the whole list on the account each time. |
| `lifecycleHooks` | `lifecycleHooks` | Object names, e.g. `["Contact"]`. Rejected if the account has not enabled them. |
| `readme` | `readme` | Overwritten from `README.md`. Sent only when not empty. |
| `git.repositoryUrl` | `git` | Sent only when not empty. |

Everything else on the record (`active`, `timeout`, `scheduledTask`, `runOnQuoteCalculate`,
`scriptName`) is never sent by a deploy. Change it with the API helper; deploys keep it.

`settings.json`: `minifyProductionCode` (minify, `prod` only) and `removeComments` (esbuild
`minifySyntax` and no legal comments). Missing files are created with defaults on the first
deploy: `{ "minifyProductionCode": false, "removeComments": true }`.

## Bundling

Every deploy runs esbuild on the entry: `bundle: true, platform: 'node', format: 'cjs'`.

- Relative requires are resolved from the file that has them. From
  `accounts/<domain>/scripts/<prefix>/index.js` the repo's `lib/` is `../../../../lib/…`.
- A bare `require('lib/…')` (as in the README's examples) does not resolve: there is no
  alias for it.
- npm packages installed in the repo are inlined. Pure-JS ones work at run time
  (`lodash/chunk` was tested). Do not `require('axios')`: the bundle would pull axios's Node
  build, which needs `http` and `zlib`. Use the global `axios`.
- Node built-ins (`crypto`, `fs`, `path`, `http`, `buffer`…) are left as `require("…")` in
  the bundle, and fail at run time with "require is not a function".
- The entry's own code stays at the top level of the bundle, so its last statement is the
  bundle's last statement. Do not use `module.exports` in the entry ("Cannot set properties
  of undefined (setting 'exports')") or top-level `await` (esbuild refuses it in `cjs`).

## Commands

| Command | Does | Prompts | Use from an agent |
| --- | --- | --- | --- |
| `script dev --domain <d> --prefix <p> --no-git` | Creates `<p>-dev` (active) if missing, bundles, sends `config.json` fields and `code`, exits. Does not run the script. | Only for a missing API key, and for git without `--no-git` | Yes |
| `script prod … --no-git` | Same for `<p>` (no suffix). Minifies if `minifyProductionCode`. | Same | Yes, after a production yes |
| `… --file <name>` | Uses `<name>.js` as the entry. Same record. | | Yes |
| `… --watch` | Also connects to the log socket and runs the script once. Then a change to the entry or `lib/` re-deploys the code and runs it; a change to `config.json` re-sends its fields and runs it; a change to `README.md` re-sends `readme`. Never exits. | `R` key reruns (TTY only) | Only in the background, killed after use |
| `script create` | Copies `templates/script`, writes `profile.json`, creates **both** `<p>-dev` and `<p>` (active) with the unbundled template. | Repo URL (unless `--repo` or a git repo in `accounts/<d>/`), lifecycle hooks (unless a non-empty `--lifecycleHooks`), delete an existing folder, git init | No |
| `script import --domain <d> --prefix <p> --repo <url>` | `git clone` into `scripts/<p>/`. Uploads nothing. | Only if the folder exists | Yes, for an existing repo |
| `script sync` | Deploys several scripts. | Always (which scripts, which environment) | No |
| `script test --domain <d> --prefix <p> [--file <name>]` | Runs jest on `scripts/<p>/test/<name>.test.js` with `DOMAIN` and `SCRIPT_PREFIX` set, then waits for keys. | Raw-mode keyboard: crashes without a TTY, hangs with one | No: run `DOMAIN=<d> SCRIPT_PREFIX=<p> npx jest accounts/<d>/scripts/<p>/test/<name>.test.js` |

Exit codes of `script dev|prod`: a build error (for example "Could not resolve") exits 1. A
field the account rejects prints `Failed to PATCH <field> for <code>: {…}` and the command
still exits 0 and uploads the rest. On a first deploy the record is created before bundling,
so a build error leaves it with placeholder code.

## Things in the CLI that do not work as written

- `templates/script/index.js` requires `../../../lib/vendors/prolibu/EventManager`, one level
  short since scripts moved under `scripts/`: a script made with `script create` does not
  build. Use `assets/index.js` from this skill.
- `templates/test/index.test.js` has the same problem (`../../../../lib`, and `profile.json`
  two levels up); no command copies it.
- The README's `require("lib/…")` examples do not resolve.
- The production copy is named `<p>`, but the platform sets `env = "prod"` only for codes
  ending in `-prod`, so `env` is `"dev"` in both copies.
- `script prod --watch` listens to the log channel of `<p>-prod`, but the script logs to the
  channel of `<p>`: console lines never show (the output does).
- `script create` prints "Scripts '<p>-dev' and '<p>-prod' created"; the second is `<p>`.
- `script create` rewrites `profile.json` with only `apiKey`.

## Local tests of a script

`lib/utils/test.js` exports `loadGlobalVariables(env)`, which fakes the sandbox globals in
jest from `config.json`: `env`, `scriptCode`, `localDomain`, `variables`, `lifecycleHooks`,
`axios`. Use it to unit-test your `lib/` code; a deploy and a real run remain the proof.

## The repo's libraries

All use the global `axios`; none needs a Node built-in.

| Path (from `lib/`) | What |
| --- | --- |
| `vendors/prolibu/EventManager` | `Events.on('<event>', fn)`, `await Events.init()`; `setErrorMode('immediate' | 'delayed' | 'silent')` |
| `vendors/prolibu/ProlibuApi` | `new ProlibuApi({ apiKey, domain? })`: `create`, `findOne` (null on 404), `find`, `update`, `delete`, `search`, `findOneOrCreate` |
| `vendors/prolibu/UserApi` | `me()`, `switchWorkspace(id)` |
| `vendors/prolibu/DeviceApi` | Device commands |
| `vendors/prolibu/OutboundIntegration`, `DataMapper`, `ConfigValidator` | Config-driven sync of record events to another system (`beforeCreate`, `beforeUpdate`, `afterCreate`, `afterUpdate`, `afterDelete`) |
| `vendors/salesforce/SalesforceApi`, `vendors/hubspot/HubSpotApi`, `vendors/fasa/FasaApi` | CRM/ERP clients; they cache their token with `setVariable` |
| `vendors/sendgrid/SendGridApi`, `vendors/ultramsg/UltraMsg` | Email, WhatsApp |
| `vendors/ai/AIProviderFactory`, `vendors/deepseek/DeepSeekApi` | AI providers called with your own key |
| `utils/hmacSha256` | `sha256Hex`, `hmacSha256Hex`, `timingSafeEqual`, bytes variants |
| `utils/variables` | `getVariable(key)`, `getRequiredVars({ name: 'variable-key' })` |
| `utils/retry` | `withRetry(fn, { retries, label, deadline })`: retries 429, 5xx and network errors |
| `utils/sleep`, `utils/Validator` | `sleep(ms)`; `Validator.isRequired({ … })` |

`vendors/prolibu/README.md` describes `Rest` and `User` modules and a global `authAxios`;
none of them exists. Use `ProlibuApi` and `UserApi`.
