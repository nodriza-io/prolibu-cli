# Lifecycle Hook Events

**eventName:** `<Model>.<hook>` (e.g. `Contact.afterUpdate`)  
**Trigger:** Entity CRUD operations (Create, Update, Delete)  
**Authentication:** None of its own — no `requestUser`; API calls need a key from the script's `variables`  
**Use Case:** Real-time data synchronization, validation, side effects

## Overview

Lifecycle Hook events are triggered automatically when entities are created, updated, or deleted in Prolibu. This is the most powerful event type for real-time integrations.

Perfect for:
- **Bidirectional synchronization** with external CRMs (Salesforce, HubSpot)
- **Data validation** before operations
- **Audit logging** and history tracking
- **Side effects** like notifications or cascade operations
- **Data enrichment** from external sources

## The 6 Lifecycle Hooks

| Hook | Trigger | Can Abort? | eventData Fields | Use Case |
|------|---------|------------|------------------|----------|
| **beforeCreate** | Before entity creation | ✅ Yes | `doc` | Validation, enrichment, abort creation |
| **afterCreate** | After entity creation | ❌ No | `doc` | Sync to external systems, notifications |
| **beforeUpdate** | Before entity update | ✅ Yes | `doc`, `beforeUpdateDoc`, `payload` | Validation, conditional updates |
| **afterUpdate** | After entity update | ❌ No | `doc`, `beforeUpdateDoc`, `payload` | Sync changes to external systems |
| **beforeDelete** | Before entity deletion | ✅ Yes | `doc` | Validation, prevent deletion |
| **afterDelete** | After entity deletion | ❌ No | `doc` | Cascade deletes, sync deletion |

An error in a `before…` hook aborts the operation. An error in an `after…` hook cannot undo it: the record is already saved, but the request still answers with the error `"<message> - Lifecycle script [<scriptName>]"`.

## How It Works

```mermaid
sequenceDiagram
    participant Client
    participant API as Prolibu API
    participant Before as before Hook
    participant DB as Database
    participant After as after Hook
    participant External as External System
    
    Client->>API: Create/Update/Delete Request
    API->>Before: Execute before Hook
    
    alt beforeHook Throws Error
        Before-->>API: Abort Operation
        API-->>Client: 400 Error
    else beforeHook Success
        Before-->>API: Continue
        API->>DB: Perform Operation
        DB-->>API: Success
        API->>After: Execute after Hook
        After->>External: Sync Changes
        External-->>After: Success
        After-->>API: Complete
        API-->>Client: 200 Success
    end
```

## Configuration

Hooks need two switches:

1. **The account** must have lifecycle hooks enabled for the object. Only an admin turns this on, in the app's preferences (Integrations › Lifecycle hooks). Saving a script that lists an object that is not enabled is rejected, and a script already saved that way fails on every run.
2. **The script** must be active and list the object in `lifecycleHooks`. With this CLI, that list lives in the script's `config.json`: `"lifecycleHooks": ["Contact"]`.

Every active script that lists the object runs on each event, one after the other.

### Script Structure

The platform does not call a handler object. It runs the whole script with two globals: `eventName`, which is `"<Model>.<hook>"` (for example `"Contact.afterUpdate"`), and `eventData`. With this repo's `EventManager`, register one handler per event:

```javascript
const Events = require('../../../../lib/vendors/prolibu/EventManager');

Events.on('Contact.beforeCreate', async () => {
  const { doc } = eventData;
  if (!doc.email) throw new Error('Email is required'); // aborts the create
  doc.source = 'prolibu';                                // saved with the record
});

Events.on('Contact.afterUpdate', async () => {
  const { doc, beforeUpdateDoc, payload } = eventData;
  // sync the change to another system…
});

(async function main() {
  await Events.init();
})();
```

- Keep `main()` as the last statement and do not use `module.exports`: the run ends when that last promise settles.
- `EventManager` drops a `<Model>.<hook>` handler (with a `[WARN] … ignored` console line) unless `<Model>` is in the script's `lifecycleHooks`.
- A hook has no `requestUser` and no API identity of its own. To call the API, build a client with a key stored in the script's `variables` (`lib/vendors/prolibu/ProlibuApi`).

The examples further down are written as helper functions — `(doc, { API, logger })` or `(doc, beforeUpdateDoc, payload, { API, logger })` — to keep them short. The platform does not call them with those arguments: wire each one from its `Events.on` handler, passing `eventData.doc` itself (mutate that object, not a copy), an `API` object you build from the repo's clients, and a `logger` that forwards to `console.info` / `warn` / `error`:

```javascript
Events.on('Contact.afterUpdate', async () => {
  const { doc, beforeUpdateDoc, payload } = eventData;
  await afterUpdate(doc, beforeUpdateDoc, payload, { API, logger });
});
```

For a config-driven outbound sync (field maps and transforms), see `lib/vendors/prolibu/OutboundIntegration.js` with `DataMapper` and `ConfigValidator`.

## Event Data Structure

A hook run gets these globals. There is no `requestUser`, `hookType`, `objectName`, `apiKey` or `scriptId`: read the model and the hook from `eventName` (`const [model, hook] = eventName.split('.')`).

| Global | Value |
|---|---|
| `eventName` | `"<Model>.<hook>"`, e.g. `"Contact.afterUpdate"` |
| `eventData` | The payload below |
| `scriptCode`, `variables`, `localDomain`, `lifecycleHooks`, `env` | As in any run |

### beforeCreate / afterCreate / beforeDelete / afterDelete

```javascript
// eventName === "Contact.beforeCreate"
eventData = {
  doc: Object,                 // The record
}
```

### beforeUpdate / afterUpdate

```javascript
// eventName === "Contact.beforeUpdate"
eventData = {
  doc: Object,                 // The record with the update already applied
  beforeUpdateDoc: Object,     // The record before the update
  payload: Object,             // The fields sent in the update request
}
```

### Example Event Data

```javascript
// eventName === "Contact.afterUpdate"
eventData = {
  // Previous state
  beforeUpdateDoc: {
    _id: "60c72b2f9b1d4c3a1c8b4567",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane.old@example.com",
    mobile: "+1234567890"
  },

  // Current state
  doc: {
    _id: "60c72b2f9b1d4c3a1c8b4567",
    firstName: "Jane",
    lastName: "Smith",               // Changed
    email: "jane.new@example.com",   // Changed
    mobile: "+1234567890"
  },

  // Fields sent in the update
  payload: {
    lastName: "Smith",
    email: "jane.new@example.com"
  }
}
```

Record payloads are JSON copies: dates and ids are strings, and encrypted fields are masked. In a `before…` hook, top-level fields you change on `eventData.doc` are saved with the record; changing `eventData.payload` in `beforeUpdate` does not change what is saved (the payload is already applied to `doc`).

## Hook Implementations

### beforeCreate Hook

**Purpose**: Validate, enrich, or abort entity creation

```javascript
Handlers: {
  beforeCreate: async (doc, { API, logger }) => {
    logger.info('Before creating', { doc });
    
    // 1. Validation
    if (!doc.email) {
      throw new Error('Email is required');  // Aborts creation
    }
    
    // 2. Enrichment
    if (!doc.status) {
      doc.status = 'active';  // Set default value
    }
    
    // 3. External validation
    const exists = await API.salesforce.findOne('Contact', {
      Email: doc.email
    });
    
    if (exists) {
      throw new Error('Contact already exists in Salesforce');
    }
    
    // 4. Modify doc before creation (top-level changes are saved;
    //    createdBy is set by the platform)
    doc.source = 'prolibu';
    
    return doc;  // The return value is ignored; the mutated doc is what counts
  }
}
```

### afterCreate Hook

**Purpose**: Sync to external systems, send notifications

```javascript
Handlers: {
  afterCreate: async (doc, { API, logger }) => {
    logger.info('After creating', { docId: doc._id });
    
    try {
      // 1. Map Prolibu data to Salesforce format
      const mapped = DataMapper.mapWithConfig(doc, entityConfig, logger);
      
      // 2. Create in Salesforce
      const sfResult = await API.salesforce.create('Contact', {
        FirstName: mapped.firstName,
        LastName: mapped.lastName,
        Email: mapped.email,
        MobilePhone: mapped.mobile
      });
      
      logger.info('Synced to Salesforce', {
        prolibuId: doc._id,
        salesforceId: sfResult.id
      });
      
      // 3. Store external ID in Prolibu
      await API.prolibu.update('Contact', doc._id, {
        externalId: sfResult.id
      });
      
      // 4. Send notification (optional)
      // await sendNotification('Contact created', doc);
      
    } catch (error) {
      logger.error('Failed to sync to Salesforce', error);
      // Don't throw - entity is already created
    }
  }
}
```

### beforeUpdate Hook

**Purpose**: Validate changes, conditional updates

```javascript
Handlers: {
  beforeUpdate: async (doc, beforeUpdateDoc, payload, { API, logger }) => {
    logger.info('Before updating', {
      docId: doc._id,
      changes: Object.keys(payload)
    });
    
    // 1. Validate specific field changes
    if (payload.email) {
      // Check if new email is valid
      if (!isValidEmail(payload.email)) {
        throw new Error('Invalid email format');
      }
      
      // Check if email already exists
      const existing = await API.prolibu.findOne('Contact', {
        email: payload.email,
        _id: { $ne: doc._id }
      });
      
      if (existing) {
        throw new Error('Email already in use');
      }
    }
    
    // 2. Prevent certain changes
    if (payload.status === 'deleted' && beforeUpdateDoc.hasActiveOrders) {
      throw new Error('Cannot delete contact with active orders');
    }
    
    // 3. Conditional modifications
    if (payload.status && payload.status !== beforeUpdateDoc.status) {
      doc.statusChangedAt = new Date().toISOString();
      // There is no requestUser in a hook to record who did it
    }
    
    return doc;
  }
}
```

### afterUpdate Hook

**Purpose**: Sync changes to external systems

```javascript
Handlers: {
  afterUpdate: async (doc, beforeUpdateDoc, payload, { API, logger }) => {
    logger.info('After updating', {
      docId: doc._id,
      changes: Object.keys(payload)
    });
    
    try {
      // 1. Only sync if specific fields changed
      const syncFields = ['name', 'email', 'mobile', 'company'];
      const shouldSync = Object.keys(payload).some(key => 
        syncFields.includes(key)
      );
      
      if (!shouldSync) {
        logger.debug('No syncable fields changed, skipping');
        return;
      }
      
      // 2. Get external ID
      const externalId = doc.externalId;
      if (!externalId) {
        logger.warn('No external ID found, creating in Salesforce');
        // Create instead of update
        await createInSalesforce(doc, API, logger);
        return;
      }
      
      // 3. Map only changed fields
      const mapped = DataMapper.mapWithConfig(payload, entityConfig, logger);
      
      // 4. Update in Salesforce
      await API.salesforce.update('Contact', externalId, {
        FirstName: mapped.firstName,
        LastName: mapped.lastName,
        Email: mapped.email,
        MobilePhone: mapped.mobile
      });
      
      logger.info('Updated in Salesforce', {
        prolibuId: doc._id,
        salesforceId: externalId,
        fields: Object.keys(mapped)
      });
      
    } catch (error) {
      logger.error('Failed to sync update to Salesforce', error);
      // Don't throw - entity is already updated
    }
  }
}
```

### beforeDelete Hook

**Purpose**: Prevent deletion, validation

```javascript
Handlers: {
  beforeDelete: async (doc, { API, logger }) => {
    logger.info('Before deleting', { docId: doc._id });
    
    // 1. Check for dependencies
    const hasOrders = await API.prolibu.count('Order', {
      contactId: doc._id,
      status: 'active'
    });
    
    if (hasOrders > 0) {
      throw new Error('Cannot delete contact with active orders');
    }
    
    // 2. Permissions: a hook has no requestUser, so it cannot check
    //    who is deleting. Restrict deletes with roles instead.
    
    // 3. Soft delete instead
    if (doc.hasHistory) {
      // Convert to soft delete
      await API.prolibu.update('Contact', doc._id, {
        status: 'deleted',
        deletedAt: new Date().toISOString()
      });
      
      throw new Error('Contact archived instead of deleted');
    }
    
    logger.info('Deletion allowed', { docId: doc._id });
  }
}
```

### afterDelete Hook

**Purpose**: Cascade deletes, sync deletion

```javascript
Handlers: {
  afterDelete: async (doc, { API, logger }) => {
    logger.info('After deleting', { docId: doc._id });
    
    try {
      // 1. Delete from external system
      if (doc.externalId) {
        const deleted = await API.salesforce.delete('Contact', doc.externalId);
        
        if (deleted) {
          logger.info('Deleted from Salesforce', {
            prolibuId: doc._id,
            salesforceId: doc.externalId
          });
        } else {
          logger.warn('Contact not found in Salesforce', {
            salesforceId: doc.externalId
          });
        }
      }
      
      // 2. Cascade delete related records
      const relatedAddresses = await API.prolibu.find('Address', {
        contactId: doc._id
      });
      
      for (const address of relatedAddresses) {
        await API.prolibu.delete('Address', address._id);
      }
      
      logger.info('Cascade deleted addresses', {
        count: relatedAddresses.length
      });
      
      // 3. Log for audit
      await API.prolibu.create('AuditLog', {
        action: 'delete',
        objectName: 'Contact',
        objectId: doc._id,
        timestamp: new Date(),
        data: doc
      });
      
    } catch (error) {
      logger.error('Failed to complete after-delete actions', error);
      // Don't throw - entity is already deleted
    }
  }
}
```

## Real-World Example: Bidirectional Sync

A sketch in the helper style above (wire each handler from `Events.on`, see [Script Structure](#script-structure)):

```javascript
/**
 * Outbound Salesforce Integration
 * Syncs Contact changes from Prolibu to Salesforce
 */

const DataMapper = require('../../../../lib/vendors/prolibu/DataMapper');
const ContactMap = require('../../../../lib/vendors/salesforce/maps/ContactMap');

const integration = {   // not module.exports: it breaks a script entry
  Handlers: {
    // After a contact is created in Prolibu
    afterCreate: async (doc, { API, logger }) => {
      const mapped = DataMapper.mapWithConfig(doc, entityConfig, logger);
      
      const sfContact = await API.salesforce.create('Contact', {
        FirstName: mapped.firstName,
        LastName: mapped.lastName,
        Email: mapped.email,
        MobilePhone: mapped.mobile
      });
      
      // Store Salesforce ID in Prolibu
      await API.prolibu.update('Contact', doc._id, {
        externalId: sfContact.id
      });
      
      logger.info('Contact synced to Salesforce', {
        prolibuId: doc._id,
        salesforceId: sfContact.id
      });
    },
    
    // After a contact is updated in Prolibu
    afterUpdate: async (doc, beforeUpdateDoc, payload, { API, logger }) => {
      if (!doc.externalId) {
        logger.warn('No Salesforce ID, skipping sync');
        return;
      }
      
      // Only sync if specific fields changed
      const syncFields = ['name', 'email', 'mobile'];
      const hasChanges = Object.keys(payload).some(key => 
        syncFields.includes(key)
      );
      
      if (!hasChanges) {
        logger.debug('No syncable fields changed');
        return;
      }
      
      const mapped = DataMapper.mapWithConfig(payload, entityConfig, logger);
      
      await API.salesforce.update('Contact', doc.externalId, {
        FirstName: mapped.firstName,
        LastName: mapped.lastName,
        Email: mapped.email,
        MobilePhone: mapped.mobile
      });
      
      logger.info('Contact updated in Salesforce', {
        prolibuId: doc._id,
        salesforceId: doc.externalId
      });
    },
    
    // After a contact is deleted in Prolibu
    afterDelete: async (doc, { API, logger }) => {
      if (!doc.externalId) {
        logger.warn('No Salesforce ID, skipping delete');
        return;
      }
      
      const deleted = await API.salesforce.delete('Contact', doc.externalId);
      
      if (deleted) {
        logger.info('Contact deleted from Salesforce', {
          prolibuId: doc._id,
          salesforceId: doc.externalId
        });
      } else {
        logger.warn('Contact not found in Salesforce');
      }
    },
  },
  
  EntityConfig: [
    {
      objectName: 'Contact',
      externalObjectName: 'Contact',
      defaultEvents: ['afterCreate', 'afterUpdate', 'afterDelete'],
      globalTransforms: {
        OwnerId: '005xx000001X8UzAAK'  // Default Salesforce owner
      },
      fieldsMap: ContactMap
    }
  ]
};

// Contact configuration
const entityConfig = {
  objectName: 'Contact',
  externalObjectName: 'Contact',
  fieldsMap: ContactMap,
  globalTransforms: {
    OwnerId: '005xx000001X8UzAAK'
  }
};
```

## Entity Configuration

### EntityConfig Structure

```javascript
EntityConfig: [
  {
    // Required fields
    objectName: String,                // Prolibu entity name
    externalObjectName: String,        // External system object name
    defaultEvents: Array<String>,      // Which hooks to enable
    
    // Optional fields
    globalTransforms: Object,          // Applied to all records
    fieldsMap: Object,                 // Field mapping configuration
    filter: Object,                    // Only sync matching records
    
    // Advanced options
    batchSize: Number,                 // For bulk operations
    retryOnFailure: Boolean,           // Retry failed syncs
    cascadeDelete: Boolean,            // Delete related records
  }
]
```

### Field Mapping

```javascript
fieldsMap: {
  // Simple mapping
  email: 'Email',
  mobile: 'MobilePhone',
  
  // Nested mapping
  'name': 'FirstName LastName',  // Split name into first/last
  
  // Transform function
  status: {
    externalField: 'Status__c',
    transform: (value) => value.toUpperCase()
  },
  
  // Conditional mapping
  owner: {
    externalField: 'OwnerId',
    transform: (value, doc) => {
      return doc.assignedTo || '005xx000001X8UzAAK';
    }
  }
}
```

### Global Transforms

Applied to all records:

```javascript
globalTransforms: {
  OwnerId: '005xx000001X8UzAAK',      // Default owner
  RecordTypeId: '012xx000000abcdAAA',  // Default record type
  Source__c: 'Prolibu',                // Track source
  SyncedAt__c: () => new Date()        // Dynamic value
}
```

### Default Events

Specify which hooks to enable:

```javascript
defaultEvents: ['afterCreate', 'afterUpdate', 'afterDelete']

// Or be selective:
defaultEvents: ['afterCreate']  // Only sync new records

// All possible events:
defaultEvents: [
  'beforeCreate',
  'afterCreate',
  'beforeUpdate',
  'afterUpdate',
  'beforeDelete',
  'afterDelete'
]
```

## Use Cases

### 1. Bidirectional CRM Sync

Sync contacts between Prolibu and Salesforce/HubSpot:

```javascript
// afterUpdate: Sync changes FROM Prolibu TO Salesforce
afterUpdate: async (doc, beforeUpdateDoc, payload, { API, logger }) => {
  await API.salesforce.update('Contact', doc.externalId, mappedData);
}

// Webhook endpoint: Sync changes FROM Salesforce TO Prolibu
// (See EndpointRequest documentation)
```

### 2. Data Validation

Validate data before creation:

```javascript
beforeCreate: async (doc, { API, logger }) => {
  // Validate email format
  if (!isValidEmail(doc.email)) {
    throw new Error('Invalid email format');
  }
  
  // Check for duplicates
  const exists = await API.prolibu.findOne('Contact', {
    email: doc.email
  });
  
  if (exists) {
    throw new Error('Contact with this email already exists');
  }
}
```

### 3. Audit Logging

Track all changes:

```javascript
afterUpdate: async (doc, beforeUpdateDoc, payload, { API, logger }) => {
  await API.prolibu.create('AuditLog', {
    action: 'update',
    objectName: 'Contact',
    objectId: doc._id,
    changes: payload,                 // no requestUser in hooks
    before: beforeUpdateDoc,
    after: doc,
    timestamp: new Date()
  });
}
```

### 4. Cascade Operations

Delete related records:

```javascript
afterDelete: async (doc, { API, logger }) => {
  // Delete all addresses for this contact
  const addresses = await API.prolibu.find('Address', {
    contactId: doc._id
  });
  
  for (const address of addresses) {
    await API.prolibu.delete('Address', address._id);
  }
  
  logger.info(`Cascade deleted ${addresses.length} addresses`);
}
```

### 5. Data Enrichment

Enrich data from external sources:

```javascript
beforeCreate: async (doc, { API, logger }) => {
  // Lookup company data from external service
  if (doc.company) {
    const companyData = await fetchCompanyData(doc.company);
    doc.industry = companyData.industry;
    doc.companySize = companyData.employeeCount;
  }
  
  return doc;
}
```

## Best Practices

### ✅ DO

- **Use afterHooks for Syncing**: Sync after the operation completes
- **Validate in beforeHooks**: Prevent bad data with validation
- **Log Everything**: Use structured logging for debugging
- **Handle Errors Gracefully**: Don't throw in afterHooks
- **Use Payload in Updates**: Only sync fields that changed
- **Implement Idempotency**: Handle duplicate executions
- **Check External IDs**: Verify records exist before updating
- **Use Boolean Returns**: Return true/false from delete operations
- **Batch Operations**: Process multiple records efficiently
- **Track Sync State**: Store sync timestamps and status

### ❌ DON'T

- **Throw in afterHooks**: Operation is already complete, log errors instead
- **Sync Everything in Updates**: Only sync changed fields (use payload)
- **Create Infinite Loops**: Prevent hook → update → hook cycles
- **Skip Error Handling**: Always wrap external API calls in try/catch
- **Block Too Long**: Keep hooks fast, queue heavy operations
- **Assume a Caller**: Hooks get no `requestUser`; enforce permissions with roles
- **Hard-code Values**: Keep keys and external IDs in the script's `variables` (there are no environment variables)
- **Sync Unchanged Data**: Check payload before syncing

## Error Handling

### In beforeHooks (Can Abort)

```javascript
beforeCreate: async (doc, { API, logger }) => {
  try {
    // Validation
    await validateContact(doc);
    return doc;
    
  } catch (error) {
    logger.error('Validation failed', error);
    throw error;  // ✅ Throws abort the operation
  }
}
```

### In afterHooks (Cannot Abort)

```javascript
afterCreate: async (doc, { API, logger }) => {
  try {
    // Sync to Salesforce
    await API.salesforce.create('Contact', mappedData);
    logger.info('Synced successfully');
    
  } catch (error) {
    logger.error('Sync failed', error);
    // ❌ DON'T throw - entity is already created
    // ✅ DO log the error for retry later
    
    // Optional: Queue for retry
    await API.prolibu.create('SyncQueue', {
      type: 'contact-create',
      contactId: doc._id,
      error: error.message,
      retryCount: 0
    });
  }
}
```

## Preventing Infinite Loops

### Problem

```javascript
// ❌ BAD: Creates infinite loop
afterUpdate: async (doc, beforeUpdateDoc, payload, { API, logger }) => {
  // This triggers another afterUpdate → infinite loop
  await API.prolibu.update('Contact', doc._id, {
    lastSyncedAt: new Date()
  });
}
```

### Solutions

#### 1. Check Payload

```javascript
// ✅ GOOD: Only sync specific fields
afterUpdate: async (doc, beforeUpdateDoc, payload, { API, logger }) => {
  const syncFields = ['name', 'email', 'mobile'];
  const shouldSync = Object.keys(payload).some(key => 
    syncFields.includes(key)
  );
  
  if (!shouldSync) {
    logger.debug('No syncable fields changed, skipping');
    return;
  }
  
  // Sync to external system...
}
```

#### 2. Recognize Your Own Write

There is no flag that skips hooks: every write through the API fires them again, and unknown fields are dropped. Recognize your own write by what it changes:

```javascript
// ✅ GOOD: skip the update this hook made itself
afterUpdate: async (doc, beforeUpdateDoc, payload, { API, logger }) => {
  const keys = Object.keys(payload);
  if (keys.length === 1 && keys[0] === 'lastSyncedAt') {
    return;  // our own write below
  }
  
  // Sync to Salesforce
  await API.salesforce.update('Contact', doc.externalId, mappedData);
  
  // This update fires the hook again; the check above stops it
  await API.prolibu.update('Contact', doc._id, {
    lastSyncedAt: new Date().toISOString()
  });
}
```

#### 3. Compare Values

```javascript
// ✅ GOOD: Only sync if value actually changed
afterUpdate: async (doc, beforeUpdateDoc, payload, { API, logger }) => {
  if (doc.email === beforeUpdateDoc.email) {
    return;  // Email didn't change
  }
  
  // Sync email change to Salesforce...
}
```

## Testing

### Unit Testing Hooks

```javascript
// test/outbound-salesforce.test.js
describe('Contact Lifecycle Hooks', () => {
  it('syncs contact creation to Salesforce', async () => {
    // Create contact in Prolibu
    const contact = await API.prolibu.create('Contact', {
      name: 'John Doe',
      email: 'john@example.com',
      mobile: '+1234567890'
    });
    
    // Wait for afterCreate hook
    await sleep(1000);
    
    // Verify sync to Salesforce
    const sfContact = await API.salesforce.findOne('Contact', {
      Email: 'john@example.com'
    });
    
    expect(sfContact).toBeDefined();
    expect(sfContact.FirstName).toBe('John');
    expect(sfContact.LastName).toBe('Doe');
  });
  
  it('syncs contact updates to Salesforce', async () => {
    // Update contact
    await API.prolibu.update('Contact', contactId, {
      mobile: '+9876543210'
    });
    
    // Wait for afterUpdate hook
    await sleep(1000);
    
    // Verify update in Salesforce
    const sfContact = await API.salesforce.findOne('Contact', {
      Id: externalId
    });
    
    expect(sfContact.MobilePhone).toBe('+9876543210');
  });
});
```

### Integration Testing

```bash
# Run a script's jest tests
DOMAIN=<your-domain> SCRIPT_PREFIX=<prefix> npx jest accounts/<your-domain>/scripts/<prefix>/test/<name>.test.js
```

## Performance Optimization

### Batch Processing

```javascript
afterUpdate: async (doc, beforeUpdateDoc, payload, { API, logger }) => {
  // Add to batch queue instead of immediate sync
  await API.prolibu.create('SyncQueue', {
    type: 'contact-update',
    contactId: doc._id,
    payload: payload,
    status: 'pending'
  });
  
  // Separate scheduled task processes queue in batches
}
```

### Conditional Execution

```javascript
afterUpdate: async (doc, beforeUpdateDoc, payload, { API, logger }) => {
  // Only sync during business hours (the server clock is UTC: use Intl with a timeZone)
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Bogota'
  }).format(new Date()));
  if (hour < 8 || hour > 18) {
    logger.debug('Outside business hours, queueing for later');
    await queueForLater(doc, payload);
    return;
  }
  
  // Immediate sync
  await syncToSalesforce(doc, payload);
}
```

### Don't Fire and Forget

A run ends when the script's last statement settles, and the worker is then stopped: work you do not `await` is cut off with no error. The hook also runs inside the user's request, so its time adds to the save. Keep the hook short and `await` everything; push slow work to a queue (above) processed by a scheduled script.

```javascript
afterCreate: async (doc, { API, logger }) => {
  // ❌ BAD: not awaited — cut off when the run ends
  // syncToSalesforce(doc, API, logger).catch(...);

  // ✅ GOOD
  try {
    await syncToSalesforce(doc, API, logger);
  } catch (error) {
    logger.error('Sync failed', error);
  }
}
```

## Related Documentation

- **[Event System Overview](./README.md)** - Understanding the event system
- **[ApiRun Events](./01-api-run.md)** - Manual script execution
- **[ScheduledTask Events](./02-scheduled-task.md)** - Automated periodic tasks
- **[OutboundIntegration](../../lib/vendors/prolibu/OutboundIntegration.js)** - Config-driven outbound sync library

---

**Back to:** [Events Overview](./README.md) | [Main Documentation](../README.md)
