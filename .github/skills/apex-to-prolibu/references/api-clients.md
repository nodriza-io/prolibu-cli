# API Clients Reference

## Important: No Magic Globals

There is NO magic `API` global in scripts. You must **instantiate each client manually** with `require` and credentials from `variables`.

## ProlibuApi

### Initialization

```javascript
const ProlibuApi = require("../../../lib/vendors/prolibu/ProlibuApi");
const { getRequiredVars } = require("../../../lib/utils/variables");

const vars = getRequiredVars({
  prolibuApiKey: `prolibu-apiKey-${env}`,
});

const prolibuApi = new ProlibuApi({
  domain: localDomain, // Sandbox global — the tenant domain
  apiKey: vars.prolibuApiKey,
});
```

### Methods

```javascript
// ── Read Operations ──────────────────────────────────────

// Find multiple records
await prolibuApi.find("Contact", {
  xquery: JSON.stringify({ status: "active" }),
  select: "name email mobile",
  limit: 100,
  page: 1,
});
// Returns: { data: [...], total: N }

// Find one by ID
await prolibuApi.findOne("Contact", recordId);
// Returns: { _id, name, email, ... } or null

// Search (text search)
await prolibuApi.search("Contact", "john", { limit: 10 });

// ── Write Operations ──────────────────────────────────────

// Create
const created = await prolibuApi.create("Contact", {
  name: "Jane Doe",
  email: "jane@example.com",
});
// Returns: { _id, name, email, createdAt, ... }

// Update
const updated = await prolibuApi.update("Contact", recordId, {
  mobile: "+57 300 123 4567",
});
// Returns: updated document

// Delete
const deleted = await prolibuApi.delete("Contact", recordId);
// Returns: true/false

// Upsert (find by external field, create or update)
const { record, created } = await prolibuApi.findOneOrCreate(
  "Contact",
  "SF_001234", // External ID value
  { field: "salesforceId" }, // Field to match on
  { name: "John", email: "j@x.com" }, // Data
);
```

### xquery — Complex Queries

`xquery` accepts MongoDB query operators:

```javascript
// Equality
{ status: 'active' }

// $ne (not equal)
{ status: { $ne: 'deleted' } }

// $in (in array)
{ status: { $in: ['active', 'pending'] } }

// $exists
{ salesforceId: { $exists: true } }

// $gt, $gte, $lt, $lte
{ amount: { $gt: 5000 } }

// $regex
{ email: { $regex: '@example.com$' } }

// Nested fields
{ 'proposal.template.layout': null }

// Combined
{
  'proposal.template.layout': null,
  'proposal.template.layoutHtml': { $exists: true, $ne: null },
}
```

## SalesforceApi

### Initialization

```javascript
const SalesforceApi = require("../../../lib/vendors/salesforce/SalesforceApi");

const vars = getRequiredVars({
  sfInstanceUrl: `sf-instanceUrl-${env}`,
  sfConsumerKey: `sf-consumerKey-${env}`,
  sfConsumerSecret: `sf-consumerSecret-${env}`,
});

const salesforceApi = new SalesforceApi({
  instanceUrl: vars.sfInstanceUrl,
  customerKey: vars.sfConsumerKey,
  customerSecret: vars.sfConsumerSecret,
  apiVersion: "58.0",
});

// OAuth2 authentication — call once before using
await salesforceApi.authenticate();
```

### Methods

```javascript
// Find
await salesforceApi.find("Contact", {
  filter: { Email: "john@example.com" },
  select: "Id FirstName LastName Email",
  limit: 100,
});

// Find one
await salesforceApi.findOne("Contact", { Email: "john@example.com" });
await salesforceApi.findOne("Contact", salesforceId); // By SF Id

// Create
const result = await salesforceApi.create("Contact", {
  FirstName: "John",
  LastName: "Doe",
  Email: "john@example.com",
});
// Returns: { id: '003XX...', success: true }

// Update
await salesforceApi.update("Contact", salesforceId, {
  MobilePhone: "+1 555 123 4567",
});

// Upsert
await salesforceApi.upsert(
  "Contact",
  { Email: "john@example.com" }, // Match field
  { FirstName: "John", LastName: "Doe" }, // Data
);

// Delete
await salesforceApi.delete("Contact", salesforceId);

// SOQL query
const results = await salesforceApi.query(
  "SELECT Id, Name, Email FROM Contact WHERE Email = :email",
  { email: "john@example.com" },
);
```

## HubSpotApi

### Initialization

```javascript
const HubSpotApi = require("../../../lib/vendors/hubspot/HubSpotApi");

const vars = getRequiredVars({
  hsAccessToken: `hs-accessToken-${env}`,
});

const hubspotApi = new HubSpotApi({
  accessToken: vars.hsAccessToken,
});

await hubspotApi.authenticate();
```

### Methods

```javascript
// Find
await hubspotApi.find("contacts", {
  filter: { email: "john@example.com" },
  select: "email firstname lastname phone",
  limit: 100,
});

// Find one
await hubspotApi.findOne("contacts", { email: "john@example.com" });
await hubspotApi.findOne("contacts", hubspotId);

// Create
const result = await hubspotApi.create("contacts", {
  email: "john@example.com",
  firstname: "John",
  lastname: "Doe",
});

// Update
await hubspotApi.update("contacts", hubspotId, {
  phone: "+1 555 123 4567",
});

// Upsert
await hubspotApi.upsert(
  "contacts",
  { email: "john@example.com" },
  { firstname: "John", lastname: "Doe" },
);

// Delete
await hubspotApi.delete("contacts", hubspotId);
```

## Raw HTTP with axios

For any other external API, use the global `axios`:

```javascript
// GET
const response = await axios.get("https://api.example.com/data", {
  headers: { Authorization: `Bearer ${vars.token}` },
});

// POST
const response = await axios.post("https://api.example.com/data", payload, {
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${vars.token}`,
  },
});

// PATCH
await axios.patch(`https://api.example.com/record/${id}`, updateData, {
  headers: { Authorization: `Bearer ${vars.token}` },
});
```

## Variables Pattern

Always use `getRequiredVars` to validate credentials exist:

```javascript
const { getRequiredVars } = require("../../../lib/utils/variables");

const vars = getRequiredVars({
  prolibuApiKey: `prolibu-apiKey-${env}`, // Different keys for dev/prod
  sfInstanceUrl: `sf-instanceUrl-${env}`,
  webhookSecret: "webhook-secret", // Same key for all envs
});

// vars.prolibuApiKey, vars.sfInstanceUrl, vars.webhookSecret
```

If any variable is missing, `getRequiredVars` throws an error listing all missing keys.
