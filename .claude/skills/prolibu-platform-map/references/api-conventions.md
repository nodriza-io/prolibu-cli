# Prolibu API conventions

Rules that hold for every object of the `/v2/` API, verified against the server code and a
live account. Skills rely on them; read this file when you call an object that has no
dedicated skill, or when a call behaves oddly.

Call the API only through `../../_shared/prolibu-api.js` (or a skill's own script). The
examples below show the path and query; the helper adds the host and the key.

## Authentication

- Every call carries `Authorization: Bearer <apiKey>`. The helper adds it from
  `accounts/<domain>/profile.json`; never put the key in a URL or on a command line.
- The key acts as its user: same roles, same workspaces, same record permissions. A `403`
  means that user may not do this. Do not retry another way.

## The calls every object has

| Call | Does | Answers |
| --- | --- | --- |
| `GET /v2/<object>` | List, with filters and paging | `200 {timeMs, pagination, data}` |
| `GET /v2/<object>/search?term=<text>` | Text search, like the app's search box | `200 {data, …}` |
| `GET /v2/<object>/<id>` | One record | `200 <record>` |
| `POST /v2/<object>` | Create | `201 <record>` |
| `PATCH /v2/<object>/<id>` | Update | `200 <record>` |
| `DELETE /v2/<object>/<id>` | Delete | `204`, empty body |

- `<object>` is the object name in lowercase: `contact`, `pricebookentry`, a custom object's
  name. The list of objects is in `modules.md`.
- `<id>` is the `_id`, or the object's primary key when it has one: a contact can be read as
  `GET /v2/contact/<email>`. Some objects take no create or update (logs, history); the
  object's OpenAPI entry shows which calls it has.
- A read by id already fills in some references (for example a contact's `company`). A list
  does not, unless you ask with `populate`.

## Lists: paging and response

- Response: `{timeMs, pagination, data}`. Non-production servers also return `query`, the
  final filter they ran. That is the quickest way to see what the server did with your
  filter; production servers leave it out.
- `pagination` is `{count, page, limit, lastPage, startIndex}`. `count` is the total that
  matches, not the page size.
- `limit` defaults to 20. Anything above 500 is cut to 500 without an error. `limit=0` or a
  page below 1 answers `400 Invalid pagination parameters`. A page past the end is an empty
  `data`.
- There is no default order. When you page, always `sort`.

## `select`, `sort`

- `select` lists fields separated by **spaces**: `select=firstName lastName email`. A leading
  `-` excludes: `select=-notes -tasks`. Do not mix the two forms (`400`). Without `select`,
  every field comes back except secrets.
- `sort` lists fields separated by **commas**; `-` means descending:
  `sort=-updatedAt,firstName`. A space-separated sort, or a field that does not exist,
  answers `400 Sort field does not exist`.

## Filters

There are two ways to filter a list. Both are combined with your permissions by the server.

1. **Query parameters** for plain equality: `GET /v2/contact?email=ana@acme.com`. The value
   is always text, so a field that stores a number or a `true` is not matched this way.
2. **`xquery`**, a JSON filter in Mongo style, URL-encoded:
   `xquery={"stage":"<id>","amount":{"$gte":1000}}`. Build it with `JSON.stringify` and
   encode it (`URLSearchParams`).

The server rewrites `xquery` before running it. Four consequences, all silent except one:

- **One operator per field.** `{"createdAt":{"$gte":A,"$lte":B}}` keeps only the last
  operator, `$lte`, and returns more records than you asked for. Put several conditions on one
  field inside `$and`: `{"$and":[{"createdAt":{"$gte":A}},{"createdAt":{"$lte":B}}]}`.
  Conditions inside `$and` and `$or` arrays are kept as sent.
- **Case-insensitive text goes inline:** `{"lastName":{"$regex":"(?i)ruiz"}}`. A separate
  `"$options":"i"` is cut off from its `$regex` and the call answers
  `400 $options needs a $regex`. Escape regex characters in user text.
- **Unknown fields are dropped.** A misspelled field, in `xquery` or as a query parameter,
  is removed and the call returns every record. Check `pagination.count` (and `query` when the
  server returns it) against what you expected.
- **Malformed JSON is dropped too.** An `xquery` that is not valid JSON returns every record
  with `200`.

`searchTerm` is not an API parameter: on a list it is dropped like any unknown field. For
text search use `GET /v2/<object>/search?term=<text>&limit=<n>`. It looks in the object's
indexed text fields and in related records (a contact's company), defaults to 10 results,
and accepts `xquery`, `select` and `page`. When nothing matches it answers without
`pagination`.

## `populate`: fill in references

A reference is stored as an `_id` string. To get the referenced record instead:

- `populate=*` fills in every reference of the record, **one level deep**. A reference inside
  the referenced record (a deal's contact's company) stays an id.
- `populate=contact company` fills in the named fields, separated by spaces. A field that is
  not in the object's schema makes the **whole call fail**:
  `400 Cannot populate '<field>' because it is not in the schema`.
- A dotted name in `populate` (`contact.company`) fills in nothing at all.
- For two levels, send `populatePath` as JSON, in tree form:

  ```
  populatePath=[{"path":"contact","select":"firstName lastName company",
                 "populate":[{"path":"company","select":"companyName"}]}]
  ```

  Paths that do not exist are dropped silently here. A reference to a record that no longer
  exists comes back as `null`.

## Writing: create and update

- **Send references as `_id` strings,** also inside `customFields` and in arrays. A
  referenced record sent as an object answers
  `400 Document not found by primaryKey '[object Object]'`. The server also resolves the
  referenced object's primary key in place of the `_id` (a company's `companyCode`, a
  contact's email).
  The server does **not** check that an `_id` exists: a wrong one is saved and reads back as
  `null`.
- **Unknown fields and system fields are dropped silently.** `createdAt`, `updatedAt`,
  `createdBy` and `updatedBy` are set by the platform. Read the record back to confirm what
  was saved.
- **`workspace`:** a create without it goes to the user's primary workspace. It accepts a
  workspace `_id` or its code. A user who is not an admin may only create in their own
  workspaces (`403`).
- **`PATCH` merges plain objects key by key:** `{"address":{"city":"Cali"}}` keeps
  `address.street`.
- **`PATCH` replaces arrays whole,** and also free-form fields (type `mixed` in the schema,
  for example `meta`): send the complete array or value, not only the new item.
- **`null` removes a field.** The text `"null"` is turned into `null` as well.
- **An empty `PATCH` body** answers `400`.
- Some objects add their own rules on top: a deal in a closed stage rejects most edits, a
  stage change may require fields, a quote is saved whole. Their skills cover them.

## Errors

- Shape: `{"statusCode": <n>, "error": "<message>"}`, sometimes with `details`. (The OpenAPI
  document describes a different shape; this is the real one.)
- The message is translated: into the language of the `Accept-Language` header, otherwise the
  account's language. Act on `statusCode`, never on the wording.
- `400` validation or a rule of the object · `401` missing or invalid key · `403` the record
  exists but this user may not read or change it · `404` no such record (also for an id that
  is not valid) · `400 Invalid JSON` for a body that does not parse.
- Request bodies are limited to 10 MB.
- Each API key has a request limit (about 2,500 calls; the counter only resets after a full
  minute without calls, so steady traffic can hit it). Past it the API answers `429`. Call one
  request at a time, batch with the importer (`prolibu-imports`) instead of one call per
  record, and on a `429` wait at least a minute before retrying.
- A `PATCH` of a field the schema hides (`avoid: always`) answers `200`, changes nothing and
  still updates `updatedAt`. Read the record back instead of trusting the status.

## Read the schema before writing

- `GET /v2/openapi/specification/<object>` returns the OpenAPI document of one object (a few
  hundred KB): its paths and, under
  `paths["/v2/<object>/"].post.requestBody.content["application/json"].schema.properties`,
  the fields a create accepts. The full document, `GET /v2/openapi/specification`, is about
  10 MB; avoid it. Both list the account's own Custom Objects.
- In OpenAPI, free-form fields (`refId`, `meta`…) appear as `"type": "object"`.
- `GET /v2/user/me` returns `profile`, `modelSchemas`, `uiSchemas` and `permissions`.
  `modelSchemas.<ModelName>` (for example `modelSchemas.Contact`) is each object's raw
  field list with `type`, `ref`, `required`, `enum` and `avoid` (`always` = never writable,
  `update` = only on create, `create` = only on update). It is large: read one object.
- If the object is in neither, it does not exist on that account (modules are switched on
  per account). Say so and stop.

## The current user and the account settings

- `GET /v2/user/me` → `profile`: `_id`, `email`, `firstName`, `lastName`, `isAdmin`,
  `locale` (`language`, `currency`, and `timeZone` when set), workspaces.
- `GET /v2/user/preferences` → the account settings as every signed-in user sees them:
  `general`, `locale`, `security`, `modules`, `integrations`, `globalLocale`. Use it to read
  the account currency, language or a module's options.
- `GET /v2/preference/read` is **admin-only**: other users get `403`. Do not treat that 403
  as "the feature is off"; read `/v2/user/preferences` instead. Changing account
  preferences is never done through a skill.

## Fields every record has

| Field | Set by | Meaning |
| --- | --- | --- |
| `_id` | Platform | The record id (24 hexadecimal characters). |
| `createdAt`, `updatedAt` | Platform | When it was created and last changed. |
| `createdBy`, `updatedBy` | Platform | The users who did it (`_id`). |
| `workspace` | You or the platform | The business unit it belongs to. |
| `refId`, `refUrl` | You or an integration | Its id and a link in another system. See `prolibu-external-refs`. |

Lines inside a quote are not records and do not carry these fields.
