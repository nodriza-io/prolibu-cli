---
name: prolibu-scripts
description: Write, deploy, run and debug a Prolibu Script the way this CLI does it — lay out accounts/<domain>/scripts/<prefix>/ by hand, deploy with `./prolibu script dev|prod --no-git` (esbuild bundles index.js with its requires), run it by _id and read its output and logs, then wire it to record events (lifecycle hooks), a cron schedule, an Endpoint or quote calculation. Use it whenever someone asks for server-side automation, a trigger on a record, a scheduled job or a script, or reports a script that returns null or does nothing, "require is not a function", "Could not resolve", "Cannot set properties of undefined (setting 'exports')", a run that still shows old code, a hook that never fires or fires twice, or "not enabled for lifecycle hooks". Spanish triggers: "script", "automatización", "hook", "disparador", "tarea programada", "cron", "ejecutar el script", "el script no corre".
---

# Prolibu Scripts

## Central idea

A Script is one piece of JavaScript stored on the account (`code`) and run in a sandbox when
something happens: a manual run, a record event, a schedule, an Endpoint call, a quote
calculation. With this CLI you never write `code` by hand. You write
`accounts/<domain>/scripts/<prefix>/index.js` like a small Node module; each deploy bundles it
with esbuild (your files, the repo's `lib/`, pure-JS npm packages) and uploads the bundle.

One prefix gives two records: `<prefix>-dev` (from `script dev`) and `<prefix>` (from
`script prod`). At run time there is no `require` and no Node built-in.

`scripts/script.js` covers what the CLI does not check:

```
node .claude/skills/prolibu-scripts/scripts/script.js <command> <domain> <prefix> [--env dev|prod]
  status   compare the account with the local folder (code, hooks, variable keys, other copy)
  run      run by _id, with --query key=value…, and show output, error and new log lines (needs --confirmed)
  logs     this script's stored log lines [--limit n]
```

Output is JSON. Exit codes: 0 ok, 1 API error or the run failed, 2 usage error (nothing sent),
3 blocked: not deployed, inactive or out of sync (nothing run).

## Ask the user first

1. **Which account**, and whether this stays a dev copy or goes to production too.
2. **What starts it**: on demand; a record event (which object; before or after create,
   update or delete); a schedule (when, and in which time zone); an HTTP call from outside
   (then also use `prolibu-endpoints`); a quote calculation.
3. **What it reads, writes or calls.** Keys for the account or other services go in
   `variables`; ask the user for them, never invent or reuse one.
4. **For a record event:** whether an admin enabled hooks for that object. Check with
   `GET /v2/preference/read` → `preference.integrations.lifecycleHooks.{enabled, enabledEntities}`.
   If it is off, say so: only an admin turns it on, in the app's preferences.

## Steps

1. **Pick the prefix.** Lowercase with hyphens. Run `script.js status <domain> <prefix>` and
   the same with `--env prod`: a new prefix answers BLOCKED "is not on" (exit 3). If it
   exists, ask before overwriting it.
2. **Lay out the folder by hand.** Do not run `./prolibu script create`: it prompts, uploads
   the unbundled template to both copies, and its template does not build.

   ```
   accounts/<domain>/scripts/<prefix>/
     index.js       copy assets/index.js and edit it
     config.json    {"variables": [], "lifecycleHooks": [], "readme": "", "git": {"repositoryUrl": ""}}
     settings.json  {"minifyProductionCode": false, "removeComments": true}
     README.md      what the script does (uploaded as readme)
     lib/           your own modules, if any
   ```

   Every deploy replaces the script's `variables` with the ones in `config.json`. When the
   user keeps secrets in the app instead (or the script caches tokens with `setVariable`),
   leave the `variables` key out of `config.json` so deploys keep what is stored.
3. **Write the code.**
   - One handler per event: `Events.on('ApiRun', async () => { … })`. Read inputs from
     `eventData` and assign the result to the global `output`.
   - Keep `(async function main() { await Events.init(); })();` as the last statement. No
     `module.exports`, no top-level `await`.
   - Requires: `./lib/x` for your files, `../../../../lib/…` for the repo's (`lib/` is four
     levels up). A bare `require('lib/…')` does not build.
   - Use the global `axios`. Never require `axios` or a Node built-in (`crypto`, `fs`,
     `Buffer`…). For SHA-256 or HMAC use `lib/utils/hmacSha256`.
   - Account data goes through the REST API with a key from `variables`
     (`lib/vendors/prolibu/ProlibuApi`). See `references/runtime.md`.
   - For `Quote.calculate`, `Quote.runScripts` or `AiAction.*`, check `eventName` yourself:
     `EventManager` drops those handlers.
4. **Deploy to dev**, after the user's yes:
   `./prolibu script dev --domain <domain> --prefix <prefix> --no-git`
   - It creates `<prefix>-dev` (active) the first time, writes `dist/bundle.js`, sends
     `config.json` and the code, and exits. It does not run the script.
   - Read every line. `Failed to PATCH <field>` means that field was not saved, even though
     the exit code is 0. "Could not resolve …" is a build error (exit 1).
5. **Check.** `script.js status <domain> <prefix>` must say `"inSync": true`. Fix each `problems`
   entry and read the `warnings`.
6. **Run**, after the user's yes when the script writes data or calls another service:
   `script.js run <domain> <prefix> [--query key=value]… --confirmed`. Read `output` and
   `error`. In `errorStack`, `at line N` is a line of `dist/bundle.js`.
7. **Iterate:** edit, deploy (step 4), `status`, `run`.
8. **Add the trigger** the user asked for, and only on one copy:
   - **Record event:** put the object in `config.json` `lifecycleHooks` (`["Contact"]`), add
     `Events.on('Contact.afterUpdate', …)`, deploy. It fires on real records right away.
   - **Schedule, time budget, quote calculation:** a deploy never sends them, and never
     removes them. Set them with the helper on the copy's `_id` (from `status`):
     `node .claude/skills/_shared/prolibu-api.js <domain> PATCH /v2/script/<_id> --data '{"scheduledTask":{"periodicity":"0 7 * * 1-5","timeZone":"America/Bogota"},"timeout":60000}' --confirmed`
   - Both copies are active and share `config.json`. If hooks are in `config.json`, both
     copies fire on every event. After the production deploy, deactivate the dev copy
     (`PATCH /v2/script/<dev _id> {"active": false}`); later deploys keep it inactive.
9. **Production**, with its own yes and a production warning:
   `./prolibu script prod --domain <domain> --prefix <prefix> --no-git`, then
   `script.js status <domain> <prefix> --env prod`.

## How the platform behaves

Details, payload shapes and the full list of globals: `references/runtime.md`. Every CLI
command, file and known CLI bug: `references/cli.md`.

- **Globals:** `axios`, `console`, `output`, `eventName`, `eventData`, `variables`,
  `setVariable`, `localDomain`, `scriptCode`, `env`, `locale`, `lifecycleHooks`, `ai`, timers,
  `URLSearchParams`, `requestUser` (only when someone called it). Missing: `require`,
  `process`, `Buffer`, `crypto`, `fetch`, `URL`, `TextEncoder`, `atob`, `btoa`.
- **A run ends when the last statement's promise settles.** Work it does not wait for is cut
  off with no error and `output: null`.
- **`env` is `"dev"` in both copies.** The platform says `"prod"` only for codes ending in
  `-prod`. Tell the copies apart with `scriptCode.endsWith('-dev')`.
- **Variables:** `variables` is the list at the start of the run. `setVariable(key, value)`
  saves now and shows on the next run. **Each deploy replaces the list with `config.json`'s**,
  so values saved by `setVariable` are lost.
- **No identity of its own:** a call to the account's API without a key answers 401; with a
  key, the script has that key's permissions.
- **Hooks:** `<Object>.beforeCreate|afterCreate|beforeUpdate|afterUpdate|beforeDelete|afterDelete`.
  In a before event, changes to `eventData.doc` are saved and an error blocks the save. An
  error in an after event fails the request but the record stays saved. There is no
  `requestUser`, and no loop guard: a hook that updates its own object runs again.
- **Hooks need two switches:** the object enabled on the account, and the object in the
  script's `lifecycleHooks`. A script listing an object that is not enabled fails every run.
- **Schedules** need `active`, a valid cron and `timeZone`; at most once per minute on
  production accounts. `GET /v2/script/schedulerStatus` (admins) shows what is registered.
- **Manual runs answer 200 even when the script fails:** the failure is in `error`. A run by
  `scriptCode` can execute code cached before the last deploy; `script.js run` uses `_id`.
- **Logs:** `console.info`, `warn`, `error` and every failure are stored for 7 days.
  `console.log` is never stored; it only streams to `--watch`.
- **Time budget:** `timeout` 5000–300000 ms (default 30000), then "Script execution timeout".
  `script.js run` gives up waiting after 30 s; the run may still finish: use `logs`.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| Deploy: `Could not resolve "../../../lib/…"` or `"lib/…"` | Template path one level short, or bare `lib/` | `../../../../lib/…` |
| `require is not a function` | A Node built-in or `axios` was required | Global `axios`; `lib/utils/hmacSha256` |
| `Cannot set properties of undefined (setting 'exports')` | `module.exports` in the entry | Remove it |
| `output` is `null`, no error | Not assigned, or async work not awaited by the last statement | Assign `output`; end with the `main()` call |
| A run shows the old code | Ran by `scriptCode` (cache) | Run by `_id` (`script.js run`) |
| Deploy exit 0, change missing | `Failed to PATCH <field>` | `status`, fix the cause, deploy again |
| `…not enabled for lifecycle hooks` / `Lifecycle hooks are not enabled.` | Object not enabled on the account | An admin enables it, or remove it from `lifecycleHooks` |
| Hook never fires | Object not in `lifecycleHooks`, script inactive, or object not enabled | `status`; check the preference |
| Hook runs twice | Dev and production copies both active with the hook | Deactivate one |
| Values saved by `setVariable` vanished | A deploy replaced `variables` | Keep needed keys in `config.json`, or leave the `variables` key out of it |
| `Script execution timeout` | Over `timeout` | Raise `timeout` by `PATCH`; page large reads |
| `Script is not active` | `active: false` | `PATCH {"active": true}` on that `_id` |
| `ReferenceError: requestUser is not defined` | No caller (hook, schedule, anonymous call) | `typeof requestUser !== 'undefined'` |
| `env` is `"dev"` in production | Production code has no `-prod` suffix | Use `scriptCode` |
| `prod --watch` shows output but no console lines | The CLI listens on the wrong channel | Use `script.js run` and `logs` |

## Verify

- `status` says `"inSync": true` and `code.matchesBundle: true`, and `otherCopy` is not firing
  the same trigger.
- `run` gives `error: null` and the `output` the user expects; your `console.info` lines show
  in `logs`.
- For a hook or a schedule, check `lifecycleHooks`, `active` and `scheduledTask` in `status`.
  Prove a hook on a record created for the test, and only after the user agrees.

## Don't

- Copy this configuration to another account by hand: use `prolibu-config-promotion`.
- Run `script create`, `script sync`, `script test`, or `--watch` in the foreground: they
  prompt or never exit. For tests run jest directly (`references/cli.md`).
- `PATCH` `code` by hand: always deploy through the CLI.
- Put keys in `code` or `README.md`; they go in `variables`. Variables are readable by
  anyone who can read the script.
- Run a script by `scriptCode`.
- Turn on a hook or a schedule on a production account without the user's explicit yes, or
  change account preferences.
- Leave a trigger on both copies.

## Writing to an account

Follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads only, plain
summary, explicit yes, write, read back. Deploying (`./prolibu script dev|prod`), running a
script that writes or calls out, and every `PATCH` of a script are writes. `status` is the
read back. For an HTTP endpoint that runs the script, see `prolibu-endpoints`; for
push-style notifications, `prolibu-webhooks`; for objects and how they relate,
`prolibu-platform-map`.
