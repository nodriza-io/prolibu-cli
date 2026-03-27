# Prolibu Script System Overview

Complete reference for the Prolibu backend script runtime.

## Script Module Structure

Every script lives inside `accounts/` and follows this structure:

```
accounts/<domain>/<script-name>/
├── index.js          ← Entry point — all event handlers
├── config.json       ← Metadata and activation config
├── settings.json     ← Build options (optional)
└── lib/              ← Helper modules bundled by esbuild (optional)
    └── utils.js
```

### CLI Commands

```bash
# Create a new script (interactive prompts)
prolibu script create --domain dev10.prolibu.com

# Development mode (watches files, auto-deploys on save)
prolibu script dev --domain dev10.prolibu.com --watch

# Production deploy
prolibu script prod --domain dev10.prolibu.com
```

### config.json

```json
{
  "variables": [],
  "lifecycleHooks": ["Contact", "Deal"],
  "readme": "Brief description of what this script does",
  "git": { "repositoryUrl": "" }
}
```

- `lifecycleHooks`: **CRITICAL** — list every entity this script listens on. If an entity is NOT here, `Events.on('Entity.afterCreate', ...)` will be **silently ignored**.
- `variables`: Declared here but values set via `prolibu script dev` interactive prompts.

### settings.json

```json
{
  "minifyProductionCode": true,
  "removeComments": true
}
```

---

## Sandbox Globals

These variables are available globally in every script (no `require` needed):

| Global                    | Type     | Description                                         |
| ------------------------- | -------- | --------------------------------------------------- |
| `eventName`               | string   | Current event being executed                        |
| `eventData`               | object   | Event payload (doc, beforeUpdateDoc, payload, etc.) |
| `env`                     | string   | `"dev"` or `"prod"`                                 |
| `axios`                   | object   | Pre-configured axios instance                       |
| `variables`               | array    | Script variables `[{ key, value }]`                 |
| `setVariable(key, value)` | function | Persists a variable to the backend                  |
| `lifecycleHooks`          | string[] | Entity names configured for this script             |
| `localDomain`             | string   | Tenant domain (e.g., `"dev10.prolibu.com"`)         |

---

## Event Types

### 1. ApiRun — Manual HTTP Trigger

```javascript
Events.on("ApiRun", async () => {
  const { query, body } = eventData;
  // Ad-hoc operations, batch jobs, admin tasks
});
```

**Trigger:** `POST /v2/script/run` with `{ scriptId, query, body }`

### 2. ScheduledTask — Cron-Driven

```javascript
Events.on("ScheduledTask", async () => {
  const { scheduledAt, executionCount } = eventData;
  // Periodic batch processing
});
```

**Config:** `"periodicity": "0 2 * * *"` (cron expression) in config.json

### 3. EndpointRequest — Custom HTTP Endpoint

```javascript
Events.on("EndpointRequest", async () => {
  const { headers, query, body, params } = eventData;
  // Webhook receiver, custom REST API
});
```

**Route:** `GET/POST /v2/endpoint/:method/:route`

### 4. Lifecycle Hooks — Entity CRUD Events

```javascript
// before* hooks CAN abort by throwing
Events.on("Contact.beforeCreate", async () => {
  const { doc } = eventData;
  if (!doc.email) throw new Error("Email required");
});

// after* hooks CANNOT abort (record already saved)
Events.on("Contact.afterCreate", async () => {
  const { doc } = eventData;
  await syncToExternalSystem(doc);
});

// Update hooks receive old state and changed fields
Events.on("Contact.beforeUpdate", async () => {
  const { doc, beforeUpdateDoc, payload } = eventData;
  // doc = new state, beforeUpdateDoc = old state, payload = changed fields only
});

Events.on("Contact.afterUpdate", async () => {
  const { doc, beforeUpdateDoc, payload } = eventData;
});

Events.on("Contact.beforeDelete", async () => {
  const { doc } = eventData;
});

Events.on("Contact.afterDelete", async () => {
  const { doc } = eventData;
});
```

---

## The EventManager Pattern

```javascript
/* global eventName, eventData, env, axios, variables, localDomain, lifecycleHooks */

const Events = require('../../../lib/vendors/prolibu/EventManager');

// Register handlers
Events.on('Contact.afterCreate', async () => { ... });
Events.on('Contact.afterUpdate', async () => { ... });

// Bootstrap — executes matching handlers based on global `eventName`
(async function main() {
  await Events.init();
})();
```

**How it works:**

1. Script loads, registers handlers with `Events.on()`
2. `Events.init()` reads global `eventName`
3. Executes all handlers registered for that event name
4. Handlers run sequentially, awaiting async completion

---

## Variables Access

```javascript
const {
  getRequiredVars,
  getVariable,
} = require("../../../lib/utils/variables");

// Get multiple required variables (throws if any missing)
const vars = getRequiredVars({
  prolibuApiKey: `prolibu-apiKey-${env}`,
  externalToken: `external-token-${env}`,
});

// Get single variable (returns undefined if missing)
const optionalValue = getVariable("optional-key");
```

---

## Error Handling Rules

### before\* hooks

- **Throw to abort** the operation
- Error message returned to client as 400 response

```javascript
Events.on("Contact.beforeCreate", async () => {
  const { doc } = eventData;
  if (!doc.email) {
    throw new Error("Email is required"); // Aborts creation
  }
});
```

### after\* hooks

- **Do NOT throw** — the record is already saved
- Catch errors internally and log them

```javascript
Events.on("Contact.afterCreate", async () => {
  const { doc } = eventData;
  try {
    await axios.post("https://external.api/sync", doc);
  } catch (error) {
    console.error("Sync failed:", error.message);
    // Do NOT rethrow — record already created
  }
});
```

---

## Require Paths

The `require()` path is relative to `accounts/<domain>/<script-name>/index.js`:

```javascript
// Core libraries
const Events = require("../../../lib/vendors/prolibu/EventManager");
const ProlibuApi = require("../../../lib/vendors/prolibu/ProlibuApi");
const SalesforceApi = require("../../../lib/vendors/salesforce/SalesforceApi");
const HubSpotApi = require("../../../lib/vendors/hubspot/HubSpotApi");
const DataMapper = require("../../../lib/vendors/prolibu/DataMapper");

// Utilities
const { getRequiredVars } = require("../../../lib/utils/variables");

// Local lib (bundled by esbuild)
const { myHelper } = require("./lib/utils");
```
