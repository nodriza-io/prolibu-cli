# Sites, Forms & Custom Endpoints

> Salesforce analogy: this is Prolibu's equivalent of **Experience Sites (hosting) + Web-to-Lead / Web-to-Case forms + Apex REST**. You publish a hosted site or single-page app, capture public form submissions as records, and stand up custom HTTP endpoints that receive inbound requests (including webhooks) and run your automation — all without shipping server code.

## When to use this

Reach for this layer whenever your integration must expose something to the **public web**: an inbound API or webhook receiver, a web-to-lead form that turns anonymous submissions into `Contact` / `Deal` / `Ticket` records, a hosted marketing site or SPA, or a short URL. A custom **Endpoint** is the exact inbound counterpart to an outbound [Webhook](06-webhooks-and-events.md): where a webhook *pushes* record events out to your URL, an endpoint *receives* an HTTP request and dispatches it to one of your automation [Scripts](05-automation-and-scripts.md), then returns whatever that script produces.

## Prolibu ↔ Salesforce

| Prolibu | Salesforce | Public surface |
|---|---|---|
| `Endpoint` (`routeName` + `method` + `script`) | Apex REST (`@RestResource urlMapping`) | Yes — `/v2/endpoint/{method}/{routeName}` |
| `Form` + `formSchema` + `mappings[]` (web-to-lead) | Web-to-Lead / Web-to-Case, Flow Screen forms | Yes — `register` / `upload` / `view` / `thanks` / `jsonschema` |
| `FormSubmission` (persisted lead log) | Raw lead-capture records | Managed via REST CRUD |
| `Site` (hosted static site or SPA) | Experience Sites / `force.com` Sites | Yes — served publicly at a stable URL |
| `ShortUrl` (`/r/:code` redirector) | (no direct analog) | Yes — `302` redirect |

Sibling documents: [REST API](03-rest-api.md) (how these resources are read/written and how query params work), [Custom Objects & Fields](02-custom-objects-and-fields.md) (the objects and fields a form maps into), [Automation & Scripts](05-automation-and-scripts.md) (the script an endpoint runs), [Webhooks & Events](06-webhooks-and-events.md) (the outbound counterpart), [Authentication & Connected Apps](04-authentication-and-connected-apps.md) (API keys and OAuth), and [Security & Permissions](10-security-and-permissions.md).

Throughout this document `https://<domain>` stands for your account host (for example `https://acme.prolibu.com`), and `<API_KEY>` is an API key or OAuth access token sent as `Authorization: Bearer <API_KEY>` — see [Authentication & Connected Apps](04-authentication-and-connected-apps.md).

---

## How these resources are managed

`Endpoint`, `Form`, `FormSubmission`, `Site`, and `ShortUrl` are ordinary API resources. You create, read, update, and delete them through the standard REST-CRUD surface — `POST/GET/PATCH/DELETE /v2/<resource>/` — exactly like any other object (see [REST API](03-rest-api.md)). Those management routes are **authenticated** and require the appropriate privileges.

Separately, each of these resources also exposes a small number of **public routes** — the URLs your visitors actually hit (a form's `register` route, an endpoint's invocation URL, a site's hosted pages, a short URL). Those public routes do not require an `Authorization` header at the router level; instead each one enforces its **own** authorization (captcha, password, a signed upload token, or the endpoint's `authentication` setting). Do not read "no bearer token needed" as "no protection" — the protection is built into each surface and described below.

> **Path casing.** Public route paths are matched in **lowercase**. The endpoint method segment is `get` / `post` / `put` / `delete`, and the form JSON-schema route is `/v2/form/jsonschema/{id}`. Always use lowercase in production URLs.

---

## 1. Custom Endpoints — inbound HTTP

An `Endpoint` binds a public URL to one of your automation [Scripts](05-automation-and-scripts.md). When the URL is called, the platform runs the script, hands it the request (headers, query, body), and returns whatever the script assigns to its `output`. This is the inbound mirror of an outbound [Webhook](06-webhooks-and-events.md) and the closest analog to Salesforce **Apex REST**.

### 1.1 The `Endpoint` resource

| Field | Type | Notes |
|---|---|---|
| `endpointCode` | `String` (auto) | Auto-generated unique code, prefixed `ENP-`. Read-only. |
| `endpointName` | `String`, required | Human-readable name. |
| `routeName` | `String`, required, unique | The URL slug. Alphanumeric and hyphens only (DNS-safe). |
| `method` | `String`, required | One of `GET`, `POST`, `PUT`, `DELETE`. Default `POST`. |
| `script` | `ObjectId` ref `Script`, required | The automation script to run for each request. |
| `active` | `Boolean` | Only active endpoints respond; an inactive one returns `404`. |
| `authentication.enabled` | `Boolean`, default `true` | When `true`, the caller must present a valid API key. When `false`, the endpoint is fully public. |
| `authentication.requiredRoles` | `[ObjectId]` ref `Role` | When set, an authenticated caller must be an admin or hold at least one of these roles, or the request is rejected with `403`. |
| `collaborators` | `[ObjectId]` | Optional collaborators. |

The combination of `routeName` + `method` must be unique; creating a second endpoint with the same pair is rejected with a `400`.

### 1.2 Invocation URL

Once created, an endpoint is called at:

```
https://<domain>/v2/endpoint/{method}/{routeName}
```

where `{method}` is the lowercased HTTP method. So a `GET` endpoint named `get-test` is reachable at `https://<domain>/v2/endpoint/get/get-test`, a `POST` endpoint named `stripe-hook` at `https://<domain>/v2/endpoint/post/stripe-hook`, and so on. The HTTP method you use to call the URL must match the endpoint's `method`.

### 1.3 Authentication behavior

- If `authentication.enabled` is `false`, anyone can call the endpoint. This is the mode you use for public webhooks and open APIs.
- If `authentication.enabled` is `true`, the caller must send `Authorization: Bearer <API_KEY>`. A missing or invalid credential returns `401`.
- If `authentication.requiredRoles` is non-empty, an authenticated non-admin caller who holds none of those roles is rejected with `403`.

Because an inbound webhook sender usually cannot present your API key, receivers for third-party webhooks are typically created with `authentication.enabled: false` and validate the sender **inside the script** (for example, by checking a shared-secret header, or a provider signature, against a value you keep in the script's persistent variables). See [Automation & Scripts](05-automation-and-scripts.md) for the variables store.

### 1.4 What the script receives and returns

Each invocation runs the linked script with a request context. Inside the script the request is exposed through the standard event fields (see [Automation & Scripts](05-automation-and-scripts.md) for the execution model):

- `eventName` is `"EndpointRequest"`.
- `eventData` carries the request:

| `eventData` field | Contents |
|---|---|
| `endpoint` | `{ _id, endpointCode, endpointName, routeName, url, method }` — metadata about the endpoint that was hit. |
| `authenticated` | `true` if the caller presented a valid credential, else `false`. |
| `headers` | The inbound request headers. |
| `query` | Parsed query-string parameters. |
| `body` | The parsed request body (for `POST` / `PUT`). |

Whatever the script assigns to `output` becomes the endpoint's response payload. The endpoint wraps it in an envelope:

```json
{ "authenticated": <boolean>, "output": <whatever the script set> }
```

> **Read `output`, not the raw body.** The HTTP response is always `{ authenticated, output }`. Your script's result is under the `output` key — clients must read `response.output`, not the top level.

The script runs in an isolated sandbox with a per-run time budget (see [Automation & Scripts](05-automation-and-scripts.md)). The endpoint waits for the script to finish; if the script throws, the request fails with an error response. Possible status codes are `200`, `401`, `403`, `404`, and `429`.

### 1.5 Worked example — a public "echo" endpoint

Step 1 — create the script that handles `EndpointRequest` and echoes the request back:

```bash
curl -s -X POST "https://<domain>/v2/script/" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "scriptName": "Echo endpoint",
    "active": true,
    "code": "(async () => { if (eventName === \"EndpointRequest\") { output = { received: eventData.query, body: eventData.body }; } })();"
  }'
```

Response (`201`):

```json
{ "_id": "665f0c9a1b2c3d4e5f0011aa", "scriptName": "Echo endpoint", "active": true }
```

Step 2 — create the endpoint and bind it to the script, public (no auth):

```bash
curl -s -X POST "https://<domain>/v2/endpoint/" \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "endpointName": "Get Test",
    "routeName": "get-test",
    "method": "GET",
    "script": "665f0c9a1b2c3d4e5f0011aa",
    "authentication": { "enabled": false }
  }'
```

Response (`201`):

```json
{ "_id": "665f0c9a1b2c3d4e5f0011bb", "routeName": "get-test", "method": "GET", "script": "665f0c9a1b2c3d4e5f0011aa", "active": true }
```

Step 3 — call it publicly (note the lowercase method segment):

```bash
curl -s "https://<domain>/v2/endpoint/get/get-test?foo=bar"
```

Response (`200`):

```json
{
  "authenticated": false,
  "output": { "received": { "foo": "bar" }, "body": {} }
}
```

If you flip `authentication.enabled` to `true` with `PATCH /v2/endpoint/<_id>`, the same call without a bearer token returns `401`; with a valid token it returns `200` and `output` reflects `authenticated: true`. `POST` / `PUT` / `DELETE` work the same way — the request body arrives as `eventData.body`.

### 1.6 Using an endpoint as a webhook receiver

An endpoint is the natural receiver for an outbound [webhook](06-webhooks-and-events.md), including Prolibu's own webhooks and those from third-party systems. Create a `POST` endpoint with `authentication.enabled: false`, then point the sender at:

```
https://<domain>/v2/endpoint/post/<routeName>
```

The delivered event arrives as `eventData.body`. For a Prolibu-to-Prolibu webhook that is `{ eventName, eventData }` (see [Webhooks & Events](06-webhooks-and-events.md) for the envelope); for a third-party sender it is whatever that provider posts. Validate the sender inside the script before acting on the payload.

---

## 2. Web-to-Lead Forms

A `Form` renders a public form and maps each submission onto one or more records. It is the analog of Salesforce **Web-to-Lead / Web-to-Case**, but generalized: a single submission can create any object you have defined, standard or custom.

### 2.1 The `Form` resource

Managed through `/v2/form/` CRUD (authenticated). Key configurable fields:

| Field | Type | Notes |
|---|---|---|
| `formCode` | `String` (auto) | Auto-generated unique code, prefixed `FRM-`. |
| `formName` | `String`, required | Human-readable name. |
| `description` | `String` | Optional description. |
| `formSchema` | `Object` (JSON) | **The single source of truth for the fields** — see [§2.2](#22-formschema--flat-vs-paged). |
| `mappings` | `[Object]` | How submitted values become records — see [§2.3](#23-mapping-submissions-to-records). |
| `access.mode` | `String` enum | `''` (default), `public`, `authenticated`, or `password`. Governs who may submit. |
| `access.enableCaptcha` | `Boolean`, default `true` | Requires a captcha token when `mode` is `public`. |
| `access.password` | `String` | Required password when `mode` is `password` (auto-generated if you enable password mode without supplying one). |
| `thankYou.title` | `String` | Confirmation heading shown after submit. |
| `thankYou.message` | `String` | Confirmation body. |
| `thankYou.redirectURL` | `String` | Optional URL to redirect to after a successful submit. |
| `submissions.persist` | `Boolean`, default `false` | When `true`, each submission is stored as a `FormSubmission` (see [§2.7](#27-formsubmission)). |
| `submissions.notifyOnSubmit` | `[ObjectId]` ref `User` | Users to notify on each submission. |
| `assignmentGroup` | `ObjectId` ref `UserGroup` | Round-robin owner assignment for created records. |
| `uploads.enabled` | `Boolean`, default `true` | Whether file-type fields accept uploads. |
| `uploads.maxFileSizeMB` | `Number` | Per-file size cap (hard ceiling 5 MB). |
| `active` | `Boolean` | Only active forms accept submissions. |

### 2.2 `formSchema` — flat vs paged

`formSchema` defines the fields. It has two shapes:

- **Flat** — a plain object of field definitions keyed by field key. Rendered as a single form. The keys `title`, `description`, `mode`, `theme`, and `pages` are reserved meta keys and are not treated as fields.
- **Paged (wizard)** — `{ title, description, theme, pages: [{ name, title, fields }] }`. Rendered as a multi-step wizard. A form is treated as paged when `pages` is a non-empty array.

Each field definition carries a `type`. Valid field types:

```
string  number  boolean  date  objectid  mixed  array  text
select  email   phone    url   textarea  rating slider color
file    html    section
```

A minimal flat schema:

```json
{
  "title": "Contact us",
  "fullName": { "type": "string", "required": true },
  "email":    { "type": "email",  "required": true },
  "message":  { "type": "textarea" }
}
```

Fields must declare a `type` (or a UI component, or a `sourceModel` + `sourceAttr` pair); an unknown `type` is rejected with `400` when you save the form.

### 2.3 Mapping submissions to records

`mappings` is an array; each entry turns the submission into a record on one object:

| Mapping field | Type | Notes |
|---|---|---|
| `modelName` | `String`, required | The object API name to create — must be an existing object (e.g. `Contact`, `Deal`, `Ticket`). |
| `action` | `String` | Currently only `create` is supported (the default). |
| `fieldMap` | `Object`, required | Maps form field keys to field paths on the object. Nested paths are supported (e.g. `"companyName": "account.name"`). |
| `defaults` | `Object` | Static values merged into every created record. |
| `assignmentGroup` | `ObjectId` ref `UserGroup` | Optional per-mapping owner assignment override. |

When you save the form it is validated (all failures return `400`): every `modelName` must exist, every `fieldMap` value must reference a field key that exists in `formSchema`, and `action` must be `create`.

### 2.4 Public form routes

A form exposes these public routes under `/v2/form/`:

| Route | Method | Purpose | Auth |
|---|---|---|---|
| `/v2/form/register` | `PUT` | **Submit** the form (create records). | Public — enforced by the form's `access.mode`. |
| `/v2/form/upload` | `POST` (multipart) | Upload a file for a `file`-type field. | Public — requires a signed `uploadToken`. |
| `/v2/form/jsonschema/{id}` | `GET` | Fetch the schema for headless rendering. | Public. |
| `/v2/form/view/{id}` | `GET` | Server-rendered HTML form. | Public. |
| `/v2/form/thanks/{id}` | `GET` | Server-rendered confirmation page. | Public. |

> The submit route is **`PUT /v2/form/register`**, not `POST`. This is a common mistake.

Additional authenticated helper routes exist for building forms and for external lead-ad ingestion (`getmodelfields`, `metafields`, `submitexternal`); those require a valid token and are used by tooling rather than by end users.

### 2.5 Submitting a form — `register`

`PUT /v2/form/register` takes `{ id, data }` where `id` is the form's `_id` (or `formCode`) and `data` is a flat object of field-key → value. Depending on `access.mode` you also send:

- `captchaToken` — required when `mode` is `public` and `enableCaptcha` is `true`.
- `password` — required when `mode` is `password`.
- an `Authorization` bearer token — required when `mode` is `authenticated`.
- `verifyOnly: true` — validate access without persisting; returns `{ "verified": true }`.

On success the response is `{ results, redirectURL }`. `results` is one entry per mapping describing the record it created.

**Example — a submission that creates a `Ticket`:**

```bash
# public form, no Authorization header; note PUT, not POST
curl -s -X PUT "https://<domain>/v2/form/register" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "665f0c9a1b2c3d4e5f0022aa",
    "data": {
      "ticketSubject": "Request from web form",
      "ticketDescription": "<p>Created via form submission</p>",
      "ticketChannel": "Email"
    }
  }'
```

Response (`200`):

```json
{
  "results": [
    { "modelName": "Ticket", "action": "create", "recordId": "665f0c9a1b2c3d4e5f0033bb", "status": "success" }
  ],
  "redirectURL": null
}
```

Each `results` entry has `status: "success"` or `status: "failed"` (with an `error` message) so you can tell which mappings succeeded. If a required field defined in `formSchema` is missing, the whole request is rejected with `400`.

Public submission is rate-limited per IP and per form; bursts of submissions beyond those limits return `429`. Design test harnesses accordingly.

### 2.6 File uploads

Uploads are a two-step, secured flow because the public submitter has no API key:

1. Obtain a short-lived `uploadToken` from the form's render payload (`view`, see [§2.8](#28-headless-rendering)). The token is bound to the form and expires (about 30 minutes).
2. `POST` the file as `multipart/form-data` to `/v2/form/upload` with `formId`, the `uploadToken`, the target `fieldKey`, and the `file`.

```bash
curl -s -X POST "https://<domain>/v2/form/upload" \
  -F "formId=665f0c9a1b2c3d4e5f0022aa" \
  -F "uploadToken=<token from the form view payload>" \
  -F "fieldKey=resume" \
  -F "file=@resume.pdf"
```

Response (`200`):

```json
{ "fileId": "665f0c9a1b2c3d4e5f0044cc", "fileName": "resume.pdf" }
```

The stored file is **private** and scoped to the form. Uploads are validated: the target field must be a `file` field, the size cap applies (`uploads.maxFileSizeMB`, hard ceiling 5 MB → `413` if exceeded), and the extension/type is whitelisted (`.pdf`, `.doc`, `.docx`, `.jpg`, `.jpeg`, `.png`) and content-checked. A missing, forged, or expired `uploadToken` returns `401`; uploads on a form with `uploads.enabled: false` return `403`. Uploads are rate-limited per IP and per form (`429` on excess).

Use the returned `fileId` as the value of the corresponding field in your `register` `data` payload.

### 2.7 `FormSubmission`

When `submissions.persist` is `true`, each submission is stored as a `FormSubmission` record you can query through REST CRUD at `/v2/formsubmission/` (authenticated). Fields:

| Field | Type | Notes |
|---|---|---|
| `form` | `ObjectId` ref `Form`, required | The form that produced the submission. |
| `data` | `Object` | The raw submitted values. |
| `mappingResults` | `[Object]` | The per-mapping outcome (same shape as `register` `results`). |
| `source` | `String` enum | `web`, `meta`, `api`, or `''`. |
| `status` | `String` enum | `processed`, `failed`, `pending`, or `''`. `failed` if any mapping failed. |
| `ip` | `String` | Submitter IP. |
| `submittedBy` | `ObjectId` ref `User` | Set when the submitter was authenticated. |

### 2.8 Headless rendering

If you render the form in your own front end instead of using the hosted page, fetch its schema with the public JSON-schema route:

```bash
curl -s "https://<domain>/v2/form/jsonschema/665f0c9a1b2c3d4e5f0022aa"
```

Response (`200`):

```json
{
  "formName": "Contact Form",
  "formSchema": { "...": "..." },
  "fields": { "email": { "type": "email", "required": true } },
  "access": { "mode": "public", "enableCaptcha": true }
}
```

`fields` is an **object keyed by field key** (not an array); each value is the flattened field definition. This route deliberately **omits** `mappings` and `access.password` — the mapping logic and the password are never exposed publicly. Render from this payload, then submit with `PUT /v2/form/register`.

---

## 3. Hosted Sites

A `Site` hosts a static site or a single-page app (SPA) at a stable public URL — the analog of a Salesforce **Experience Site**. You upload a `.zip` of the built site and the platform serves it.

### 3.1 The `Site` resource

Managed through `/v2/site/` CRUD (authenticated). Both `_id` and `siteCode` work as the path identifier, so `GET /v2/site/my-landing` is valid.

| Field | Type | Notes |
|---|---|---|
| `siteName` | `String`, required | Human-readable name. |
| `siteCode` | `String`, unique | URL slug. Auto-generated as `SITE-<timestamp>` if omitted — **always set it explicitly**, it is the public URL. Restricted to `A-Z a-z 0-9 . _ -`. |
| `siteType` | `String` enum, default `Static` | `Static` or `SPA`. Changes where the archive is unzipped **and** how unmatched paths are served — see [§3.4](#34-how-requests-are-served). |
| `package` | `ObjectId` ref `File` (`.zip`) | The uploaded archive. **Must contain `index.html` at its root.** |
| `active` | `Boolean`, default `true` | Public visibility — see [§3.5](#35-activation). |
| `authenticationRequired` | `Boolean`, default `false` | Require a signed-in user to open the site — see [§3.6](#36-requiring-a-signed-in-visitor). |
| `readme` | `String` (Markdown) | Free-form documentation stored with the site. |
| `git.repositoryUrl` | `String` | Where the source lives. Informational only — the platform never pulls from it. |
| `publicUrl` | `String` (read-only) | **The URL to share:** `https://<domain>/site/<siteCode>/`. |
| `url` | `String` (read-only) | The long canonical origin the pretty URL proxies to. |
| `assignee`, `collaborators` | `ObjectId` refs | Ownership, as on any other record. |

> **`variables` and `lifecycleHooks` are not `Site` fields.** Some tooling sends them; the platform ignores them silently. Do not rely on them — configure a site through the files you ship in the archive.

### 3.2 The two URLs

Every published site is reachable two ways, and both keep working:

```
https://<domain>/site/<siteCode>/                                 ← publicUrl — use this
https://<domain>/sites/<ownerId>/public/<siteCode>/[spa/]         ← url — the physical origin
```

The short form is a **reverse proxy**, not a redirect: the address bar keeps showing `/site/<siteCode>/`. Prefer `publicUrl` everywhere — the long form leaks the owner's record id and breaks if the site is re-created under another user.

Requesting `/site/<siteCode>` without the trailing slash answers `302` to the canonical `/site/<siteCode>/`. That redirect is required: without it the browser would resolve the page's relative assets against `/site/` instead of the site folder.

> **Historical note.** Sites used to also publish `/r/<siteCode>` through a `ShortUrl` record, exposed as a `shortUrl` field. **That field no longer exists and new sites no longer create the record** — `publicUrl` replaced it. Sites created before the change keep their `/r/` link working. If your code reads `site.shortUrl`, it now reads `undefined`; use `site.publicUrl`.

### 3.3 Uploading a site

Send the archive as `multipart/form-data` in the `package` field:

```bash
curl -s -X POST "https://<domain>/v2/site/" \
  -H "Authorization: Bearer <API_KEY>" \
  -F "siteName=Marketing SPA" \
  -F "siteCode=my-spa-site" \
  -F "siteType=SPA" \
  -F "package=@spa.zip"
```

Response (`201`):

```json
{
  "_id": "665f0c9a1b2c3d4e5f0055dd",
  "siteName": "Marketing SPA",
  "siteCode": "my-spa-site",
  "siteType": "SPA",
  "active": true,
  "publicUrl": "https://<domain>/site/my-spa-site/",
  "url": "https://<domain>/sites/665f.../public/my-spa-site/spa/"
}
```

Rules the archive must satisfy:

- **`index.html` must sit at the root of the zip**, not inside a wrapper folder. Zip the *contents* of your build directory, not the directory itself. A missing `index.html` fails with `400` and the upload is rolled back.
- Max upload size is **120 MB** (`MAX_UPLOAD_FILESIZE`).
- Re-deploy by `PATCH`ing a new `package` to the same site. The previous unzipped folder is **deleted first**, so a deploy is a replacement, not a merge — files you stop shipping disappear.

> **⚠️ The malicious-content scanner will reject a normal web page.** If the account has
> `modules.tools.cloudDrive.advancedSecurity.enabled` **and** `scanMaliciousContent` turned on,
> every text file extracted from your archive is pattern-matched, and the whole upload fails
> with `400 Malicious content detected in file` if any of these appears:
>
> ```
> <script>…</script>   javascript:   vbscript:   onload=   onerror=   onclick=
> <iframe   <object   <embed   eval(   document.write
> ```
>
> A paired `<script>` tag is enough — **including `<script src="./app.js"></script>`**, which
> every SPA shell has. Verified: the same archive uploads `201` with the tag removed and `400`
> with it present. The setting defaults to **off**, so most accounts are unaffected, but when it
> is on there is no per-site override — sites with any JavaScript cannot be deployed until an
> administrator turns `scanMaliciousContent` off. Check it first if an upload fails with that
> message; the archive itself is fine.

```bash
curl -s -X PATCH "https://<domain>/v2/site/my-spa-site" \
  -H "Authorization: Bearer <API_KEY>" \
  -F "package=@dist.zip"
```

### 3.4 How requests are served

Understanding this is what separates a site that works from one that 403s on its second page.

| Request under `/site/<siteCode>/` | Static site | SPA site |
|---|---|---|
| `/` (the root) | `index.html` | `index.html` |
| `foo.css`, `bar.js`, images… (any extension but `.html`) | `302` straight to storage | `302` straight to storage |
| `about.html` (explicit `.html`) | that exact file | that exact file |
| `about` (no extension) | `about/index.html` — treated as a folder | **`index.html`** — history-API fallback |
| `deep/client/route` | `deep/client/route/index.html` | **`index.html`** — history-API fallback |

Two consequences worth internalizing:

- **Assets are answered by a redirect to object storage**, not proxied. They are fast and cost the platform nothing, but they are also *not* covered by `authenticationRequired` ([§3.6](#36-requiring-a-signed-in-visitor)).
- **Only `siteType: 'SPA'` gets the history-API fallback.** A `Static` site keeps folder semantics, so nested static directories keep working. If your SPA is registered as `Static`, every client route below the root answers with a storage `AccessDenied` error page. Changing `siteType` requires re-uploading the `package`, because the archive is unzipped to a different path per type.

### 3.5 Building an SPA that survives the mount path

A site is served from `/site/<siteCode>/`, never from the domain root. A bundle built with default settings assumes it lives at `/` and breaks. Two things must be true:

**1. Assets must be referenced relatively.** With Vite, set `base` — the default (`'/'`) emits absolute `/assets/...` paths that resolve against the domain root and 404:

```ts
// vite.config.ts
export default defineConfig({
  base: './',        // emits ./assets/... — required
  build: { outDir: 'dist' },
})
```

**2. The client router must know where it is mounted.** For SPA sites the platform injects a `<base>` tag into the shell before serving it:

```html
<head><base href="/site/my-spa-site/">
```

That tag makes relative assets resolve against the site root **at any depth** — which is what lets a deep link work at all — and it exposes the mount point to your code as `document.baseURI`. Read it instead of hardcoding:

```js
const basename = new URL(document.baseURI).pathname   // "/site/my-spa-site/"

// React Router
createBrowserRouter(routes, { basename })
// or <BrowserRouter basename={basename}>

// Vue Router
createRouter({ history: createWebHistory(basename), routes })
```

The same bundle then works unmodified at the pretty URL, at the long `/sites/...` URL, and on your local dev server. **Hash routing (`#/route`) also works** with no configuration at all — it ignores the path entirely — and is the simplest option if you do not need clean URLs.

If your shell already declares its own `<base>`, the platform leaves it alone.

### 3.6 Requiring a signed-in visitor

Set `authenticationRequired: true` to gate the site behind a Prolibu session:

```bash
curl -s -X PATCH "https://<domain>/v2/site/my-spa-site" \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{ "authenticationRequired": true }'
```

An anonymous visitor is answered `302` to `/v2/auth/signin?redirect=<the URL they asked for>` and lands back on the page after signing in. The session is read server-side from the `apiKey` cookie set at sign-in, so no client-side code is involved and the page HTML is never delivered to an anonymous caller.

> **This gates the pages, not the files.** Assets are redirected to object storage, which serves them to anyone holding the URL while the site is `active`. Treat `authenticationRequired` as "who gets to open this site", not as a content lock — never ship secrets in a site bundle.

Two behaviors to expect:

- Toggling the flag takes up to **~60 seconds** to propagate (the site lookup is cached).
- The session cookie is `SameSite=Strict`, so a visitor arriving from an external link (email, Slack) is bounced through the sign-in page once even when they already have a session.

### 3.7 Activation

`active` is not merely a logical flag: toggling it flips the stored files between public and private. Deactivating takes the site offline immediately — every URL, short and long, returns `403`.

```bash
curl -s -X PATCH "https://<domain>/v2/site/665f0c9a1b2c3d4e5f0055dd" \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{ "active": false }'
```

### 3.8 Calling the Prolibu API from inside a site

A site is plain static hosting served from your account's own domain, so `fetch('/v2/...')` is same-origin. An authenticated visitor's `apiKey` cookie is `httpOnly` — JavaScript cannot read it — so a site that needs to call the API on the visitor's behalf signs in through `POST /v2/auth/signin` and keeps the returned `apiKey` in `localStorage`, sending it as `Authorization: Bearer <apiKey>`. See [Authentication & Connected Apps](04-authentication-and-connected-apps.md).

---

## 4. Short URLs

A `ShortUrl` maps a short code to a destination and issues a `302` redirect. Managed through `/v2/shorturl/`.

### 4.1 Generating a short URL

`POST /v2/shorturl/generate` (authenticated) takes `{ url, code? }` and returns the short link. If you omit `code`, one is generated; if a short URL already exists for the same destination `url`, it is reused.

```bash
curl -s -X POST "https://<domain>/v2/shorturl/generate" \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/very/long/path", "code": "promo2026" }'
```

Response (`200`):

```json
{ "link": "https://<domain>/r/promo2026" }
```

### 4.2 Resolving a short URL

The public redirect route is:

```
GET https://<domain>/r/<code>
```

An existing code issues a `302` redirect to the destination; an unknown code returns a `404` page.

> **Sites no longer register a short URL.** They used to reserve `/r/<siteCode>` automatically, which meant publishing a site could overwrite a `ShortUrl` someone else had already created on that code. Sites now serve themselves at `/site/<siteCode>/` ([§3.2](#32-the-two-urls)) and the `ShortUrl` code space is yours alone. Links handed out before the change still resolve.

---

## Common pitfalls

1. **Public does not mean unprotected.** The public form routes and the endpoint invocation URLs carry no bearer requirement at the router, but each enforces its own authorization: captcha / password / signed upload token for forms, and `authentication.enabled` (plus `requiredRoles`) for endpoints. Design that authorization in deliberately.
2. **`/v2/form/register` is `PUT`, not `POST`.** Submitting with `POST` will not hit the register route.
3. **Endpoint responses are wrapped.** The body is always `{ authenticated, output }`. Read `response.output`, not the top level.
4. **Lowercase the endpoint method segment.** The invocation path uses `get` / `post` / `put` / `delete`, and the JSON-schema route is `/v2/form/jsonschema/{id}`. Use lowercase in production.
5. **`mappings` and `access.password` are never exposed publicly.** The headless `jsonschema` and `view` payloads omit them — do not expect to read the mapping logic or password from a public route.
6. **Uploads require a fresh `uploadToken`.** You cannot post a file to `/v2/form/upload` without first obtaining the short-lived, form-bound token from the form's view payload. Expired or forged tokens return `401`.
7. **File uploads are validated hard.** Wrong field type → `400`; over the size cap → `413`; disallowed extension/content → rejected. Stored files are private and scoped to the form.
8. **A site archive must contain `index.html` at the root of the zip.** Zip the *contents* of your build folder, not the folder — a wrapper directory is the most common cause of a `400` on upload.
9. **Deactivating a `Site` takes it offline immediately** — previously valid URLs return `403`. It is not a soft, logical flag.
13. **Share `site.publicUrl`, not `site.url`.** `shortUrl` no longer exists (it reads `undefined`); the long `url` leaks the owner id. See [§3.2](#32-the-two-urls).
14. **An SPA registered as `siteType: 'Static'` 403s on every route below the root.** Only `SPA` gets the history-API fallback, and switching the type requires re-uploading the `package`.
15. **A default Vite build does not work under `/site/<siteCode>/`.** Set `base: './'` and give your router `basename: new URL(document.baseURI).pathname`, or use hash routing. See [§3.5](#35-building-an-spa-that-survives-the-mount-path).
16. **`authenticationRequired` gates pages, not assets.** Files stay readable from object storage while the site is `active` — never ship secrets in a bundle.
17. **Re-deploying replaces the whole site.** The old unzipped folder is deleted first, so anything you stop shipping disappears.
18. **`400 Malicious content detected in file` on upload is not about your zip being corrupt.** It means the account has the cloud-drive content scanner on, and it rejects any `<script>…</script>` tag — see [§3.3](#33-uploading-a-site).
10. **`routeName` + `method` must be unique per endpoint**; a collision is rejected with `400`. Pick distinct route names rather than relying on the method to disambiguate.
11. **Endpoint scripts run under a timeout.** The request waits for the script; a long-running or throwing script surfaces as an error response. Keep endpoint scripts fast and do heavy work asynchronously.
12. **Public submission and upload are rate-limited** per IP and per form; bursts return `429`.

---

## Checklist

**Expose an inbound API or webhook receiver (`Endpoint`):**

- [ ] Create a `Script` whose `code` handles `eventName === "EndpointRequest"` and assigns `output`.
- [ ] Create the `Endpoint` with a DNS-safe `routeName`, the `method`, the `script`, and `authentication.enabled` set appropriately (`false` for public/webhook receivers).
- [ ] Ensure the `routeName` + `method` pair is unique.
- [ ] Call `https://<domain>/v2/endpoint/<method-lowercase>/<routeName>` and read `response.output`.
- [ ] As a webhook receiver, point the sender at `.../v2/endpoint/post/<routeName>`, keep `authentication.enabled: false`, and validate the sender inside the script (read the payload from `eventData.body`).

**Publish a web-to-lead form (`Form`):**

- [ ] Define `formSchema` (flat or paged) using only valid field types.
- [ ] Define `mappings[]` with an existing `modelName`, a `fieldMap` referencing keys present in the schema, and `action: "create"`.
- [ ] Choose `access.mode` (`public` + captcha / `authenticated` / `password`) and decide on `submissions.persist`.
- [ ] Submit with **`PUT /v2/form/register`** `{ id, data }` (plus `captchaToken` / `password` when required).
- [ ] For file fields, fetch an `uploadToken` from the form view, `POST` the file to `/v2/form/upload`, then send the returned `fileId` in `register`.
- [ ] For headless rendering, read `GET /v2/form/jsonschema/<id>` and render in your own app.

**Host a site (`Site`):**

- [ ] Pick an explicit `siteCode` — it *is* the public URL — and set `siteType` to `SPA` if any route lives below the root.
- [ ] Build a `.zip` whose **root** holds `index.html` (zip the contents of `dist/`, not `dist/` itself), under 120 MB.
- [ ] For an SPA: build with `base: './'` and read the router basename from `document.baseURI`, or use hash routing.
- [ ] `POST` `multipart/form-data` to `/v2/site/` with `siteName`, `siteCode`, `siteType`, and `package=@site.zip`.
- [ ] Share the returned **`publicUrl`** (`https://<domain>/site/<siteCode>/`), never `url` and never `shortUrl`.
- [ ] Re-deploy by `PATCH`ing a new `package` to `/v2/site/<siteCode>` — it replaces the whole folder.
- [ ] Gate it with `authenticationRequired: true` if it should require a signed-in visitor (pages only, not assets).
- [ ] Activate / deactivate with `PATCH /v2/site/<_id> { "active": ... }`.

Sibling documents: [Platform & Data Model](01-platform-and-data-model.md) · [Custom Objects & Fields](02-custom-objects-and-fields.md) · [REST API](03-rest-api.md) · [Authentication & Connected Apps](04-authentication-and-connected-apps.md) · [Automation & Scripts](05-automation-and-scripts.md) · [Webhooks & Events](06-webhooks-and-events.md) · [Security & Permissions](10-security-and-permissions.md).
