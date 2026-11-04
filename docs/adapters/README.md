# API Adapter Development Guide

## 📋 Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Creating a New Adapter](#creating-a-new-adapter)
- [Adapter Requirements](#adapter-requirements)
- [Authentication Patterns](#authentication-patterns)
- [CRUD Method Specifications](#crud-method-specifications)
- [Data Mapping](#data-mapping)
- [Testing](#testing)
- [Documentation](#documentation)
- [Best Practices](#best-practices)
- [Common Pitfalls](#common-pitfalls)
- [Examples](#examples)

---

## Overview

### What is an API Adapter?

API Adapters are **standardized interfaces** between Prolibu and external systems (Salesforce, HubSpot, etc.). They abstract the complexity of third-party APIs and provide a **uniform CRUD interface** that matches the behavior of `ProlibuApi`.

### Why Standardization?

All adapters follow the same interface pattern, enabling:
- **Code reusability** across different integrations
- **Predictable behavior** for all CRUD operations
- **Consistent error handling** and retry logic
- **Unified authentication** patterns

### Core Principle

> **Every API adapter must behave exactly like `ProlibuApi`**  
> Same method signatures, same return formats, same error handling

---

## Architecture

### Integration Flow

```
Prolibu Event → OutboundIntegration → DataMapper → VendorApi (CRUD) → External System
                                                  ↓
                                            Complete Object Response
```

### Key Components

1. **VendorApi Class** (`lib/vendors/{vendor-name}/{VendorName}Api.js`)
   - Main adapter implementation
   - CRUD methods (create, find, findOne, update, delete)
   - Authentication logic
   - Error handling with retry

2. **Data Maps** (`lib/vendors/{vendor-name}/maps/`)
   - Field mapping configurations
   - Transform Prolibu fields → Vendor fields
   - One file per entity type (ContactMap.js, CompanyMap.js, etc.)

3. **Examples** (`lib/vendors/{vendor-name}/examples.js`)
   - Usage examples for developers
   - Common patterns and workflows

4. **Documentation** (`lib/vendors/{vendor-name}/README.md`)
   - Vendor-specific setup instructions
   - Authentication configuration
   - API quirks and limitations

---

## Project Structure

### Complete Adapter Structure

```
lib/vendors/{vendor-name}/
├── {VendorName}Api.js          # Main API adapter class
├── maps/                        # Data mapping configurations
│   ├── ContactMap.js           # Contact field mappings
│   ├── CompanyMap.js           # Company field mappings
│   └── DealMap.js              # Deal field mappings (if applicable)
├── examples.js                  # Usage examples
└── README.md                    # Vendor-specific documentation
```

### Example: Salesforce Structure

```
lib/vendors/salesforce/
├── SalesforceApi.js            # Main Salesforce adapter
├── maps/
│   ├── ContactMap.js           # Prolibu Contact ↔ Salesforce Contact
│   ├── CompanyMap.js           # Prolibu Company ↔ Salesforce Account
│   └── DealMap.js              # Prolibu Deal ↔ Salesforce Opportunity
├── examples.js                  # 11+ usage examples
└── README.md                    # Salesforce setup guide
```

---

## Creating a New Adapter

### Step-by-Step Process

#### 1. Create Vendor Directory Structure

```bash
mkdir -p lib/vendors/{vendor-name}/maps
```

#### 2. Create Main Adapter File

File: `lib/vendors/{vendor-name}/{VendorName}Api.js`

Start with this template:

```javascript
class VendorApi {
  constructor(config) {
    // Authentication credentials
    this.instanceUrl = config.instanceUrl;
    this.apiKey = config.apiKey;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    
    // Initialize axios instance
    this.axios = axios.create({
      baseURL: this.instanceUrl,
      timeout: 30000,
    });
    
    // Authentication state
    this.authenticated = false;
    this.accessToken = null;
    this.tokenExpiry = null;
    this.apiVersion = 'v1'; // Vendor-specific API version
  }

  // REQUIRED: Authentication
  async authenticate() { }

  // REQUIRED: Retry logic wrapper
  async executeWithRetry(fn, context = '', maxRetries = 3) { }

  // REQUIRED: CRUD Methods
  async create(objectType, data) { }
  async find(objectType, options) { }
  async findOne(objectType, id, options = {}) { }
  async update(objectType, id, data, options = {}) { }
  async delete(objectType, id) { }
  
  // REQUIRED: Utility methods
  getRefData(objectType, id) { }
  getRefUrl(objectType, id) { }
}

module.exports = VendorApi;
```

#### 3. Create Data Maps

File: `lib/vendors/{vendor-name}/maps/ContactMap.js`

```javascript
/**
 * Contact Field Mapping: Prolibu → Vendor
 * 
 * CRITICAL: Maps are ALWAYS source field → target field
 * Format: { prolibuFieldName: 'vendorFieldName' }
 */
module.exports = {
  // Basic Information
  firstName: 'FirstName',
  lastName: 'LastName',
  email: 'Email',
  phone: 'Phone',
  mobile: 'MobilePhone',
  
  // Address
  mailingStreet: 'MailingStreet',
  mailingCity: 'MailingCity',
  mailingState: 'MailingState',
  mailingPostalCode: 'MailingPostalCode',
  mailingCountry: 'MailingCountry',
  
  // Social
  linkedinUrl: 'LinkedIn__c',
  
  // Relationships
  accountId: 'AccountId', // Company reference
  
  // Metadata (usually read-only)
  // createdDate: 'CreatedDate',
  // lastModifiedDate: 'LastModifiedDate',
};
```

Create similar files for `CompanyMap.js`, `DealMap.js`, etc.

#### 4. Create Examples File

File: `lib/vendors/{vendor-name}/examples.js`

```javascript
/**
 * {VendorName} API Usage Examples
 * 
 * These examples demonstrate common integration patterns
 */

const VendorApi = require('./{VendorName}Api');

// Example 1: Initialize and authenticate
async function example1_authenticate() {
  const api = new VendorApi({
    instanceUrl: 'https://api.vendor.com',
    apiKey: 'your-api-key',
    clientId: 'your-client-id',
    clientSecret: 'your-client-secret'
  });
  
  await api.authenticate();
  console.log('Authenticated successfully');
}

// Example 2: Create a record
async function example2_createContact() {
  // Implementation
}

// Example 3: Find records with filters
async function example3_findContacts() {
  // Implementation
}

// Add 8-10 more examples covering all CRUD operations
```

#### 5. Create Documentation

File: `lib/vendors/{vendor-name}/README.md`

Include:
- Authentication setup instructions
- Configuration requirements
- Supported object types
- API version information
- Rate limits and quotas
- Common pitfalls specific to this vendor
- Code examples
- Troubleshooting tips

#### 6. Update Global Documentation

Add your adapter to:
- `/docs/README.md` - Integration Adapters section

---

## Adapter Requirements

### Required Methods

Every adapter MUST implement these methods with exact signatures:

| Method | Signature | Return Type | Description |
|--------|-----------|-------------|-------------|
| `authenticate()` | `async authenticate()` | `void` | Authenticate with vendor API |
| `create()` | `async create(objectType, data)` | `Object` | Create record, return complete object |
| `find()` | `async find(objectType, options)` | `{ pagination, data }` | Query multiple records |
| `findOne()` | `async findOne(objectType, id, options)` | `Object \| null` | Get single record by ID |
| `update()` | `async update(objectType, id, data, options)` | `Object` | Update record, return complete object |
| `delete()` | `async delete(objectType, id)` | `{ success: true }` | Delete record |
| `getRefData()` | `getRefData(objectType, id)` | `{ refId, refUrl }` | Get reference data |
| `getRefUrl()` | `getRefUrl(objectType, id)` | `string` | Get vendor UI URL |

### Required Properties

```javascript
this.authenticated = false;  // Auth state (boolean)
this.accessToken = null;     // Access token (string)
this.axios = null;           // Axios instance
```

---

## Authentication Patterns

### Pattern 1: OAuth2 Client Credentials Flow

**Used by:** Salesforce, HubSpot

```javascript
async authenticate() {
  try {
    const response = await axios.post(
      `${this.instanceUrl}/oauth2/token`,
      {
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }
    );
    
    this.accessToken = response.data.access_token;
    this.tokenExpiry = Date.now() + (response.data.expires_in * 1000);
    this.authenticated = true;
    
    console.log('Successfully authenticated with Vendor API');
  } catch (error) {
    console.error('Authentication failed:', error.message);
    throw new Error(`Failed to authenticate: ${error.message}`);
  }
}
```

### Pattern 2: API Key

**Used by:** Some REST APIs

```javascript
async authenticate() {
  if (this.apiKey) {
    this.accessToken = this.apiKey;
    this.authenticated = true;
    console.log('API key configured');
  } else {
    throw new Error('API key is required');
  }
}
```

### Pattern 3: OAuth2 with Token Caching (Prolibu Standard)

**⚠️ CRITICAL:** This is the **REQUIRED pattern** for OAuth2 adapters in Prolibu to avoid rate limits and improve performance.

**Used by:** Salesforce, HubSpot, any OAuth2 API with expiring tokens

```javascript
class VendorApi {
  constructor({ instanceUrl, clientId, clientSecret } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.instanceUrl = instanceUrl;
    
    // Token cache key - MUST follow this pattern
    this.tokenKey = `vendor-token-${env}`; // e.g., 'salesforce-token-production'
    
    // Detect environment
    this.isServerEnvironment = 
      typeof globalThis.setVariable === 'function' && 
      typeof globalThis.variables !== 'undefined';
    
    // Load cached token from Prolibu variables
    if (this.isServerEnvironment) {
      const tokenFound = globalThis.variables.find(v => v.key === this.tokenKey);
      this.tokenValue = tokenFound ? JSON.parse(tokenFound.value) : null;
    } else {
      this.tokenValue = null; // Local/test environment
    }
    
    this.accessToken = null;
    this.authenticated = false;
    this.TOKEN_REFRESH_BUFFER = 5 * 60 * 1000; // 5 minutes
  }

  // Check if cached token is valid
  async isTokenValid() {
    if (!this.tokenValue || !this.tokenValue.access_token || !this.tokenValue.issued_at) {
      return false;
    }

    const now = Date.now();
    const issuedAt = parseInt(this.tokenValue.issued_at);
    
    // Token lifetime (vendor-specific, e.g., Salesforce = 2 hours)
    const tokenLifetime = 5400 * 1000; // 1.5 hours (conservative)
    const expirationTime = issuedAt + tokenLifetime;
    const refreshTime = expirationTime - this.TOKEN_REFRESH_BUFFER;

    return now < refreshTime;
  }

  // Main authentication method
  async authenticate() {
    try {
      // Check if cached token is valid
      if (await this.isTokenValid()) {
        this.accessToken = this.tokenValue.access_token;
        this.authenticated = true;
        this.updateAxiosHeaders();
        return this.accessToken;
      }

      // Token expired or doesn't exist - get new one
      return await this.refreshToken();
      
    } catch (err) {
      await this.clearTokenCache();
      throw new Error(`Authentication failed: ${err.message}`);
    }
  }

  // Get new token and cache it
  async refreshToken() {
    try {
      const response = await axios.post(
        `${this.instanceUrl}/oauth2/token`,
        `grant_type=client_credentials&client_id=${encodeURIComponent(this.clientId)}&client_secret=${encodeURIComponent(this.clientSecret)}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          }
        }
      );

      // Build token response with cache timestamp
      const tokenResponse = {
        ...response.data,
        cached_at: Date.now()
      };

      // ⚠️ CRITICAL: Cache token using setVariable (only in server environment)
      if (this.isServerEnvironment) {
        await globalThis.setVariable(this.tokenKey, JSON.stringify(tokenResponse));
      }
      
      // Update instance state
      this.tokenValue = tokenResponse;
      this.accessToken = tokenResponse.access_token;
      this.authenticated = true;
      this.updateAxiosHeaders();
      
      return this.accessToken;
      
    } catch (err) {
      throw new Error(`Token refresh failed: ${err.message}`);
    }
  }

  // Clear token cache on invalidation
  async clearTokenCache() {
    try {
      if (this.isServerEnvironment) {
        await globalThis.setVariable(this.tokenKey, '');
      }
      
      this.tokenValue = null;
      this.accessToken = null;
      this.authenticated = false;
      delete this.axios.defaults.headers.Authorization;
      
    } catch (err) {
      console.log('Warning: Failed to clear token cache:', err.message);
    }
  }

  // Update axios headers with current token
  updateAxiosHeaders() {
    if (this.accessToken) {
      this.axios.defaults.headers.Authorization = `Bearer ${this.accessToken}`;
    }
  }

  // Auto-retry on token errors
  async executeWithRetry(operation, context = 'Operation') {
    let attempt = 0;
    const maxRetries = 1;
    
    while (attempt <= maxRetries) {
      try {
        return await operation();
      } catch (err) {
        // Check for token invalidation errors (401, INVALID_SESSION_ID, etc.)
        const isTokenError = 
          err.response?.status === 401 ||
          err.response?.data?.[0]?.errorCode === 'INVALID_SESSION_ID' ||
          err.response?.data?.[0]?.errorCode === 'SESSION_EXPIRED';
        
        if (isTokenError && attempt < maxRetries) {
          console.log('🔑 Token invalid, clearing cache and retrying...');
          await this.clearTokenCache();
          await this.authenticate();
          attempt++;
          continue; // Retry
        }
        
        throw err; // Not token error or max retries reached
      }
    }
  }

  // Debug method to check token status
  getTokenInfo() {
    if (!this.tokenValue) {
      return { status: 'No token cached' };
    }

    const now = Date.now();
    const issuedAt = parseInt(this.tokenValue.issued_at);
    const tokenLifetime = 5400 * 1000;
    const expirationTime = issuedAt + tokenLifetime;
    const timeUntilExpiration = expirationTime - now;

    return {
      status: 'Token cached',
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(expirationTime).toISOString(),
      timeUntilExpiration: `${Math.round(timeUntilExpiration / 1000 / 60)} minutes`,
      isValid: timeUntilExpiration > this.TOKEN_REFRESH_BUFFER
    };
  }
}
```

**Key Components:**

1. ✅ **Token Cache Key**: `{vendor}-token-{env}` pattern
2. ✅ **Load from Cache**: Read from `globalThis.variables` on init
3. ✅ **Validate Token**: Check expiry before each use
4. ✅ **Refresh Buffer**: Refresh 5 minutes before expiry
5. ✅ **Cache New Token**: Use `globalThis.setVariable()`
6. ✅ **Clear on Error**: Invalidate on 401/SESSION_EXPIRED
7. ✅ **Auto-Retry**: Retry once after token refresh
8. ✅ **Environment Detection**: Server vs local/test
9. ✅ **Debug Support**: `getTokenInfo()` method

**See complete implementation in:**
- `/lib/vendors/salesforce/SalesforceApi.js` (lines 80-240)
- `/lib/vendors/hubspot/HubSpotApi.js`

---

## CRUD Method Specifications

### CREATE Method

**Purpose:** Create a new record and return the **complete created object**.

**Signature:**
```javascript
async create(objectType, data)
```

**Parameters:**
- `objectType` (string): Vendor's object type name (e.g., `'Contact'`, `'Account'`)
- `data` (Object): Field-value pairs to create

**Return:** Complete object with ALL fields (not just ID)

**Implementation Pattern:**

```javascript
async create(objectType, data) {
  const createResult = await this.executeWithRetry(async () => {
    if (!this.authenticated) {
      await this.authenticate();
    }
    
    // Step 1: Create the record
    const response = await this.axios.post(
      `/api/${this.apiVersion}/objects/${objectType}`,
      data,
      {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        }
      }
    );
    
    return response.data; // Usually returns { id: '123', success: true }
  }, 'Create record');
  
  // Step 2: Fetch the complete created object
  if (createResult.success || createResult.id) {
    const recordId = createResult.id;
    const response = await this.axios.get(
      `/api/${this.apiVersion}/objects/${objectType}/${recordId}`,
      {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        }
      }
    );
    
    return response.data; // Complete object with all fields
  }
  
  throw new Error('Create failed');
}
```

**Critical Requirements:**
- ✅ Must return complete object with ALL fields
- ✅ Must make separate GET request after creation
- ✅ Must handle authentication
- ✅ Must use retry logic

---

### FIND Method

**Purpose:** Query multiple records with filtering, pagination, and sorting.

**Signature:**
```javascript
async find(objectType, options)
```

**Parameters:**
- `objectType` (string): Vendor's object type name
- `options` (string | Object): Query string OR query options

**When `options` is a string:** Native vendor query (e.g., SOQL)
```javascript
await api.find('Contact', "SELECT Id, Name FROM Contact WHERE Email != null LIMIT 10");
```

**When `options` is an Object:** Auto-build query with reserved fields

**Reserved Fields** (NOT in WHERE clause):
- `select` - Fields to return (comma-separated string)
- `limit` - Max records (number)
- `sort` - Sorting criteria (string)
- `page` - Page number (number, default: 1)

**All other fields** → WHERE clause conditions

**Example:**
```javascript
{
  select: 'Id, Name, Email',     // ← Reserved: SELECT
  limit: 50,                      // ← Reserved: LIMIT
  sort: 'CreatedDate DESC',       // ← Reserved: ORDER BY
  page: 2,                        // ← Reserved: OFFSET
  
  // Everything below → WHERE clause:
  FirstName: 'John',              // WHERE FirstName = 'John'
  Email: { $exists: true },       // AND Email != null
  Age: { $gt: 18 },               // AND Age > 18
}
```

**Supported Operators:**

| Operator | Meaning | Example |
|----------|---------|---------|
| `$exists` | Field is not null | `{ Email: { $exists: true } }` |
| `$ne` | Not equal | `{ Status: { $ne: 'Closed' } }` |
| `$gt` | Greater than | `{ Age: { $gt: 18 } }` |
| `$gte` | Greater or equal | `{ Age: { $gte: 18 } }` |
| `$lt` | Less than | `{ Price: { $lt: 100 } }` |
| `$lte` | Less or equal | `{ Price: { $lte: 100 } }` |
| `$in` | In array | `{ Status: { $in: ['A', 'B'] } }` |

**Return Format:**

```javascript
{
  pagination: {
    count: 150,        // Total records matching query
    page: 2,           // Current page number
    limit: 50,         // Records per page
    lastPage: 3,       // Math.ceil(count / limit)
    startIndex: 50     // (page - 1) * limit
  },
  data: [              // Array of matching records
    { Id: '001', Name: 'John', Email: 'john@example.com', ... },
    { Id: '002', Name: 'Jane', Email: 'jane@example.com', ... },
    // ...
  ]
}
```

**Critical Requirements:**
- ✅ Must support both string and object formats
- ✅ Reserved fields must NOT go to WHERE clause
- ✅ Must support all Prolibu operators
- ✅ Must return standardized pagination format
- ✅ `pagination.count` = total records (not just current page)

---

### FINDONE Method

**Purpose:** Retrieve a single record by ID.

**Signature:**
```javascript
async findOne(objectType, id, options = {})
```

**Parameters:**
- `objectType` (string): Vendor's object type name
- `id` (string): Record ID
- `options` (Object): Optional query options
  - `select` (string): Comma-separated fields to return

**Return:**
- Complete object if found
- `null` if not found (404)

**Implementation:**

```javascript
async findOne(objectType, id, options = {}) {
  try {
    return await this.executeWithRetry(async () => {
      if (!this.authenticated) {
        await this.authenticate();
      }

      const params = {};
      if (options.select) {
        params.fields = options.select;
      }

      const response = await this.axios.get(
        `/api/${this.apiVersion}/objects/${objectType}/${id}`,
        {
          params,
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
          }
        }
      );
      
      return response.data;
    }, 'Find single record');
  } catch (err) {
    // Return null for 404 instead of throwing
    if (err.response?.status === 404 || err.statusCode === 404) {
      return null;
    }
    throw err;
  }
}
```

**Critical Requirements:**
- ✅ Must return complete object when found
- ✅ Must return `null` for 404 (NOT throw error)
- ✅ Must support `options.select`
- ✅ Must throw errors for non-404 failures

---

### UPDATE Method

**Purpose:** Update an existing record and return the **complete updated object**.

**Signature:**
```javascript
async update(objectType, id, data, options = {})
```

**Parameters:**
- `objectType` (string): Vendor's object type name
- `id` (string): Record ID to update
- `data` (Object): Field-value pairs to update
- `options` (Object): Optional query options
  - `select` (string): Comma-separated fields to return

**Return:** Complete updated object with ALL fields

**Implementation:**

```javascript
async update(objectType, id, data, options = {}) {
  // Step 1: Update the record
  await this.executeWithRetry(async () => {
    if (!this.authenticated) {
      await this.authenticate();
    }
    
    await this.axios.patch(
      `/api/${this.apiVersion}/objects/${objectType}/${id}`,
      data,
      {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        }
      }
    );
  }, 'Update record');
  
  // Step 2: Fetch and return the updated object
  if (options.select) {
    return await this.findOne(objectType, id, { select: options.select });
  } else {
    const response = await this.axios.get(
      `/api/${this.apiVersion}/objects/${objectType}/${id}`,
      {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        }
      }
    );
    return response.data;
  }
}
```

**Critical Requirements:**
- ✅ Must return complete updated object
- ✅ Must make separate GET request after update
- ✅ Must support `options.select`
- ✅ If no select, return ALL fields

---

### DELETE Method

**Purpose:** Delete a record from the external system.

**Signature:**
```javascript
async delete(objectType, id)
```

**Parameters:**
- `objectType` (string): Vendor's object type name
- `id` (string): Record ID to delete

**Return:** `{ success: true }`

**Implementation:**

```javascript
async delete(objectType, id) {
  return await this.executeWithRetry(async () => {
    if (!this.authenticated) {
      await this.authenticate();
    }
    
    await this.axios.delete(
      `/api/${this.apiVersion}/objects/${objectType}/${id}`,
      {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        }
      }
    );
    
    return { success: true };
  }, 'Delete record');
}
```

**Critical Requirements:**
- ✅ Must return `{ success: true }`
- ✅ Must throw errors on failure

---

### Utility Methods

**getRefData:**

```javascript
getRefData(objectType, id) {
  if (!id) {
    throw new Error('"id" is required to get refData');
  }
  return {
    refId: id,
    refUrl: this.getRefUrl(objectType, id)
  };
}
```

**getRefUrl:**

```javascript
getRefUrl(objectType, id) {
  // Return vendor-specific UI URL
  return `${this.instanceUrl}/app/${objectType}/${id}`;
}
```

---

## Data Mapping

### Map File Structure

**File:** `lib/vendors/{vendor-name}/maps/ContactMap.js`

```javascript
/**
 * Contact Field Mapping: Prolibu → Vendor
 * 
 * CRITICAL: Maps are ALWAYS source field → target field
 * Format: { prolibuFieldName: 'vendorFieldName' }
 * 
 * Direction: Prolibu (source) → Vendor (target)
 */
module.exports = {
  // Basic Information
  firstName: 'FirstName',
  lastName: 'LastName',
  email: 'Email',
  phone: 'Phone',
  
  // Custom Fields (check vendor's schema)
  linkedinUrl: 'LinkedIn__c',
  
  // Relationships
  companyId: 'AccountId',
};
```

### Common Mapping Patterns

**1. Simple Field Mapping:**
```javascript
email: 'Email',          // Direct mapping
phone: 'Phone',          // Direct mapping
```

**2. Custom Fields (Salesforce-style):**
```javascript
customField: 'CustomField__c',  // Note the __c suffix
```

**3. Relationship Fields:**
```javascript
companyId: 'AccountId',   // Foreign key reference
ownerId: 'OwnerId',       // User reference
```

**4. Read-Only Fields (Comment Out):**
```javascript
// createdDate: 'CreatedDate',        // Read-only
// lastModifiedDate: 'LastModifiedDate', // Read-only
```

### Using Maps in Integration Scripts

```javascript
const ContactMap = require('./vendors/vendorname/maps/ContactMap');

// Transform Prolibu data → Vendor data
function toVendorFormat(prolibuContact) {
  const vendorData = {};
  for (const [prolibuField, vendorField] of Object.entries(ContactMap)) {
    if (prolibuContact[prolibuField] !== undefined) {
      vendorData[vendorField] = prolibuContact[prolibuField];
    }
  }
  return vendorData;
}

// Example
const prolibuContact = {
  firstName: 'John',
  lastName: 'Doe',
  email: 'john@example.com'
};

const vendorContact = toVendorFormat(prolibuContact);
// Result: { FirstName: 'John', LastName: 'Doe', Email: 'john@example.com' }
```

---

## Testing

### Manual Testing Checklist

Test each method individually:

```javascript
// 1. Authentication
await api.authenticate();
console.log('✓ Authenticated');

// 2. Create
const newRecord = await api.create('Contact', {
  FirstName: 'Test',
  LastName: 'User',
  Email: 'test@example.com'
});
console.log('✓ Created:', newRecord);

// 3. FindOne
const foundRecord = await api.findOne('Contact', newRecord.Id);
console.log('✓ Found:', foundRecord);

// 4. Find (with filters)
const searchResults = await api.find('Contact', {
  select: 'Id, FirstName, LastName, Email',
  LastName: 'User',
  limit: 10
});
console.log('✓ Search results:', searchResults.data.length);

// 5. Update
const updatedRecord = await api.update('Contact', newRecord.Id, {
  Phone: '+1-555-0123'
});
console.log('✓ Updated:', updatedRecord);

// 6. Delete
const deleteResult = await api.delete('Contact', newRecord.Id);
console.log('✓ Deleted:', deleteResult.success);

// 7. FindOne (404 check)
const notFound = await api.findOne('Contact', newRecord.Id);
console.log('✓ 404 returns null:', notFound === null);
```

### Error Testing

Test error scenarios:

```javascript
// 1. Invalid credentials
try {
  const badApi = new VendorApi({ apiKey: 'invalid' });
  await badApi.authenticate();
} catch (err) {
  console.log('✓ Invalid auth throws error');
}

// 2. Record not found (update)
try {
  await api.update('Contact', 'INVALID_ID', { Phone: '123' });
} catch (err) {
  console.log('✓ Invalid ID throws error');
}

// 3. Validation error
try {
  await api.create('Contact', { Email: 'invalid-email' });
} catch (err) {
  console.log('✓ Validation error caught');
}
```

---

## Documentation

### Adapter README Template

File: `lib/vendors/{vendor-name}/README.md`

```markdown
# {Vendor Name} API Adapter

## Overview

Brief description of the vendor and what this adapter does.

## Authentication

### Requirements

- API Key / Client ID
- Client Secret
- Instance URL

### Configuration

\`\`\`javascript
const api = new VendorApi({
  instanceUrl: 'https://your-instance.vendor.com',
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret'
});
\`\`\`

## Supported Object Types

| Prolibu Entity | Vendor Object | Description |
|----------------|---------------|-------------|
| Contact | Contact | Individual contacts |
| Company | Account | Business accounts |
| Deal | Opportunity | Sales opportunities |

## API Methods

[Document each CRUD method with examples]

## Common Pitfalls

- [List vendor-specific issues]

## Rate Limits

- [Document rate limits]

## Troubleshooting

- [Common issues and solutions]
```

---

## Best Practices

### 1. Error Handling

**Always implement retry logic:**

```javascript
async executeWithRetry(fn, context = '', maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Retry on network errors and rate limits
      const isRetryable = 
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.response?.status === 429 ||
        error.response?.status >= 500;
      
      if (!isRetryable || attempt === maxRetries) {
        const errorMsg = error.response?.data?.message || error.message;
        throw new Error(`${context} failed: ${errorMsg}`);
      }
      
      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, attempt - 1) * 1000;
      console.log(`Retry attempt ${attempt}/${maxRetries} after ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}
```

### 2. Authentication Management

**Check auth before every request:**

```javascript
async create(objectType, data) {
  return await this.executeWithRetry(async () => {
    if (!this.authenticated) {
      await this.authenticate();
    }
    // ... rest of method
  }, 'Create record');
}
```

### 3. Token Refresh

**Handle 401 errors:**

```javascript
async makeRequest(config) {
  try {
    return await this.axios(config);
  } catch (error) {
    if (error.response?.status === 401) {
      // Token expired, re-authenticate
      await this.authenticate();
      // Retry request
      return await this.axios(config);
    }
    throw error;
  }
}
```

### 4. Logging

**Add meaningful logs:**

```javascript
async create(objectType, data) {
  console.log(`Creating ${objectType}...`);
  const result = await this.executeWithRetry(async () => {
    // ...
  }, 'Create record');
  console.log(`Successfully created ${objectType} with ID:`, result.Id);
  return result;
}
```

### 5. Type Safety

**Validate inputs:**

```javascript
async findOne(objectType, id, options = {}) {
  if (!id) {
    throw new Error('Record ID is required');
  }
  if (!objectType) {
    throw new Error('Object type is required');
  }
  // ...
}
```

---

## Common Pitfalls

### ❌ Pitfall 1: Wrong Field Mapping Direction

```javascript
// ❌ WRONG - This is backwards
{
  name: 'companyName'  // Vendor → Prolibu (wrong!)
}

// ✅ RIGHT - Always source → target
{
  companyName: 'name'  // Prolibu → Vendor (correct!)
}
```

**Rule:** Maps are ALWAYS `prolibuField: 'vendorField'`

---

### ❌ Pitfall 2: Not Returning Complete Object

```javascript
// ❌ WRONG - Only returning ID
async create(objectType, data) {
  const response = await this.axios.post('/api/objects', data);
  return { id: response.data.id, success: true };
}

// ✅ RIGHT - Fetch and return complete object
async create(objectType, data) {
  const createResponse = await this.axios.post('/api/objects', data);
  const recordId = createResponse.data.id;
  
  // Fetch complete object
  const getResponse = await this.axios.get(`/api/objects/${recordId}`);
  return getResponse.data; // All fields
}
```

---

### ❌ Pitfall 3: Throwing on 404 in findOne()

```javascript
// ❌ WRONG - Throwing error on 404
async findOne(objectType, id) {
  const response = await this.axios.get(`/api/objects/${id}`);
  return response.data;
  // Will throw on 404!
}

// ✅ RIGHT - Return null on 404
async findOne(objectType, id) {
  try {
    const response = await this.axios.get(`/api/objects/${id}`);
    return response.data;
  } catch (err) {
    if (err.response?.status === 404) {
      return null; // Expected behavior
    }
    throw err; // Other errors still throw
  }
}
```

---

### ❌ Pitfall 4: Reserved Fields in WHERE Clause

```javascript
// ❌ WRONG - Including reserved fields in WHERE
{
  select: 'Id, Name',
  limit: 10,
  page: 2
}
// Builds: WHERE select = 'Id, Name' AND limit = 10 (wrong!)

// ✅ RIGHT - Reserved fields excluded from WHERE
const { select, limit, sort, page, ...whereFields } = options;
// Now whereFields only has actual filter conditions
```

---

### ❌ Pitfall 5: Wrong Return Format for find()

```javascript
// ❌ WRONG - Missing pagination metadata
async find(objectType, options) {
  const response = await this.axios.get('/api/query');
  return response.data.records; // Just array
}

// ✅ RIGHT - Standardized pagination format
async find(objectType, options) {
  const response = await this.axios.get('/api/query');
  return {
    pagination: {
      count: response.data.totalSize,
      page: page,
      limit: limit,
      lastPage: Math.ceil(response.data.totalSize / limit),
      startIndex: (page - 1) * limit
    },
    data: response.data.records
  };
}
```

---

## Examples

### Complete Working Example: HubSpotApi

See the full implementation in the [OUTBOUND_API_ADAPTER_GUIDE.md](../../accounts/dev10.prolibu.com/hook-integrations/OUTBOUND_API_ADAPTER_GUIDE.md) attachment.

### Reference Implementations

1. **ProlibuApi** - `/lib/vendors/prolibu/ProlibuApi.js`
   - Reference standard for all adapters
   - Complete implementation of all methods

2. **SalesforceApi** - `/lib/vendors/salesforce/SalesforceApi.js`
   - OAuth2 authentication pattern
   - SOQL query building
   - Complete examples file

3. **HubSpotApi** - `/lib/vendors/hubspot/HubSpotApi.js`
   - API key authentication
   - GraphQL-style queries
   - Associations handling

---

## Quick Start Checklist

When creating a new adapter, follow this checklist:

### Planning Phase
- [ ] Research vendor's API documentation
- [ ] Identify authentication method (OAuth2, API Key, etc.)
- [ ] List supported object types (Contact, Account, etc.)
- [ ] Note API version and base URL
- [ ] Check rate limits and quotas

### Implementation Phase
- [ ] Create vendor directory: `lib/vendors/{vendor-name}/`
- [ ] Create main adapter class: `{VendorName}Api.js`
- [ ] Implement `authenticate()` method
- [ ] Implement `executeWithRetry()` wrapper
- [ ] Implement `create()` - returns complete object
- [ ] Implement `find()` - returns `{ pagination, data }`
- [ ] Implement `findOne()` - returns object or `null`
- [ ] Implement `update()` - returns complete object
- [ ] Implement `delete()` - returns `{ success: true }`
- [ ] Implement `getRefData()` and `getRefUrl()`
- [ ] Create field maps for each entity type
- [ ] Create examples.js with 10+ examples
- [ ] Create README.md with setup instructions

### Testing Phase
- [ ] Test authentication with valid credentials
- [ ] Test authentication with invalid credentials (should throw)
- [ ] Test create → verify complete object returned
- [ ] Test findOne with existing ID → verify complete object
- [ ] Test findOne with invalid ID → verify returns `null`
- [ ] Test find with string query (native)
- [ ] Test find with object options (auto-build)
- [ ] Test find pagination (multiple pages)
- [ ] Test update → verify complete object returned
- [ ] Test delete → verify `{ success: true }`
- [ ] Test retry logic (simulate network errors)
- [ ] Test rate limit handling (429 errors)

### Documentation Phase
- [ ] Document authentication setup in README
- [ ] Document supported object types
- [ ] Document API quirks and limitations
- [ ] Add troubleshooting section
- [ ] Update `/docs/README.md` with new adapter

---

## Getting Help

### Resources

1. **Reference Code:**
   - ProlibuApi: `/lib/vendors/prolibu/ProlibuApi.js`
   - SalesforceApi: `/lib/vendors/salesforce/SalesforceApi.js`
   - HubSpotApi: `/lib/vendors/hubspot/HubSpotApi.js`

2. **Documentation:**
   - OUTBOUND_API_ADAPTER_GUIDE.md (comprehensive guide)
   - Vendor-specific READMEs in `/lib/vendors/{vendor-name}/`

3. **Examples:**
   - `/lib/vendors/salesforce/examples.js` (11 examples)
   - Integration scripts in `/accounts/dev10.prolibu.com/hook-integrations/`

### Common Questions

**Q: Should maps be bidirectional?**  
A: No, maps are Prolibu → Vendor only. For reverse mapping, invert the map object.

**Q: What if the vendor doesn't support a CRUD operation?**  
A: Implement the method to throw a clear error: `throw new Error('Delete not supported by Vendor API')`

**Q: How do I handle vendor-specific query languages?**  
A: Support both string (native query) and object (auto-build) in `find()` method.

**Q: What about rate limits?**  
A: Use `executeWithRetry()` to handle 429 errors with exponential backoff.

---

## Summary

### Key Principles

1. **Standardization:** All adapters follow the same interface
2. **Complete Objects:** Always return full objects, not just IDs
3. **Consistent Errors:** Handle 404 as `null` in findOne, throw elsewhere
4. **Retry Logic:** Always retry on network errors and rate limits
5. **Documentation:** Every adapter needs README + examples

### Success Criteria

An adapter is complete when:
- ✅ All CRUD methods implemented with correct signatures
- ✅ Authentication works and tokens are managed
- ✅ Returns match ProlibuApi format exactly
- ✅ Error handling includes retry logic
- ✅ Field maps created for all supported entities
- ✅ Examples file demonstrates all operations
- ✅ README documents setup and usage
- ✅ All tests pass (manual or automated)

---

**Ready to build your first adapter?** Follow the [Step-by-Step Process](#creating-a-new-adapter) and reference the [Examples](#examples) section!
