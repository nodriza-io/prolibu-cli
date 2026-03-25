# AGENT_CONTEXT — cli/migrate/

This document gives an AI agent (or new developer) working **only in this folder** enough context to contribute without needing to open the rest of the CLI.

---

## 1. What this folder is

`cli/migrate/` is the self-contained engine for migrating data from external CRMs into Prolibu.  
It is connected to the CLI via `cli/commands/migrate/index.js` which proxies to `cli/migrate/index.js`.

### Architecture principle: the frontend is a visual extension of the CLI

The web UI (`cli/migrate/ui/`) is **not** an independent application. It is a visual extension
of the CLI that reuses the exact same engine, phases, and shared utilities.

**Rules:**

- **Every action the frontend can perform must go through the same code path as the CLI.**  
  For example, both `POST /api/phases/discover` and `prolibu migrate salesforce run --phase discover`
  invoke `engine.run({ phases: ['discover'] })`. Same for migrate.
- **Never duplicate engine logic in `ui-server.js`.** The server is a thin HTTP layer that
  receives requests, calls `engine.run()`, and streams results back via SSE.
- **Progress and results use callbacks.** The engine accepts `onProgress`, `onEntityResult`,
  and `onDiscoverProgress` callbacks. The CLI ignores them (uses stdout); the UI server
  forwards them via SSE to the browser.
- **New phases or features must be added to the engine first**, then exposed in the UI server
  as a thin wrapper — never the other way around.
- **Config read/write goes through `credentialStore` and `configLoader`** — both the CLI
  and the UI server use the same shared modules.

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

Flow: `prolibu` binary → `cli/commands/migrate/index.js` → `cli/migrate/index.js` → `cli/migrate/adapters/salesforce/index.js` → `cli/migrate/adapters/salesforce/configure.js`

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

Use `ProlibuWriter` (in `shared/`) for batch writes — it handles findOneOrCreate (create or update by externalId) and dry-run automatically.

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
`accounts/<domain>/cli/migrate/adapters/salesforce/credentials.json`.

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

Base transformers live in `cli/migrate/adapters/salesforce/transformers/<entity>.js`.  
Per-domain overrides live in `accounts/<domain>/cli/migrate/adapters/salesforce/transformers/<entity>.js`.

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

1. Create `cli/migrate/adapters/hubspot/` with the same structure as `cli/migrate/adapters/salesforce/`
2. Add `else if (crm === 'hubspot')` in `cli/migrate/index.js`
3. No changes needed anywhere else in the CLI

---

## 13. Phase system

The engine runs ordered phases. Each phase is an object with `{ name, description, execute(context) }`.

Current phases (in order):

| #   | Name       | Description                                                                                           |
| --- | ---------- | ----------------------------------------------------------------------------------------------------- |
| 1   | `discover` | Introspect Salesforce — list all SObjects, fields, record counts. Saves `discovery.json`.             |
| 2   | `review`   | Start a local web UI (port 3721) for schema comparison, config builder and prolibu_setup.json export. |
| 3   | `migrate`  | Fetch records from Salesforce, run through pipeline, write to Prolibu.                                |

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
- Keeps the Node process alive until the user clicks _"Cerrar servidor"_ in the UI.
- Writes two output files when the user clicks **Save**:
  - `accounts/<domain>/cli/migrate/adapters/salesforce/config.json` — which entities / fields to migrate.
  - `accounts/<domain>/cli/migrate/adapters/salesforce/prolibu_setup.json` — custom objects and custom fields that must be created in Prolibu **before** running the migrate phase.
- The SPA lives in `salesforce/review-ui/index.html` (read from disk on every request — no rebuild needed).

To add a new phase:

1. Create `salesforce/phases/<name>.js` exporting `async function(context) { ... }`
2. Add an entry to `PHASES` array in `salesforce/engine.js`

The `context` object passed to every phase:

```js
{
  domain,              // string
  apiKey,              // string
  entities,            // string[] — resolved entity list (no 'all')
  adapter,             // SalesforceAdapter (authenticated) — only if phase needs Salesforce
  writer,              // ProlibuWriter — only if phase needs writing
  log,                 // migration log object (from migrationLogger)
  entityDefinitions,   // ENTITY_DEFINITIONS map
  batchSize,           // number
  dryRun,              // boolean
  withCount,           // boolean — fetch record counts during discover
  onProgress,          // function — callback per record during migrate (entity, processed, total, ...stats)
  onEntityResult,      // function — callback per entity completion during migrate
  onDiscoverProgress,  // function — callback per SObject described during discover ({ done, total })
}
```

---

## 14. Pipeline system

Each entity can have a custom pipeline file at:

```
accounts/<domain>/cli/migrate/adapters/salesforce/pipelines/<entity>.js
```

A pipeline is an array of steps. Each step can mutate data **before** the transform, **replace** the transform, or **enrich** the result **after** the transform. All hook functions can be `async`.

```js
// accounts/<domain>/cli/migrate/adapters/salesforce/pipelines/contacts.js
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

| File                             | Purpose                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `shared/credentialStore.js`      | Read/write credentials, config, discovery and pipelines under `accounts/<domain>/migrations/<crm>/` |
| `shared/migrationLogger.js`      | Create, update, save, and print migration run logs                                                  |
| `shared/ProlibuWriter.js`        | Batch findOneOrCreate records to Prolibu with dry-run support                                       |
| `shared/PipelineRunner.js`       | Resolve and execute entity pipelines with before/after hooks                                        |
| `shared/SchemaSetup.js`          | Create custom fields on existing models and custom objects (COBs) in Prolibu                        |
| `shared/ProlibuSchemaService.js` | On-demand Prolibu entity schema queries (from OpenAPI spec or live API)                             |

---

## 16. Prolibu Schema Service

Query Prolibu entity schemas on demand. Works offline (from cached OpenAPI spec) or live (fetching from the API).

```js
const ProlibuSchemaService = require("../shared/ProlibuSchemaService");

// From the full spec (e.g. already fetched at startup)
const svc = new ProlibuSchemaService({ spec: prolibuSpec });

// Or live from the API
const svc = new ProlibuSchemaService({ domain: "dev10.prolibu.com", apiKey });

// List all entities
const entities = await svc.listEntities();
// → ['call', 'campaign', 'company', 'contact', 'contract', 'deal', ...]

// Get full schema for an entity
const schema = await svc.getEntitySchema("company");
// → { properties: { companyName: ..., website: ..., ... }, required: [...] }

// Get flat field map (nested fields use dot notation)
const fields = await svc.getEntityFields("company");
// → { companyName: { type: 'string' }, 'address.street': { type: 'string' }, ... }

// Refresh spec from API
await svc.refreshSpec();
```

### Server API endpoints

| Method | Path                          | Description                        |
| ------ | ----------------------------- | ---------------------------------- |
| GET    | `/api/prolibu/entities`       | List all Prolibu entity names      |
| GET    | `/api/prolibu/schema/:entity` | Full schema for a specific entity  |
| GET    | `/api/prolibu/fields/:entity` | Flat field map for an entity       |
| POST   | `/api/prolibu/refresh-schema` | Re-fetch OpenAPI spec from Prolibu |
| GET    | `/api/field-mapping`          | Known CRM→Prolibu field mapping    |

---

## 17. Known Field Mapping (SF → Prolibu)

Each CRM adapter can export a `fieldMapping.js` alongside `metadata.js`.
This file contains known field-level mappings between CRM fields and Prolibu fields.

For Salesforce see `salesforce/fieldMapping.js`. It covers all 21 entity pairs from `entityMapping`:
Account→company, Contact→contact, Lead→contact, Opportunity→deal, Quote→quote,
Contract→contract, Case→ticket, Product2→product, Pricebook2→pricebook,
PricebookEntry→pricebookentry, OpportunityLineItem→lineitem, Task→task,
Event→meeting, Note→note, Call→call, Campaign→campaign, User→user, Invoice→invoice.

Field values use dot notation for nested Prolibu fields (e.g. `address.street`).
Fields mapped to `customFields.*` need a custom field created in Prolibu first.
Fields mapped to `null` are explicitly skipped.

The UI server loads the field mapping via `loadCRMMetadata()` and serves it at
`/api/field-mapping` and in `/api/state` (as `state.fieldMapping`).

The SchemaMap page uses these known mappings as defaults, falling back to heuristic
matching for any SF field not in the known mapping.

---

## 18. Schema setup — Custom Fields & Custom Objects

Use `SchemaSetup` to programmatically create custom fields on existing models or create entirely new custom objects (COBs).

```js
const SchemaSetup = require("../shared/SchemaSetup");
const setup = new SchemaSetup({ domain, apiKey, dryRun: false });

// ── Add custom fields to an existing model ─────────────────
await setup.createCustomFields("Contact", {
  color: { type: "string", description: "Favorite color" },
  priority: { type: "number", min: 1, max: 5 },
  assignee: { type: "objectid", ref: "User" },
});

// ── Add overrides (modify existing fields or add root-level fields) ──
await setup.addOverrides("Deal", {
  amount: { required: true, min: 1000 },
  contractType: { type: "string", enum: ["Monthly", "Annual"] },
});

// ── Create a new Custom Object (COB) ───────────────────────
await setup.createCustomObject({
  modelName: "Pet",
  active: true,
  petName: { type: "string", required: true, displayName: true },
  species: { type: "string", enum: ["Dog", "Cat", "Bird"] },
  owner: { type: "objectid", ref: "User" },
});

// ── Apply a prolibu_setup.json file ────────────────────────
const report = await setup.applySetupFromFile("path/to/prolibu_setup.json");
SchemaSetup.printReport(report);
```

`ProlibuWriter` also exposes convenience methods:

```js
const writer = new ProlibuWriter({ domain, apiKey, dryRun });
await writer.createCustomFields("Contact", { color: { type: "string" } });
await writer.createCustomObject({
  modelName: "Pet",
  petName: { type: "string" },
});
await writer.applySetup(setupConfig);
// For full access: writer.schemaSetup.addOverrides(...)
```
