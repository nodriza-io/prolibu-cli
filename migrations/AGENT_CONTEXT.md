# AGENT_CONTEXT — migrations/

This document gives an AI agent (or new developer) working **only in this folder** enough context to contribute without needing to open the rest of the CLI.

---

## 1. What this folder is

`migrations/` is the self-contained engine for migrating data from external CRMs into Prolibu.  
It is connected to the CLI via a one-line proxy at `cli/commands/migrate/index.js`.

---

## 2. CLI routing model

The `prolibu` binary (root of the project) routes commands like this:

```
prolibu <objectType> <command> [options]
  │        │
  │        └── args[1]  e.g. 'salesforce', 'hubspot'
  └── args[0]  e.g. 'migrate'
```

For migrate specifically:

```
prolibu migrate salesforce configure --domain dev10.prolibu.com
  objectType=migrate   command=salesforce   args[2]=configure
```

Flow: `prolibu` binary → `cli/commands/migrate/index.js` → `migrations/index.js` → `migrations/salesforce/index.js` → `migrations/salesforce/configure.js`

---

## 3. Handler pattern (must follow exactly)

Every handler file exports a single async function:

```js
module.exports = async function myHandler(command, flags, args) { ... }
```

Sub-command files export a single async function receiving `(flags, args)`:

```js
module.exports = async function runSomething(flags, args) { ... }
```

Lazy require pattern for sub-commands (same as the rest of the CLI):

```js
if (command === "configure") {
  const configure = require("./configure");
  await configure(flags, args);
}
```

---

## 4. ESM-only packages — IMPORTANT

`inquirer` (v9+) and `chalk` are ESM-only. **Never `require()` them.**  
Always use dynamic import:

```js
const inquirer = await import('inquirer');
const res = await inquirer.default.prompt({ ... });
```

---

## 5. Available flags

Parsed by `cli/core/flags.js` using `minimist`. Access as `flags.<name>`.

| Flag            | Alias | Type    | Purpose                                                      |
| --------------- | ----- | ------- | ------------------------------------------------------------ |
| `domain`        | `-d`  | string  | Prolibu domain (e.g. `dev10.prolibu.com`)                    |
| `apikey`        | `-a`  | string  | Prolibu API key                                              |
| `entity`        | —     | string  | Entity to migrate: `contacts`, `products`, `accounts`, `all` |
| `phase`         | —     | string  | Phase to run: `discover`, `migrate`, `all` (default: `all`)  |
| `from`          | —     | number  | Run phases from this index (1-based, inclusive)              |
| `to`            | —     | number  | Run phases up to this index (1-based, inclusive)             |
| `instance-url`  | —     | string  | Salesforce instance URL                                      |
| `client-key`    | —     | string  | Salesforce OAuth2 Consumer Key                               |
| `client-secret` | —     | string  | Salesforce OAuth2 Consumer Secret                            |
| `dry-run`       | —     | boolean | Simulate without writing to Prolibu                          |

---

## 6. How to resolve domain + apiKey (required first step in every subcommand)

```js
const path = require("path");
const fs = require("fs");

let domain = flags.domain;
if (!domain) {
  const inquirer = await import("inquirer");
  const res = await inquirer.default.prompt({
    type: "input",
    name: "domain",
    message: "Enter Prolibu domain:",
    validate: (input) => (input ? true : "Required."),
  });
  domain = res.domain;
}

const profilePath = path.join(
  process.cwd(),
  "accounts",
  domain,
  "profile.json",
);
let apiKey = flags.apikey;
if (!apiKey && fs.existsSync(profilePath)) {
  try {
    apiKey = JSON.parse(fs.readFileSync(profilePath, "utf8")).apiKey;
  } catch {}
}
if (!apiKey) {
  const inquirer = await import("inquirer");
  const res = await inquirer.default.prompt({
    type: "input",
    name: "apiKey",
    message: `Prolibu API key for "${domain}":`,
    validate: (input) => (input ? true : "Required."),
  });
  apiKey = res.apiKey;
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify({ apiKey }, null, 2));
}
```

---

## 7. Prolibu API client

```js
const ProlibuApi = require("../../lib/vendors/prolibu/ProlibuApi");
const api = new ProlibuApi({ domain, apiKey });

// CRUD
await api.create("Contact", data);
await api.find("Contact", { email: "foo@bar.com" });
await api.findOne("Contact", id);
await api.update("Contact", id, data);
await api.delete("Contact", id);
await api.findOneOrCreate("Contact", externalId, { field: "externalId" }, data);
```

Use `ProlibuWriter` (in `shared/`) for batch writes — it handles findOneOrCreate and dry-run automatically.

---

## 8. Salesforce API client

```js
const SalesforceAdapter = require("./SalesforceAdapter");
const adapter = new SalesforceAdapter({ instanceUrl, clientKey, clientSecret });
await adapter.authenticate();

// Fetch one page
const records = await adapter.fetch("Contact", {
  select: "Id, Name, Email",
  limit: 200,
});

// Fetch all pages automatically
const allRecords = await adapter.fetchAll("Contact", {
  select: "Id, Name, Email",
});
```

Credentials come from `credentialStore.getCredentials(domain, 'salesforce')` which reads  
`accounts/<domain>/migrations/salesforce/credentials.json`.

---

## 9. File layout per domain

```
accounts/<domain>/
  profile.json                                ← Prolibu apiKey (managed by CLI core)
  migrations/
    salesforce/
      credentials.json                        ← Salesforce credentials (.gitignored)
      config.json                             ← entities enabled/disabled, filters, batchSize
      last-run.json                           ← log of last migration run (.gitignored)
      discovery.json                          ← Salesforce introspection artifact (phase: discover)
      transformers/
        contacts.js                           ← optional full-replace or decorator override
        products.js
        accounts.js
      pipelines/
        contacts.js                           ← optional multi-step pipeline with before/after hooks
        products.js
        accounts.js
```

`credentials.json`, `last-run.json`, and `discovery.json` are excluded from git via the domain `.gitignore`.

---

## 10. Transformer override pattern

Base transformers live in `migrations/salesforce/transformers/<entity>.js`.  
Per-domain overrides live in `accounts/<domain>/migrations/salesforce/transformers/<entity>.js`.

The engine (`engine.js`) merges them automatically. An override can be:

**Full replacement** (replaces base entirely):

```js
module.exports = function transformContact(sfRecord) {
  return { externalId: sfRecord.Id, nombre: sfRecord.LastName /* ... */ };
};
```

**Decorator** (extends base, only overrides what's needed):

```js
module.exports = {
  extend: true,
  map: (sfRecord, base) => ({
    ...base(sfRecord), // run base transformer first
    extraField: sfRecord.Custom_Field__c,
  }),
};
```

---

## 11. config.json structure

```json
{
  "entities": {
    "contacts": { "enabled": true, "filter": "WHERE IsActive = true" },
    "products": { "enabled": true },
    "accounts": { "enabled": false }
  },
  "batchSize": 200
}
```

`filter` is appended to the SOQL WHERE clause.  
`batchSize` controls how many records are fetched per page from Salesforce.

---

## 12. Adding a new CRM (e.g. HubSpot)

1. Create `migrations/hubspot/` with the same structure as `migrations/salesforce/`
2. Add `else if (crm === 'hubspot')` in `migrations/index.js`
3. No changes needed anywhere else in the CLI

---

## 13. Phase system

The engine runs ordered phases. Each phase is an object with `{ name, description, execute(context) }`.

Current phases (in order):

| #   | Name       | Description                                                                                             |
| --- | ---------- | ------------------------------------------------------------------------------------------------------- |
| 1   | `discover` | Introspect Salesforce — list all SObjects, fields, record counts. Saves `discovery.json`.               |
| 2   | `review`   | Start a local web UI (port 3721) for schema comparison, config builder and prolibu_setup.json export.   |
| 3   | `migrate`  | Fetch records from Salesforce, run through pipeline, write to Prolibu.                                  |

Controlling which phases run:

```bash
# Run all phases in order (default)
prolibu migrate salesforce run

# Run only one phase
prolibu migrate salesforce run --phase discover
prolibu migrate salesforce run --phase review    # opens browser UI
prolibu migrate salesforce run --phase migrate

# Run by index range (1-based)
prolibu migrate salesforce run --from 2 --to 2

# Run one phase, one entity, dry-run
prolibu migrate salesforce run --phase migrate --entity contacts --dry-run
```

**review phase behaviour:**

- Starts `http://localhost:3721` and auto-opens the browser.
- Fetches `/v2/openapi/specification` from Prolibu to populate the schema comparison.
- Keeps the Node process alive until the user clicks *"Cerrar servidor"* in the UI.
- Writes two output files when the user clicks **Save**:
  - `accounts/<domain>/migrations/salesforce/config.json` — which entities / fields to migrate.
  - `accounts/<domain>/migrations/salesforce/prolibu_setup.json` — custom objects and custom fields that must be created in Prolibu **before** running the migrate phase.
- The SPA lives in `salesforce/review-ui/index.html` (read from disk on every request — no rebuild needed).

To add a new phase:

1. Create `salesforce/phases/<name>.js` exporting `async function(context) { ... }`
2. Add an entry to `PHASES` array in `salesforce/engine.js`

The `context` object passed to every phase:

```js
{
  domain,           // string
  apiKey,           // string
  entities,         // string[] — resolved entity list (no 'all')
  adapter,          // SalesforceAdapter (authenticated) — only if phase needs Salesforce
  writer,           // ProlibuWriter — only if phase needs writing
  log,              // migration log object (from migrationLogger)
  entityDefinitions,// ENTITY_DEFINITIONS map
  batchSize,        // number
  dryRun,           // boolean
}
```

---

## 14. Pipeline system

Each entity can have a custom pipeline file at:

```
accounts/<domain>/migrations/salesforce/pipelines/<entity>.js
```

A pipeline is an array of steps. Each step can mutate data **before** the transform, **replace** the transform, or **enrich** the result **after** the transform. All hook functions can be `async`.

```js
// accounts/<domain>/migrations/salesforce/pipelines/contacts.js
module.exports = {
  steps: [
    {
      name: "normalizeRaw", // optional label for logs
      before: async (sfRecord) => {
        // mutate the raw Salesforce record
        sfRecord.Phone = sfRecord.Phone?.replace(/\s/g, "");
        return sfRecord;
      },
    },
    {
      name: "base", // reserved → injects the engine's baseTransformer
    },
    {
      name: "enrich",
      transform: async (record) => ({
        // can also replace the shape entirely
        ...record,
        source: "salesforce-import",
      }),
      after: async (record) => {
        // enrich the already-transformed record
        record.tier = record.revenue > 100000 ? "enterprise" : "smb";
        return record;
      },
    },
  ],
};
```

Rules:

- `name: 'base'` is reserved → the runner injects the entity's `baseTransformer` at that slot
- `before`, `transform`, `after` are all optional per step
- If `transform` is omitted the record passes through to the next step unchanged
- Any function can be `async` — the runner uses `for...of` + `await`, never `Promise.all`
- **Retrocompatible:** if no `pipelines/<entity>.js` exists, the base transformer runs as a single-step pipeline with no hooks

The runner lives in `shared/PipelineRunner.js` and exports `{ resolvePipeline, runPipeline }`.

---

## 15. Shared utilities

| File                        | Purpose                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `shared/credentialStore.js` | Read/write credentials, config, discovery and pipelines under `accounts/<domain>/migrations/<crm>/` |
| `shared/migrationLogger.js` | Create, update, save, and print migration run logs                                                  |
| `shared/ProlibuWriter.js`   | Batch upsert records to Prolibu with dry-run support                                                |
| `shared/PipelineRunner.js`  | Resolve and execute entity pipelines with before/after hooks                                        |
