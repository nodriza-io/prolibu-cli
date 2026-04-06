# Salesforce API Adapter

A standardized API adapter for integrating Salesforce CRM with the Prolibu platform. This adapter follows the same patterns as `ProlibuApi` and `HubSpotApi` to ensure consistent behavior across all outbound integrations.

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Authentication](#authentication)
- [Usage](#usage)
- [API Methods](#api-methods)
- [Salesforce Object Types](#salesforce-object-types)
- [Field Mappings](#field-mappings)
- [Error Handling](#error-handling)
- [Common Pitfalls](#common-pitfalls)
- [Best Practices](#best-practices)

## Overview

The Salesforce API adapter provides:

## Overview

The Salesforce API adapter provides:
- ✅ Standardized CRUD operations (Create, Read, Update, Delete)
- ✅ OAuth2 Client Credentials Flow authentication with token refresh
- ✅ Consistent response format matching `ProlibuApi`
- ✅ Automatic retry logic with token invalidation handling
- ✅ Support for Prolibu-style query operators (`$exists`, `$ne`, `$gt`, `$lt`, `$in`)
- ✅ Support for native SOQL queries
- ✅ Pagination support
- ✅ Complete object returns (all fields populated)
- ✅ Graceful 404 handling (`findOne` returns `null`)

## Installation

```javascript
const SalesforceApi = require('./lib/vendors/salesforce/SalesforceApi');

const salesforceApi = new SalesforceApi({
  instanceUrl: 'your-instance.my.salesforce.com',
  customerKey: 'YOUR_CONSUMER_KEY',
  customerSecret: 'YOUR_CONSUMER_SECRET',
  apiVersion: '58.0'
});

await salesforceApi.authenticate();
```

## Authentication

Salesforce uses **OAuth2 Client Credentials Flow** for server-to-server authentication.

### Setup Steps:

1. Setup → App Manager → New Connected App
2. Enable OAuth Settings
3. Enable "Client Credentials Flow"
4. Select OAuth Scopes:
   - Full access (full)
   - Perform requests at any time (refresh_token, offline_access)
5. Configure OAuth Policies (Permitted Users, IP Relaxation)
6. Copy **Consumer Key** and **Consumer Secret**

### In Prolibu:

Store credentials in Variables:
- `salesforce-customerKey-{environment}` - Your Salesforce Consumer Key
- `salesforce-customerSecret-{environment}` - Your Salesforce Consumer Secret
- `salesforce-instanceUrl-{environment}` - Your Salesforce instance URL

```javascript
const salesforceApi = new SalesforceApi({
  instanceUrl: await Variables.get('salesforce-instanceUrl-production'),
  customerKey: await Variables.get('salesforce-customerKey-production'),
  customerSecret: await Variables.get('salesforce-customerSecret-production'),
  apiVersion: '58.0'
});

await salesforceApi.authenticate();
```

### Token Caching & Refresh

The adapter automatically:
- ✅ Caches tokens in Prolibu variables (server environment)
- ✅ Refreshes tokens before expiration (5 minute buffer)
- ✅ Handles 401 errors by clearing cache and re-authenticating
- ✅ Retries failed requests once after token refresh

---

## Usage

### Create a Record

```javascript
// Create a Contact
const contact = await salesforceApi.create('Contact', {
  FirstName: 'Jane',
  LastName: 'Smith',
  Email: 'jane.smith@example.com',
  Phone: '+1-555-0123',
  Title: 'Software Engineer'
});

console.log('Created contact:', contact);
// { Id: '003XXX...', FirstName: 'Jane', LastName: 'Smith', Email: '...', CreatedDate: '...', ... }
```

### Find Records (Object-Based Query)

```javascript
// Find contacts with filtering
const contacts = await salesforceApi.find('Contact', {
  select: 'Id FirstName LastName Email Phone',  // Prolibu style: spaces
  where: {
    LastName: 'Smith',
    Email: { $exists: true },
    CreatedDate: { $gte: '2024-01-01' }
  },
  limit: 10,
  page: 1,
  sort: '-CreatedDate'  // Sort by CreatedDate descending
});

console.log('Found contacts:', contacts);
// {
//   pagination: { count: 150, page: 1, limit: 10, lastPage: 15, startIndex: 0 },
//   data: [ { Id: '003XXX...', FirstName: 'Jane', ... }, ... ]
// }
```

### Find Records (SOQL String Query)

```javascript
// Direct SOQL query
const result = await salesforceApi.find(
  'Contact',
  "SELECT Id, FirstName, LastName, Email FROM Contact WHERE Email LIKE '%@acme.com' ORDER BY CreatedDate DESC LIMIT 50"
);
```

### Find One Record

```javascript
// Get a specific contact by ID
const contact = await salesforceApi.findOne('Contact', '003XXX...', {
  select: 'Id FirstName LastName Email'  // Prolibu style: spaces, not commas
});

if (contact) {
  console.log('Found contact:', contact);
} else {
  console.log('Contact not found'); // Returns null for 404
}
```

### Update a Record

```javascript
// Update contact information
const updated = await salesforceApi.update('Contact', '003XXX...', {
  Phone: '+1-555-9876',
  MailingCity: 'San Francisco',
  Title: 'Senior Software Engineer'
});

console.log('Updated contact:', updated);
// { Id: '003XXX...', FirstName: 'Jane', Phone: '+1-555-9876', ... }
```

### Delete a Record

```javascript
// Delete a contact
const result = await salesforceApi.delete('Contact', '003XXX...');
console.log('Deleted:', result.success); // true
```

---

## API Methods

### `create(objectType, data)`

Creates a new record and returns the complete created object.

**Parameters:**
- `objectType` (string): Salesforce object type ('Contact', 'Account', 'Opportunity')
- `data` (Object): Field-value pairs to create

**Returns:** Complete object with all fields

### `find(objectType, options)`

Queries multiple records with filtering and pagination.

**Parameters:**
- `objectType` (string): Salesforce object type
- `options` (string | Object): SOQL string OR query options object
  - `select` (string): Space or comma-separated field names (Prolibu style: use spaces)
  - `where` (Object): Filter conditions
  - `limit` (number): Max records to return (default: 100)
  - `page` (number): Page number (default: 1)
  - `sort` (string): Sort field (use `-` prefix for descending)

**Supported Operators in `where`:**
- `$exists` - Field has a value
- `$ne` - Not equal
- `$gt` - Greater than
- `$gte` - Greater or equal
- `$lt` - Less than
- `$lte` - Less or equal
- `$in` - In array

**Returns:** `{ pagination, data }` object

### `findOne(objectType, id, options)`

Retrieves a single record by ID.

**Parameters:**
- `objectType` (string): Salesforce object type
- `id` (string): Record ID
- `options` (Object): Optional
  - `select` (string): Space or comma-separated field names (Prolibu style: use spaces)

**Returns:** Object or `null` if not found (404)

### `update(objectType, id, data, options)`

Updates a record and returns the complete updated object.

**Parameters:**
- `objectType` (string): Salesforce object type
- `id` (string): Record ID
- `data` (Object): Updated field values
- `options` (Object): Optional
  - `select` (string): Space or comma-separated field names to return

**Returns:** Complete updated object

### `delete(objectType, id)`

Deletes a record.

**Parameters:**
- `objectType` (string): Salesforce object type
- `id` (string): Record ID

**Returns:** `{ success: true }`

### `getRefData(objectType, id)`

Gets reference data for linking Prolibu records to Salesforce records.

**Returns:** `{ refId, refUrl }`

### `getRefUrl(objectType, id)`

Generates URL to view record in Salesforce UI.

**Returns:** Salesforce URL string

---

## Salesforce Object Types

Common Salesforce object types:

| Object Type | Description | Common Fields |
|-------------|-------------|---------------|
| `Contact` | Contact records | `FirstName`, `LastName`, `Email`, `Phone`, `Title` |
| `Account` | Company/Account records | `Name`, `Industry`, `BillingCity`, `BillingState`, `Website` |
| `Opportunity` | Deal/Opportunity records | `Name`, `Amount`, `StageName`, `CloseDate`, `Probability` |
| `Lead` | Lead records | `FirstName`, `LastName`, `Company`, `Email`, `Status` |
| `Case` | Support cases | `Subject`, `Description`, `Status`, `Priority` |
| `Task` | Task records | `Subject`, `ActivityDate`, `Status`, `Priority` |

---

## Field Mappings

See the `/maps` directory for predefined field mappings:

- `AccountMap.js` - Prolibu Company → Salesforce Account
- `ContactMap.js` - Prolibu Contact → Salesforce Contact
- `OpportunityMap.js` - Prolibu Deal → Salesforce Opportunity

**Important:** Field names in Salesforce are **PascalCase** (e.g., `FirstName`, `LastName`, not `firstname`, `lastname`).

---

## Error Handling

The adapter implements automatic retry logic:

- **Network errors** (ECONNRESET, ETIMEDOUT): Retries with exponential backoff
- **Rate limits** (429): Not common in Salesforce, but handled with retry
- **Server errors** (500+): Retries with backoff
- **Client errors** (400, 404, 403): Does NOT retry, throws immediately

```javascript
try {
  const contact = await salesforceApi.create('Contact', data);
} catch (error) {
  if (error.message.includes('DUPLICATE_VALUE')) {
    console.error('Duplicate record:', error.message);
  } else if (error.message.includes('REQUIRED_FIELD_MISSING')) {
    console.error('Missing required field:', error.message);
  } else {
    console.error('Salesforce error:', error.message);
  }
}
```

---

## Common Pitfalls

### 1. Field Names Are Case-Sensitive

❌ **WRONG:**
```javascript
await salesforceApi.create('Contact', {
  firstname: 'John',  // WRONG: lowercase
  lastname: 'Doe'
});
```

✅ **CORRECT:**
```javascript
await salesforceApi.create('Contact', {
  FirstName: 'John',  // CORRECT: PascalCase
  LastName: 'Doe'
});
```

### 2. Object Type Names Are PascalCase

❌ **WRONG:**
```javascript
await salesforceApi.find('contact', { ... });  // WRONG: lowercase
```

✅ **CORRECT:**
```javascript
await salesforceApi.find('Contact', { ... });  // CORRECT: PascalCase
```

### 3. Field Mapping Direction

Maps should always be **Source → Target** (Prolibu → Salesforce):

❌ **WRONG:**
```javascript
// maps/ContactMap.js
module.exports = {
  FirstName: 'firstName',  // BACKWARDS!
};
```

✅ **CORRECT:**
```javascript
// maps/ContactMap.js
module.exports = {
  firstName: 'FirstName',  // Prolibu field → Salesforce field
};
```

### 4. findOne Returns null for 404

Unlike throwing an error, `findOne` returns `null` when record not found:

```javascript
const contact = await salesforceApi.findOne('Contact', id);
if (!contact) {
  console.log('Not found - handled gracefully');
}
```

---

## Best Practices

### 1. Always Authenticate First

```javascript
await salesforceApi.authenticate();
```

### 2. Use Select to Limit Fields

```javascript
// Only fetch fields you need (improves performance)
// Prolibu style: use spaces instead of commas
const contact = await salesforceApi.findOne('Contact', id, {
  select: 'Id FirstName LastName Email'
});
```

### 3. Handle Pagination Properly

```javascript
const result = await salesforceApi.find('Contact', {
  select: 'Id FirstName LastName Email',  // Prolibu style: spaces
  limit: 50,
  page: 1
});

console.log(`Showing ${result.data.length} of ${result.pagination.count} total`);
console.log(`Page ${result.pagination.page} of ${result.pagination.lastPage}`);
```

### 4. Store Reference Data

```javascript
// After creating in Salesforce, store refId and refUrl in Prolibu
const sfContact = await salesforceApi.create('Contact', data);
const refData = salesforceApi.getRefData('Contact', sfContact.Id);

await prolibuApi.update('Contact', prolibuContactId, refData);
// Stores: { refId: '003XXX...', refUrl: 'https://your-instance.lightning.force.com/...' }
```

### 5. Use Operators for Complex Queries

```javascript
const results = await salesforceApi.find('Account', {
  select: 'Id Name Industry NumberOfEmployees',  // Prolibu style: spaces
  where: {
    Industry: { $ne: 'Retail' },              // Not Retail
    NumberOfEmployees: { $gt: 100 },          // More than 100 employees
    Website: { $exists: true },               // Has a website
    BillingCity: { $in: ['SF', 'NYC', 'LA'] } // In specific cities
  }
});
```

### 6. Check for null on findOne

```javascript
const contact = await salesforceApi.findOne('Contact', id);
if (!contact) {
  console.log('Contact not found');
  return;
}
```

### 7. Use SOQL for Complex Queries

For complex queries beyond simple operators, use SOQL directly:

```javascript
const result = await salesforceApi.find(
  'Opportunity',
  "SELECT Id, Name, Amount, StageName FROM Opportunity WHERE Amount > 10000 AND StageName != 'Closed Lost' AND CloseDate >= THIS_MONTH ORDER BY Amount DESC"
);
```

---

## Salesforce-Specific Notes

### Field Name Conventions

Salesforce uses **PascalCase** for all field names:
- Standard fields: `FirstName`, `LastName`, `Email`
- Custom fields end with `__c`: `CustomField__c`

### Record IDs

Salesforce IDs are 15 or 18 characters:
- 15-char: Case-sensitive
- 18-char: Case-insensitive (safer to use)

### API Rate Limits

Salesforce limits API calls per 24 hours based on license type:
- **Professional**: 1,000 calls/day
- **Enterprise**: 1,000 calls/day + 1,000 per user license
- **Unlimited**: 1,000 calls/day + 1,000 per user license

The adapter does NOT automatically handle API limit exceeded errors (different from network retries).

---

## Troubleshooting

### "Authentication failed"
- Verify Consumer Key and Consumer Secret are correct
- Check that Connected App has Client Credentials Flow enabled
- Ensure user running the integration has proper permissions

### "REQUIRED_FIELD_MISSING"
- Check Salesforce object's required fields
- Verify field names are spelled correctly (case-sensitive)

### "INVALID_CROSS_REFERENCE_KEY"
- The ID you're trying to reference doesn't exist
- Verify the related record exists in Salesforce

### "DUPLICATE_VALUE"
- Record with same unique field value already exists
- Check for duplicate prevention rules in Salesforce

---

## Related Documentation

- [Salesforce REST API Documentation](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/)
- [SOQL Reference](https://developer.salesforce.com/docs/atlas.en-us.soql_sosl.meta/soql_sosl/)
- [Salesforce Object Reference](https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/)
- [Outbound API Adapter Guide](../../../accounts/dev10.prolibu.com/hook-integrations/OUTBOUND_API_ADAPTER_GUIDE.md)

---

## License

Internal use - Prolibu Integration Framework
