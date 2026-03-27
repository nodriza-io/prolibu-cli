---
name: apex-to-prolibu
description: "Convert Salesforce Apex code to Prolibu scripts. Use when: migrating Apex triggers, converting Apex classes, translating SOQL to Prolibu queries, transforming Salesforce callouts to axios, creating lifecycle hooks from trigger logic."
argument-hint: "Paste Apex code (trigger, class, or handler) to convert"
---

# Apex to Prolibu Script Converter

## What is Apex (Salesforce Migration Context)

**Apex** is Salesforce's proprietary programming language (similar to Java) used to:

- **Triggers**: Server-side code that runs automatically when records are created, updated, or deleted
- **Classes/Handlers**: Business logic organized in handler patterns (TriggerHandler, Domain classes)
- **SOQL**: Salesforce Object Query Language for database queries
- **Callouts**: HTTP requests to external APIs
- **@Schedulable/@Batchable**: Asynchronous and scheduled processing

In a **Salesforce to Prolibu migration**, these Apex components must be converted to Prolibu scripts that handle equivalent business logic using Prolibu's event system and API clients.

## Output Location (CLI Framework Structure)

**IMPORTANT**: All converted scripts MUST be placed following the CLI framework structure:

```
accounts/{domain}/scripts/{script-name}/
├── index.js       # Main script with event handlers
├── config.json    # Script configuration (lifecycleHooks, etc.)
└── lib/           # Optional: helper modules
```

Example paths:

- `accounts/dev10.prolibu.com/scripts/lead-sync/index.js`
- `accounts/repremundo.prolibu.com/scripts/opportunity-validation/index.js`

The `{script-name}` should be descriptive and kebab-case (e.g., `contact-sync`, `deal-validation`, `quote-calculator`).

## When to Use

- Converting Salesforce Apex **triggers** to Prolibu lifecycle hooks
- Migrating Apex **handler classes** to script event handlers
- Translating **SOQL queries** to Prolibu API calls with xquery
- Transforming **HTTP callouts** to axios requests
- Creating **scheduled scripts** from Apex Schedulable/Batch classes
- Building **webhook receivers** from @RestResource classes

## ⚠️ CRITICAL: Prolibu Data Model Differences

### Quote Does NOT Exist as Independent Entity

In Prolibu, **Quote does not exist as a standalone entity**. The hierarchy is:

```
Deal (Oportunidad)
  └── Proposal (Propuesta)
        └── Quote (Cotización) ← Lives INSIDE the Proposal
```

**This means:**

- There is NO `Quote.beforeCreate` or `Quote.afterUpdate` lifecycle hook
- Any Salesforce trigger on `Quote` must be converted to a **Deal** lifecycle hook
- From the Deal, you access the Proposal, and from there the Quote data

### Converting Quote Triggers

When converting Apex triggers on Quote:

```apex
// Salesforce: Trigger on Quote
trigger QuoteTrigger on Quote (after insert, after update) {
    // Quote logic here
}
```

Convert to **Deal** lifecycle hook:

```javascript
// Prolibu: Use Deal lifecycle, then access proposal/quote
Events.on("Deal.afterCreate", async ({ record, prolibuApi }) => {
  // The Deal contains proposals, each proposal has quote data
  const deal = record;

  // Access proposal data (quote lives here)
  const proposals = await prolibuApi.find("Proposal", {
    xquery: JSON.stringify({ deal: deal._id }),
    select: "_id items totalAmount status",
  });

  // Work with quote data through proposals
  for (const proposal of proposals) {
    // proposal.items = line items (quote lines)
    // proposal.totalAmount = quote total
    // proposal.status = quote status
  }
});
```

### Entity Mapping: Salesforce → Prolibu

| Salesforce Entity | Prolibu Entity      | Notes                        |
| ----------------- | ------------------- | ---------------------------- |
| Account           | Company             | Direct mapping               |
| Contact           | Contact             | Direct mapping               |
| Lead              | Lead                | Direct mapping               |
| Opportunity       | Deal                | Direct mapping               |
| **Quote**         | **Deal → Proposal** | Quote data lives in Proposal |
| QuoteLineItem     | Proposal.items      | Array inside Proposal        |
| Task              | Task                | Direct mapping               |
| Note              | Note                | Direct mapping               |
| User              | User                | Direct mapping               |

### Quote Field Mapping

| Salesforce Quote Field | Prolibu Location        | Access Path               |
| ---------------------- | ----------------------- | ------------------------- |
| Quote.Name             | Proposal.name           | `proposal.name`           |
| Quote.Status           | Proposal.status         | `proposal.status`         |
| Quote.GrandTotal       | Proposal.totalAmount    | `proposal.totalAmount`    |
| Quote.ExpirationDate   | Proposal.expirationDate | `proposal.expirationDate` |
| QuoteLineItem[]        | Proposal.items[]        | `proposal.items`          |
| Quote.OpportunityId    | Deal.\_id               | Parent Deal ID            |

## Conversion Procedure

### ⚠️ CRITICAL: Faithful Migration Principle

**The migration MUST be faithful to the original Apex code.** Do NOT modify, interpret, or "improve" values:

1. **URLs and Endpoints** — Copy EXACTLY as they appear in Apex

   ```apex
   // Apex original
   .setEndpoint('https://dev10.prolibu.com/v2/endpoint/post/salesforce-integration-prod')
   .setSandboxEndpoint('https://dev10.prolibu.com/v2/endpoint/post/salesforce-integration-dev')
   ```

   ```javascript
   // Prolibu script — SAME URLs, do NOT change them
   const WEBHOOK_CONFIG = {
     prodEndpoint:
       "https://dev10.prolibu.com/v2/endpoint/post/salesforce-integration-prod",
     sandboxEndpoint:
       "https://dev10.prolibu.com/v2/endpoint/post/salesforce-integration-dev",
   };
   ```

2. **Constants and Configuration Values** — Preserve exactly

   ```apex
   // Apex
   private static final Set<String> VALID_STATUSES = new Set<String>{'Active', 'Pending'};
   ```

   ```javascript
   // Prolibu — SAME values
   const VALID_STATUSES = new Set(["Active", "Pending"]);
   ```

3. **Field Lists** — Copy all fields as defined
4. **Timeout Values** — Keep the same (e.g., `setTimeout(30000)` → `timeout: 30000`)
5. **Error Messages** — Translate text but keep meaning
6. **Variable Names** — Use equivalent camelCase naming

**The goal is to replicate the EXACT behavior of the Apex code**, not to create a "better" version.

### Step 1 — Analyze the Apex Code

Identify:

1. **Trigger events** → map to lifecycle hooks (beforeCreate, afterUpdate, etc.)
2. **SOQL queries** → convert to `prolibuApi.find()` with xquery
3. **DML operations** → convert to `prolibuApi.create/update/delete()`
4. **HTTP callouts** → convert to `axios.get/post()`
5. **Async patterns** (@future, Queueable) → use afterCreate/afterUpdate hooks

### Step 2 — Determine Script Structure

Based on the Apex patterns found, decide:

| Apex Pattern                                | Prolibu Script Type              |
| ------------------------------------------- | -------------------------------- |
| Trigger (before/after insert/update/delete) | Lifecycle hooks in `Events.on()` |
| @Schedulable / Batch Apex                   | `ScheduledTask` event            |
| @RestResource                               | `EndpointRequest` event          |
| Manual utility class                        | `ApiRun` event                   |

### Step 3 — Create the Script Files

Use the [script skeleton template](./templates/script-skeleton.js) as the base.

Required output files:

1. `index.js` — all event handlers
2. `config.json` — with `lifecycleHooks` array listing all entities used

### Step 4 — Map Fields

Create an explicit field map for Apex (PascalCase) → Prolibu (camelCase):

```javascript
const FIELD_MAP = {
  FirstName: "firstName",
  LastName: "lastName",
  Email: "email",
  MobilePhone: "mobile",
  AccountId: "companyId",
  Id: "externalId",
};
```

### Step 5 — Handle Variables

Extract credentials/endpoints from Apex Named Credentials and document them as script variables:

```javascript
const vars = getRequiredVars({
  prolibuApiKey: `prolibu-apiKey-${env}`,
  externalApiToken: `external-token-${env}`,
});
```

## Reference Documentation

- [Prolibu Script System Overview](./references/prolibu-script-system.md)
- [Lifecycle Hooks (6 events)](./references/lifecycle-hooks.md)
- [API Clients (Prolibu, Salesforce, HubSpot)](./references/api-clients.md)
- [Apex → Prolibu Mapping Tables](./references/apex-mapping-table.md)

## Quick Translation Rules

### Trigger Events

```
before insert  →  Events.on('Entity.beforeCreate', ...)
after insert   →  Events.on('Entity.afterCreate', ...)
before update  →  Events.on('Entity.beforeUpdate', ...)
after update   →  Events.on('Entity.afterUpdate', ...)
before delete  →  Events.on('Entity.beforeDelete', ...)
after delete   →  Events.on('Entity.afterDelete', ...)
```

### Validation & Abort

```apex
// Apex
record.addError('Email is required');
```

```javascript
// Prolibu (in beforeCreate/beforeUpdate)
throw new Error("Email is required");
```

### SOQL → xquery

```apex
// Apex
[SELECT Id, Name FROM Contact WHERE Email = :email AND Status__c = 'active']
```

```javascript
// Prolibu
await prolibuApi.find("Contact", {
  xquery: JSON.stringify({ email: email, status: "active" }),
  select: "_id name",
});
```

### HTTP Callout

```apex
// Apex
HttpRequest req = new HttpRequest();
req.setEndpoint('https://api.example.com/data');
req.setMethod('POST');
req.setBody(JSON.serialize(payload));
HttpResponse res = new Http().send(req);
```

```javascript
// Prolibu
const response = await axios.post("https://api.example.com/data", payload, {
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${vars.token}`,
  },
});
```

## Output Requirements

For every conversion, produce files in `accounts/{domain}/scripts/{script-name}/`:

1. **`index.js`** — Complete script with all event handlers

   ```javascript
   const Events = require("../../../lib/vendors/prolibu/EventManager");
   // Event handlers...
   (async function main() {
     await Events.init();
   })();
   ```

2. **`config.json`** — With `lifecycleHooks` listing all entity names

   ```json
   {
     "name": "script-name",
     "lifecycleHooks": ["Contact", "Deal"]
   }
   ```

3. **`lib/` folder** (optional) — Helper modules for complex logic

4. **Field map** — Explicit Apex → Prolibu field mapping (in index.js or separate file)

5. **Variables list** — All credentials that need configuration as script variables

6. **Migration notes** — Document: bulk patterns collapsed to single-record, @future → afterHook, etc.
