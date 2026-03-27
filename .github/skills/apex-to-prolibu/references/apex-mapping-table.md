# Apex to Prolibu Mapping Tables

## Trigger Events

| Salesforce Apex Trigger | Prolibu Event         | Can Abort?     |
| ----------------------- | --------------------- | -------------- |
| `before insert`         | `Entity.beforeCreate` | ✅ Yes (throw) |
| `after insert`          | `Entity.afterCreate`  | ❌ No          |
| `before update`         | `Entity.beforeUpdate` | ✅ Yes (throw) |
| `after update`          | `Entity.afterUpdate`  | ❌ No          |
| `before delete`         | `Entity.beforeDelete` | ✅ Yes (throw) |
| `after delete`          | `Entity.afterDelete`  | ❌ No          |

## Trigger Context Variables

| Apex                     | Prolibu                                       |
| ------------------------ | --------------------------------------------- |
| `Trigger.new[0]`         | `eventData.doc`                               |
| `Trigger.old[0]`         | `eventData.beforeUpdateDoc`                   |
| `Trigger.new` (list)     | Single `doc` — one event per record           |
| `Trigger.newMap`         | Use `prolibuApi.find()`                       |
| `Trigger.oldMap`         | `eventData.beforeUpdateDoc`                   |
| `record.addError('msg')` | `throw new Error('msg')`                      |
| `Trigger.isInsert`       | Check `eventData.hookType === 'beforeCreate'` |
| `Trigger.isUpdate`       | Check `eventData.hookType === 'beforeUpdate'` |
| `Trigger.isBefore`       | Check `hookType.startsWith('before')`         |

## DML → API Methods

| Apex DML                          | Prolibu API                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `insert record;`                  | `prolibuApi.create('Entity', data)`                                                  |
| `update record;`                  | `prolibuApi.update('Entity', id, data)`                                              |
| `delete record;`                  | `prolibuApi.delete('Entity', id)`                                                    |
| `upsert record External_Id__c;`   | `prolibuApi.findOneOrCreate('Entity', externalValue, { field: 'externalId' }, data)` |
| `Database.insert(records, false)` | Loop with try/catch per record                                                       |

## SOQL → xquery

| SOQL                            | Prolibu xquery                          |
| ------------------------------- | --------------------------------------- |
| `WHERE field = 'value'`         | `{ field: 'value' }`                    |
| `WHERE field != 'value'`        | `{ field: { $ne: 'value' } }`           |
| `WHERE field IN ('a', 'b')`     | `{ field: { $in: ['a', 'b'] } }`        |
| `WHERE field NOT IN ('a', 'b')` | `{ field: { $nin: ['a', 'b'] } }`       |
| `WHERE field > 100`             | `{ field: { $gt: 100 } }`               |
| `WHERE field >= 100`            | `{ field: { $gte: 100 } }`              |
| `WHERE field < 100`             | `{ field: { $lt: 100 } }`               |
| `WHERE field LIKE '%value%'`    | `{ field: { $regex: 'value' } }`        |
| `WHERE field = null`            | `{ field: null }`                       |
| `WHERE field != null`           | `{ field: { $ne: null } }`              |
| `WHERE A AND B`                 | `{ A, B }` (same object)                |
| `WHERE A OR B`                  | `{ $or: [{ A }, { B }] }`               |
| `SELECT Id, Name`               | `select: '_id name'`                    |
| `LIMIT 100`                     | `limit: 100`                            |
| `OFFSET 50`                     | `page: 2` (with limit 50)               |
| `ORDER BY Name ASC`             | `sort: 'name'` or `sort: { name: 1 }`   |
| `ORDER BY Name DESC`            | `sort: '-name'` or `sort: { name: -1 }` |

### SOQL Examples

```apex
// Apex
[SELECT Id, Name, Email FROM Contact WHERE Status__c = 'active' AND Email != null LIMIT 50]
```

```javascript
// Prolibu
await prolibuApi.find("Contact", {
  xquery: JSON.stringify({ status: "active", email: { $ne: null } }),
  select: "_id name email",
  limit: 50,
});
```

```apex
// Apex
[SELECT Id FROM Account WHERE Industry IN ('Tech', 'Finance') AND AnnualRevenue > 1000000]
```

```javascript
// Prolibu
await prolibuApi.find("Company", {
  xquery: JSON.stringify({
    industry: { $in: ["Tech", "Finance"] },
    annualRevenue: { $gt: 1000000 },
  }),
  select: "_id",
});
```

## Async Patterns

| Apex Pattern     | Prolibu Equivalent                                |
| ---------------- | ------------------------------------------------- |
| `@future` method | Use `afterCreate` / `afterUpdate` (already async) |
| `Queueable`      | Use `afterCreate` / `afterUpdate`                 |
| `Schedulable`    | `ScheduledTask` event with cron config            |
| `Batch Apex`     | `ScheduledTask` + pagination loop                 |
| `Platform Event` | `EndpointRequest` (webhook mode)                  |

## HTTP Callout

```apex
// Apex
HttpRequest req = new HttpRequest();
req.setEndpoint('callout:MyNamedCredential/api/data');
req.setMethod('POST');
req.setHeader('Content-Type', 'application/json');
req.setBody(JSON.serialize(payload));
HttpResponse res = new Http().send(req);
Integer statusCode = res.getStatusCode();
String body = res.getBody();
```

```javascript
// Prolibu
const response = await axios.post("https://api.example.com/data", payload, {
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${vars.externalToken}`,
  },
});
const statusCode = response.status;
const body = response.data;
```

## Named Credentials → Variables

| Apex (Named Credential) | Prolibu (Script Variable)               |
| ----------------------- | --------------------------------------- |
| `callout:MyCredential`  | Store URL in `vars.myCredentialUrl`     |
| Auth header (automatic) | Store token in `vars.myCredentialToken` |

## Field Name Conventions

| Salesforce (PascalCase) | Prolibu (camelCase)                        |
| ----------------------- | ------------------------------------------ |
| `FirstName`             | `firstName`                                |
| `LastName`              | `lastName`                                 |
| `Email`                 | `email`                                    |
| `MobilePhone`           | `mobile`                                   |
| `Phone`                 | `phone`                                    |
| `AccountId`             | `companyId`                                |
| `OwnerId`               | `owner`                                    |
| `Id`                    | `_id` (or `salesforceId` for external ref) |
| `CreatedDate`           | `createdAt`                                |
| `LastModifiedDate`      | `updatedAt`                                |
| `Custom_Field__c`       | `customField`                              |
| `RecordTypeId`          | `type` or `recordType`                     |

## Class Pattern Mapping

| Apex Pattern            | Prolibu Equivalent                            |
| ----------------------- | --------------------------------------------- |
| Trigger + Handler class | Single `index.js` with `Events.on()` handlers |
| Service class           | Helper functions in `lib/` folder             |
| Selector class          | `prolibuApi.find()` calls                     |
| Domain class            | Validation in `beforeCreate` / `beforeUpdate` |
| Unit of Work            | Direct API calls (no UoW pattern needed)      |
| Test class              | `templates/test/index.test.js`                |

## Error Handling

| Apex                              | Prolibu                                  |
| --------------------------------- | ---------------------------------------- |
| `record.addError('msg')`          | `throw new Error('msg')` in before hooks |
| `try { } catch (Exception e) { }` | `try { } catch (error) { }`              |
| `System.debug(e)`                 | `console.error(error.message)`           |
| `Database.SaveResult`             | Check API response / catch errors        |
