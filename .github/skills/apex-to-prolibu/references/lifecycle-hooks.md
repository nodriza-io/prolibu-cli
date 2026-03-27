# Lifecycle Hooks Reference

## The 6 Lifecycle Events

| Hook             | Trigger                | Can Abort?     | eventData Fields                    |
| ---------------- | ---------------------- | -------------- | ----------------------------------- |
| **beforeCreate** | Before entity creation | ✅ Yes (throw) | `doc`                               |
| **afterCreate**  | After entity creation  | ❌ No          | `doc`                               |
| **beforeUpdate** | Before entity update   | ✅ Yes (throw) | `doc`, `beforeUpdateDoc`, `payload` |
| **afterUpdate**  | After entity update    | ❌ No          | `doc`, `beforeUpdateDoc`, `payload` |
| **beforeDelete** | Before entity deletion | ✅ Yes (throw) | `doc`                               |
| **afterDelete**  | After entity deletion  | ❌ No          | `doc`                               |

## eventData Structure

### beforeCreate / afterCreate / beforeDelete / afterDelete

```javascript
eventData = {
  doc: Object, // The entity document
  hookType: String, // "beforeCreate", "afterCreate", etc.
  objectName: String, // Entity name (e.g., "Contact")
};
```

### beforeUpdate / afterUpdate

```javascript
eventData = {
  doc: Object, // Current state (after update)
  beforeUpdateDoc: Object, // Previous state (before update)
  payload: Object, // Only the fields that changed
  hookType: String,
  objectName: String,
};
```

## Handler Signatures

### beforeCreate

```javascript
Events.on("Contact.beforeCreate", async () => {
  const { doc } = eventData;

  // Validation — throw to abort
  if (!doc.email) {
    throw new Error("Email is required");
  }

  // Enrichment — mutate doc before save
  doc.source = "prolibu";
  doc.createdAt = new Date();
});
```

### afterCreate

```javascript
Events.on("Contact.afterCreate", async () => {
  const { doc } = eventData;

  // Sync to external system
  try {
    const sfResult = await salesforceApi.create(
      "Contact",
      mapToSalesforce(doc),
    );
    await prolibuApi.update("Contact", doc._id, { salesforceId: sfResult.id });
  } catch (error) {
    console.error("SF sync failed:", error.message);
    // Don't throw — record is already created
  }
});
```

### beforeUpdate

```javascript
Events.on("Contact.beforeUpdate", async () => {
  const { doc, beforeUpdateDoc, payload } = eventData;

  // Validate specific field changes
  if (payload.email) {
    const existing = await prolibuApi.find("Contact", {
      xquery: JSON.stringify({ email: payload.email, _id: { $ne: doc._id } }),
      limit: 1,
    });
    if (existing.data?.length > 0) {
      throw new Error("Email already in use");
    }
  }

  // Track state changes
  if (payload.status && payload.status !== beforeUpdateDoc.status) {
    doc.statusChangedAt = new Date();
  }
});
```

### afterUpdate

```javascript
Events.on("Contact.afterUpdate", async () => {
  const { doc, beforeUpdateDoc, payload } = eventData;

  // Only sync if specific fields changed
  const syncFields = ["name", "email", "mobile"];
  const shouldSync = Object.keys(payload).some((key) =>
    syncFields.includes(key),
  );

  if (!shouldSync || !doc.salesforceId) return;

  try {
    await salesforceApi.update(
      "Contact",
      doc.salesforceId,
      mapToSalesforce(payload),
    );
  } catch (error) {
    console.error("SF update sync failed:", error.message);
  }
});
```

### beforeDelete

```javascript
Events.on("Contact.beforeDelete", async () => {
  const { doc } = eventData;

  // Check for dependencies
  const orders = await prolibuApi.find("Order", {
    xquery: JSON.stringify({ contactId: doc._id, status: "active" }),
    limit: 1,
  });

  if (orders.data?.length > 0) {
    throw new Error("Cannot delete contact with active orders");
  }
});
```

### afterDelete

```javascript
Events.on("Contact.afterDelete", async () => {
  const { doc } = eventData;

  // Cascade delete in external system
  if (doc.salesforceId) {
    try {
      await salesforceApi.delete("Contact", doc.salesforceId);
    } catch (error) {
      console.error("SF delete sync failed:", error.message);
    }
  }
});
```

## Salesforce Trigger Mapping

| Salesforce Apex Trigger                | Prolibu Event Name    |
| -------------------------------------- | --------------------- |
| `trigger.isBefore && trigger.isInsert` | `Entity.beforeCreate` |
| `trigger.isAfter && trigger.isInsert`  | `Entity.afterCreate`  |
| `trigger.isBefore && trigger.isUpdate` | `Entity.beforeUpdate` |
| `trigger.isAfter && trigger.isUpdate`  | `Entity.afterUpdate`  |
| `trigger.isBefore && trigger.isDelete` | `Entity.beforeDelete` |
| `trigger.isAfter && trigger.isDelete`  | `Entity.afterDelete`  |

## Apex Trigger Context Variables

| Apex                     | Prolibu (via eventData)  |
| ------------------------ | ------------------------ |
| `Trigger.new[0]`         | `doc`                    |
| `Trigger.old[0]`         | `beforeUpdateDoc`        |
| `Trigger.newMap`         | Use `prolibuApi.find()`  |
| `Trigger.oldMap`         | `beforeUpdateDoc`        |
| `record.addError('msg')` | `throw new Error('msg')` |

> ⚠️ **BULK NOTE:** Apex triggers receive lists of records (`Trigger.new`). Prolibu fires **one lifecycle event per record**. Bulk logic (loops over Trigger.new) translates to single-record logic in each handler.

## config.json Requirement

For lifecycle hooks to fire, the entity MUST be listed in `config.json`:

```json
{
  "lifecycleHooks": ["Contact", "Deal", "Order"]
}
```

If `Contact` is not in this array, `Events.on('Contact.afterCreate', ...)` will be **silently ignored**.
