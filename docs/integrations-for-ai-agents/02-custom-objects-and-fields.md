# Custom Objects & Custom Fields

> Salesforce analogy: **Custom Objects (`MyObject__c`) + Custom Fields**. Model your own business data through the configuration API: define a Custom Object to get a full REST-CRUD resource of its own, or attach Custom Fields to an existing object — standard or custom.

## When to use this

Use this when you need to **model new business data** in a Prolibu account without hand-writing any code. If you need a brand-new entity with its own collection and its own REST endpoints, create a **Custom Object**. If you only need to hang a few extra attributes off an object that already exists (for example, a `color` field on `Contact`, or a `tipoEvento` field on `Deal`), create **Custom Fields** on that object. Both are defined declaratively as configuration — you describe the shape of your data, and the platform provisions the schema, validation and API surface for you.

## Prolibu ↔ Salesforce

| Prolibu | Salesforce | Notes |
|---|---|---|
| Custom Object (`POST /v2/cob`) | Custom Object `MyObject__c` | Its own collection + auto-generated REST resource at `/v2/<name>` |
| `modelName` (PascalCase singular) | Object API Name | Normalized on save (see [Naming rules](#naming-rules-for-custom-objects)) |
| A field descriptor `{ "type": "string", "required": true, ... }` | Custom Field on the object | Declarative field definition; `type` is a string |
| `{ "type": "objectid", "ref": "User" }` | Lookup relationship | Populatable reference to another object |
| Custom Fields under `customFields.*` | Custom Fields on a standard object | Namespaced, so they never collide with built-in fields (≈ the `__c` suffix) |
| `overrides.*` on a Custom Field record | (no exact SF equivalent) | Adjust a built-in field (e.g. make it required) or add a field at the object root |
| Schema activation (config change → apply) | Schema Builder / Metadata deploy | New schema is not live until the change is applied |

---

## 1. Two building blocks

There are two distinct configuration resources. Pick based on whether you need a whole new object or just extra fields on one that exists.

| Resource | Endpoint | What it does | Salesforce analog |
|---|---|---|---|
| **Custom Object** | `/v2/cob` | Provisions a **whole new object** — its own collection, a full REST-CRUD resource at `/v2/<name>`, validation and permissions | Custom Object `__c` |
| **Custom Field** | `/v2/customfield` | **Adds fields to an existing object** (standard or custom), either nested under `customFields.*` or at the object root via `overrides` | Custom Fields on standard objects |

Both are defined as configuration data. A field's `type` is written as a **string** (for example `"string"`, `"number"`, `"objectid"`). When you create or update either resource, the configuration is validated immediately, and the new/updated schema is provisioned as part of applying the change.

> **Activation is not instantaneous.** Creating or updating a Custom Object or Custom Field validates and persists your configuration, then schedules the schema to be applied. The new object's endpoints (or the new fields on an existing object) become usable **once the change has been applied** — not on the same millisecond the `POST` returns. Do not immediately `POST` records to a brand-new object; poll for readiness first (see [Common pitfalls](#7-common-pitfalls)).

### Field types available to integrators

A field's `type` must be one of the supported schema types below. Anything outside this set is rejected at validation time with an error identifying the bad `type`.

| `type` | Meaning | Array form |
|---|---|---|
| `string` | Text | `[string]` |
| `number` | Numeric | `[number]` |
| `boolean` | True/false | `[boolean]` |
| `date` | ISO 8601 date/time | `[date]` |
| `objectid` | Reference to another object (use with `ref`) | `[objectid]` |
| `mixed` | Arbitrary JSON (no validation) | `[mixed]` |
| `decimal128` | High-precision decimal | — |
| `buffer` | Binary | — |
| `map` | Key/value map | — |
| `array` | Generic array | — |

---

## 2. Custom Objects

A **Custom Object** gives you a new top-level resource. You describe its fields in the create payload; every key that is not one of the reserved metadata keys (`modelName`, `active`, `unset`, and the system-managed audit keys) is interpreted as a **field definition** for the new object.

### The create payload

`POST /v2/cob`

| Key | Type | Required | Description |
|---|---|---|---|
| `modelName` | string | yes | The object's API name. Normalized to PascalCase singular on save (see below). Must be unique and not collide with an existing object or a reserved name. |
| `active` | boolean | no (default `true`) | Only active objects are provisioned. |
| `<fieldName>` | field descriptor | no | One entry per field you want on the object. See [Field descriptors](#field-descriptors). |

#### Naming rules for custom objects

`modelName` is normalized when the record is saved: each word is singularized and capitalized, then joined in PascalCase. Design your integration around the **normalized** value, and always read it back from the response before building URLs.

| You send | Stored `modelName` | REST resource |
|---|---|---|
| `"pets"` | `"Pet"` | `/v2/pet` |
| `"My Models"` | `"MyModel"` | `/v2/mymodel` |
| `"mis motos"` | `"MiMoto"` | `/v2/mimoto` |

The REST path is always the lowercased `modelName`: `Car` → `/v2/car`.

> Some object names are **reserved** by the platform and cannot be used as a `modelName`. If you pick a reserved name, or a name already taken by an existing object, the create call fails with `400`. Read the error message and choose another name — there is no need to know the full reserved list in advance.

### Field descriptors

Each field is an object keyed by the field name, with a string `type` plus optional constraints. These are the constraints exposed to integrators:

| Property | Applies to | Effect |
|---|---|---|
| `type` | all | One of the [supported types](#field-types-available-to-integrators). Required. |
| `required` | all | Rejects writes that omit the field. |
| `unique` | scalars | Enforces uniqueness. Combine with a sparse-friendly design — see the pitfall on `unique`. |
| `enum` | string/number | Restricts the value to a fixed list. |
| `min` / `max` | number | Numeric bounds. |
| `minLength` / `maxLength` | string | Length bounds. |
| `match` | string | Regex the value must match (as a string, e.g. `"/^[A-Za-z]{3}[0-9]{3}$/"`). |
| `ref` | objectid | Target object for a relationship (e.g. `"User"`). Enables `populate`. |
| `default` | all | Default value when omitted. |
| `displayName` | one field | Marks the human-readable label field. |
| `primaryKey` | one field | Lets records be addressed by this field's value in `/v2/<name>/<value>` in addition to `_id`. |
| `example` | all | Example value (documentation/tooling). |

**Relationships.** A relationship is just an `objectid` field with a `ref`:

```json
"assignee": { "type": "objectid", "ref": "User" }
```

It populates like any built-in reference: `?populate=assignee`, `?populate=*`, or a JSON `populatePath`.

**Validation errors** map to the standard error response shape (see [REST API](03-rest-api.md)). For example, omitting a `required` field, breaking a `min`/`max`, `enum`, `minLength`/`maxLength`, `match`, or violating `unique` each returns a `400` (or `409` for duplicates) with a descriptive message and the offending field.

**Undeclared fields are dropped silently.** The generated object only stores fields you declared. Sending an attribute you never defined does not error — the value is simply discarded. **Declare every field you intend to persist.**

### The generated REST resource

Once applied, a Custom Object named `Car` exposes a full CRUD resource at `/v2/car`:

| Method + Path | Purpose |
|---|---|
| `POST /v2/car` | Create a record |
| `GET /v2/car` | List records (supports `select`, `populate`, `where`/`query`, `sort`, `limit`, `page`) |
| `GET /v2/car/search?term=...` | Full-text search across text-indexed fields |
| `GET /v2/car/{idOrKey}` | Read one — by `_id` **or** by the field marked `primaryKey`/`displayName` |
| `PATCH /v2/car/{idOrKey}` | Update |
| `DELETE /v2/car/{idOrKey}` | Delete |

Records automatically carry audit fields (`createdAt`, `updatedAt`, `createdBy`, `updatedBy`). Listing is paginated; see [REST API](03-rest-api.md) for default and maximum page sizes.

---

## 3. Worked example A — create a Custom Object and CRUD it over REST

### Step 1 — create the object

```bash
curl -X POST https://<domain>/v2/cob \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "modelName": "Car",
    "brand":  { "type": "string", "required": true, "displayName": true, "example": "Jeep" },
    "year":   { "type": "number", "min": 1930, "max": 2024, "example": 2000 },
    "plates": { "type": "string", "required": true, "primaryKey": true, "unique": true,
                "minLength": 6, "maxLength": 6, "match": "/^[A-Za-z]{3}[0-9]{3}$/" },
    "model":  { "type": "string", "required": true, "enum": ["Compass","Wrangler","Cherokee"] },
    "assignee": { "type": "objectid", "ref": "User" },
    "active": true
  }'
```

Response `201` — the persisted configuration (note `modelName` came back normalized to `"Car"`):

```json
{
  "_id": "66a1...",
  "modelName": "Car",
  "brand":  { "type": "string", "required": true, "displayName": true, "example": "Jeep" },
  "year":   { "type": "number", "min": 1930, "max": 2024, "example": 2000 },
  "plates": { "type": "string", "required": true, "primaryKey": true, "unique": true, "minLength": 6, "maxLength": 6, "match": "/^[A-Za-z]{3}[0-9]{3}$/" },
  "model":  { "type": "string", "required": true, "enum": ["Compass","Wrangler","Cherokee"] },
  "assignee": { "type": "objectid", "ref": "User" },
  "active": true,
  "createdAt": "2026-07-01T12:00:00.000Z",
  "updatedAt": "2026-07-01T12:00:00.000Z"
}
```

### Step 2 — wait until the resource is live

The object's schema is applied asynchronously. Until it is, `GET/POST /v2/car` returns `404`. Poll a lightweight list call until it stops returning `404`:

```bash
until curl -sf -o /dev/null "https://<domain>/v2/car?limit=1" -H "Authorization: Bearer $TOKEN"; do
  sleep 2
done
```

### Step 3 — CRUD records

```bash
# Create
curl -X POST https://<domain>/v2/car \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "brand": "Jeep", "model": "Compass", "year": 2018, "plates": "CYM783" }'
# -> 201, body includes _id, createdAt, updatedAt, createdBy, updatedBy

# Search
curl "https://<domain>/v2/car/search?term=Jeep" -H "Authorization: Bearer $TOKEN"
# -> 200 { "pagination": {...}, "data": [ { "_id": "...", "brand": "Jeep", ... } ] }

# Read by primaryKey (plates) — not only by _id
curl "https://<domain>/v2/car/CYM783" -H "Authorization: Bearer $TOKEN"
# -> 200 { "_id": "...", "plates": "CYM783", "brand": "Jeep", ... }

# Read with a relationship populated
curl "https://<domain>/v2/car/CYM783?populate=assignee" -H "Authorization: Bearer $TOKEN"

# List with projection + pagination
curl "https://<domain>/v2/car?select=_id,brand&page=2&limit=10" -H "Authorization: Bearer $TOKEN"

# Update
curl -X PATCH "https://<domain>/v2/car/CYM783" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "year": 2019 }'

# Delete
curl -X DELETE "https://<domain>/v2/car/CYM783" -H "Authorization: Bearer $TOKEN"
```

> Sending an undeclared field (e.g. `"age": 100` on `Car`) does **not** error — the value is discarded. To store it, add `age` to the object definition first and wait for it to apply.

---

## 4. Custom Fields — extending an existing object

A **Custom Field** record attaches new fields to an object that already exists (standard or custom). There is **one Custom Field record per object** (`objectAssigned` is unique) — to add more fields later, update that same record rather than creating a second one.

### The create payload

`POST /v2/customfield`

| Key | Type | Required | Description |
|---|---|---|---|
| `objectAssigned` | string | yes | The API name of the object to extend. Must be an existing object. Unique across Custom Field records. |
| `customFields` | object | one of these two | Fields added **nested** under `customFields.*` on the target object. |
| `overrides` | object | one of these two | Adjust a built-in field, or add a new field at the object **root**. |
| `active` | boolean | no (default `true`) | Whether the record is applied. |

At least one of `customFields` or `overrides` must be present.

### Field shape

Every field entry must carry the flag `"isCustomField": true` in addition to its descriptor:

```json
"color": { "isCustomField": true, "type": "string", "description": "Favorite color", "example": "blue" },
"size":  { "isCustomField": true, "type": "string", "enum": ["small","medium","large"] }
```

Rules:

- **`customFields`** — every entry requires `type`. Field names must be valid identifiers (letters, digits, `_`, `$`; not starting with a digit) and cannot be a JavaScript reserved word. Entries without `isCustomField: true` are ignored; if none carry the flag, the call errors.
- **`overrides`** on an **existing** built-in field — you do **not** need to send `type` (the original field's type is kept, and any `type` you send is ignored). Use this to adjust properties such as making a field `required`.
- **`overrides`** that introduce a **new** root-level field — `type` is required.
- **`unique` implies sparse.** Any custom field marked `unique` is made sparse automatically, so records that leave it empty don't collide on `null`.

### customFields vs overrides — where the data lives

- **`customFields`** live **nested** on the record: e.g. `contact.customFields.color`. Write them as a nested object.
- **`overrides`** live at the object **root**: e.g. `deal.tipoEvento` is set/read directly at the top level of the record.

---

## 5. Worked example B — add Custom Fields to `Contact`

### Step 1 — create the Custom Field record

```bash
curl -X POST https://<domain>/v2/customfield \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "objectAssigned": "Contact",
    "customFields": {
      "color": { "isCustomField": true, "type": "string", "description": "Favorite color" },
      "size":  { "isCustomField": true, "type": "string", "enum": ["small","medium","large"] }
    },
    "overrides": {
      "lastName":   { "isCustomField": true, "required": true },
      "tipoEvento": { "isCustomField": true, "type": "string",
                      "enum": ["Evento","Alojamiento","Evento y Alojamiento"] }
    }
  }'
```

Response `201` — `overrides.lastName` kept its original `type`; `color`/`size` live under `customFields`:

```json
{
  "_id": "66b3...",
  "objectAssigned": "Contact",
  "customFields": {
    "color": { "isCustomField": true, "type": "string", "description": "Favorite color" },
    "size":  { "isCustomField": true, "type": "string", "enum": ["small","medium","large"] }
  },
  "overrides": {
    "lastName":   { "isCustomField": true, "required": true, "type": "string" },
    "tipoEvento": { "isCustomField": true, "type": "string", "enum": ["Evento","Alojamiento","Evento y Alojamiento"] }
  },
  "active": true,
  "createdAt": "2026-07-01T12:00:00.000Z",
  "updatedAt": "2026-07-01T12:00:00.000Z"
}
```

### Step 2 — after the change is applied, write the new fields

```bash
# customFields go nested; overrides go at the root
curl -X POST https://<domain>/v2/contact \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "firstName": "Ada",
    "lastName": "Lovelace",
    "tipoEvento": "Evento",
    "customFields": { "color": "blue", "size": "small" }
  }'
```

Reading back:

```json
{
  "_id": "66c9...",
  "firstName": "Ada",
  "lastName": "Lovelace",
  "tipoEvento": "Evento",
  "customFields": { "color": "blue", "size": "small" },
  "createdAt": "2026-07-01T12:05:00.000Z"
}
```

### Step 3 — add more fields later (update the same record)

`objectAssigned` is unique, so don't create a second record. Find the existing one and `PATCH` it:

```bash
# Find the record for this object
curl "https://<domain>/v2/customfield?objectAssigned=Contact" -H "Authorization: Bearer $TOKEN"

# Then PATCH by its _id, sending the full customFields set (existing + new)
curl -X PATCH "https://<domain>/v2/customfield/<_id>" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "customFields": {
      "color":    { "isCustomField": true, "type": "string" },
      "size":     { "isCustomField": true, "type": "string", "enum": ["small","medium","large"] },
      "nickname": { "isCustomField": true, "type": "string" }
    }
  }'
```

---

## 6. Worked example C — create a Custom Object with JavaScript `fetch`

```js
const base = 'https://<domain>';
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

// 1. Define the object
const created = await fetch(`${base}/v2/cob`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    modelName: 'Pet',
    petName: { type: 'string', required: true, unique: true, displayName: true },
    color:   { type: 'string', example: 'Blue' },
    breed:   { type: 'string', enum: ['Bull Terrier', 'Bulldog'] },
    active: true,
  }),
}).then((r) => r.json());

console.log(created.modelName); // "Pet"  (normalized)

// 2. Wait until /v2/pet is live
async function waitLive(path) {
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${base}/${path}?limit=1`, { headers });
    if (res.status !== 404) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Timed out waiting for resource to activate');
}
await waitLive('v2/pet');

// 3. Create a record
const pet = await fetch(`${base}/v2/pet`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ petName: 'Shox', color: 'white', breed: 'Bull Terrier' }),
}).then((r) => r.json());

console.log(pet._id, pet.petName); // "…"  "Shox"
```

A missing `required` field returns `400` with a descriptive message identifying the field (`petName`), following the standard [error response shape](03-rest-api.md).

---

## 7. Common pitfalls

1. **The schema is not live the instant you create it.** Creating a Custom Object (or Custom Field) validates and persists your config and schedules the schema to be applied. The new endpoints/fields become usable only after that completes. Poll for readiness (e.g. an `until` loop on a `limit=1` list call) instead of firing writes immediately — otherwise you get `404` (new object) or your new fields silently drop (new fields).
2. **Undeclared fields are dropped silently.** Both generated objects and Custom Fields store only what you declared. There is no error for an unknown attribute — the value just vanishes. Declare every field you intend to persist.
3. **`modelName` is normalized.** It is singularized and PascalCased on save (`"pets"` → `"Pet"`). Read it back from the response and derive the REST path from the lowercased value (`Pet` → `/v2/pet`).
4. **Name collisions return `400`.** A `modelName` cannot be a reserved name or duplicate an existing object. Handle the `400` and pick another name.
5. **`isCustomField: true` is mandatory on every custom field** you send via the API. Entries without it are ignored; if none carry it, the request errors.
6. **`overrides` on an existing field ignores the `type` you send** and keeps the original field's type. Only brand-new root fields in `overrides` require (and honor) `type`.
7. **`unique` custom fields become sparse automatically**, so empty values don't collide.
8. **One Custom Field record per object.** `objectAssigned` is unique — to add fields later, `PATCH` the existing record (send the complete field set), don't `POST` a new one.
9. **A newly created Custom Object may not be assignable Custom Fields until it is fully applied.** `objectAssigned` must reference an object the platform already knows about; wait for the new object to be live before attaching Custom Fields to it.
10. **The record path accepts a key, not just `_id`.** `GET /v2/car/CYM783` resolves by the field marked `primaryKey`/`displayName`. Mark that field intentionally.

---

## 8. Checklist

**Create a Custom Object**

- [ ] Pick a `modelName` that isn't reserved or already in use.
- [ ] Expect it to be normalized to PascalCase singular — read the response to confirm.
- [ ] Define each field as `{ "type": "<supportedType>", ... }`.
- [ ] For relationships, use `{ "type": "objectid", "ref": "<ObjectName>" }`.
- [ ] Mark one field `primaryKey: true` / `displayName: true` if you want to address records by its value.
- [ ] `POST /v2/cob`; confirm `201`.
- [ ] Poll `/v2/<name>?limit=1` until it's live before writing records.
- [ ] Declare every field you'll persist — undeclared fields are dropped.

**Add Custom Fields to an existing object**

- [ ] Confirm the target object exists (use its API name for `objectAssigned`).
- [ ] Check for an existing Custom Field record (`?objectAssigned=<Object>`); if present, `PATCH` it instead of `POST`.
- [ ] Put `isCustomField: true` on every field.
- [ ] Under `customFields`: `type` required; use valid identifier keys.
- [ ] Under `overrides`: existing fields don't need `type` (inherited); new root fields do.
- [ ] Remember `unique` implies sparse.
- [ ] `POST`/`PATCH /v2/customfield`; confirm the response.
- [ ] Wait until applied, then write `customFields` nested and `overrides` at the root.

---

**See also:** [Platform & Data Model](01-platform-and-data-model.md) · [REST API](03-rest-api.md) · [Automation & Scripts](05-automation-and-scripts.md) · [Security & Permissions](10-security-and-permissions.md)
