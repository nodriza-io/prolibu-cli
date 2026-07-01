# Prolibu Integration Guide

Build integrations on Prolibu the way you build them on Salesforce — against a stable, versioned public API and a set of declarative configuration surfaces, never against internal source code. Prolibu is an API-first, multi-tenant business platform: every business entity (deals, contacts, companies, users, and any custom object your account defines) is a record on an *object* exposed as an auto-generated REST resource, and everything you customize — objects, fields, automation, webhooks, endpoints, forms, OAuth apps — is created as configuration through that same API. This guide is written for a **third-party integrator or AI agent** who parametrizes a Prolibu account and connects it to other systems, using only public, supported surfaces.

> **Who this is for.** You are the equivalent of a Salesforce admin / ISV partner building against a customer org: you interact through the REST API, configuration objects, OAuth, webhooks, forms, endpoints, scripts, and the AI/MCP interface. You do **not** need — and will not find here — anything about Prolibu's backend implementation.

---

## Mental model

Prolibu is a single, uniform data platform with a small number of composable **integration primitives**. Learn these eight and you can build almost anything:

| Primitive | What it is | Read |
|---|---|---|
| **Objects & records** | Every entity — standard (`Deal`, `Contact`, `Company`, `User`, …) or custom — is a typed object with fields, reachable at `/v2/<object>/`. | [01](01-platform-and-data-model.md) |
| **Custom Objects & Custom Fields** | Model your own data declaratively: a whole new object (`POST /v2/cob`) or extra fields on an existing one (`POST /v2/customfield`). | [02](02-custom-objects-and-fields.md) |
| **REST API** | One auto-generated CRUD + search + query surface for every object, described by a live OpenAPI 3.0.3 spec. | [03](03-rest-api.md) |
| **Authentication** | API keys for machine-to-machine access; OAuth 2.0 (Connected Apps) when a third-party app acts on behalf of a user; a secure store for outbound secrets. | [04](04-authentication-and-connected-apps.md) |
| **Scripts / Automation** | Server-side logic you configure — run on demand, on a record create/update/delete event, or on a cron schedule — sandboxed with a timeout. | [05](05-automation-and-scripts.md) |
| **Webhooks / Events** | Push record changes (`<Object>.create/update/delete`) to your HTTP endpoint; per-user notification subscriptions; scheduled jobs. | [06](06-webhooks-and-events.md) |
| **Sites, Forms & Custom Endpoints** | Public web surfaces: hosted sites/SPAs, web-to-lead forms, and inbound HTTP endpoints that dispatch to your scripts. | [07](07-sites-forms-and-endpoints.md) |
| **AI & MCP** | Expose the account's data and actions to an AI agent as MCP tools, or run native AI agents on a trigger. | [08](08-ai-and-mcp.md) |

Two cross-cutting concerns sit under all of them: **connecting to external services** ([09](09-connecting-external-services.md)) and **security & permissions** ([10](10-security-and-permissions.md)) — the identity your integration runs as and which records it may touch.

A few invariants that hold everywhere and will save you time:

- **camelCase end to end.** Field names, nested paths, query params, and object/field API names are camelCase (`dealName`, `proposal.enabled`). Only the object segment in an HTTP path is lowercased (`/v2/eventprospect/`). Custom object names are singular PascalCase (`EventProspect`).
- **One versioned prefix.** Every endpoint lives under `/v2/` on your account host (`https://<your-domain>/v2/...`).
- **Discover, don't guess.** The OpenAPI spec at `GET /v2/openapi/specification` describes every object, field, and operation. Read it at runtime instead of hard-coding names.
- **Uniform CRUD, non-uniform envelope.** Every object gets `GET/POST/GET{id}/PATCH{id}/DELETE{id}` for free — but list/search wrap results in `{ pagination, data }` while read/create/update return the record directly and delete returns `204`.

---

## Rosetta Stone: Salesforce → Prolibu

If you already think in Salesforce, this table is your fastest on-ramp. Each Prolibu concept links to the document that covers it.

| Salesforce | Prolibu | Where |
|---|---|---|
| Custom Object (`MyObject__c`) | **Custom Object** — `POST /v2/cob`, then a full REST resource at `/v2/<name>` | [02](02-custom-objects-and-fields.md) |
| Custom Field | **Custom Field** — `POST /v2/customfield` (nested under `customFields.*` or an `overrides` on a built-in field) | [02](02-custom-objects-and-fields.md) |
| sObject + Object Manager | **Object** + OpenAPI describe (`/v2/openapi/specification`) | [01](01-platform-and-data-model.md) |
| REST / Composite API + SOQL | **REST API** — `/v2/<object>/` with `select` / `populate` / `query` / `sort` / `page` / `limit` | [03](03-rest-api.md) |
| Apex trigger / Flow / Process Builder | **Scripts & Automation** — a `Script` wired to a record create/update/delete event | [05](05-automation-and-scripts.md) |
| Scheduled Apex | **Scheduled script** — a `Script` with a cron schedule | [05](05-automation-and-scripts.md) |
| Outbound Message | **Webhook** — subscribe an external URL to `<Object>.create/update/delete` | [06](06-webhooks-and-events.md) |
| Platform Event | **Event Subscription** — per-user notification preferences across channels | [06](06-webhooks-and-events.md) |
| Named Credential / External Credential | **Service Credential** — `/v2/servicecredential`, an encrypted store referenced by id | [04](04-authentication-and-connected-apps.md) · [09](09-connecting-external-services.md) |
| Connected App (Prolibu as identity provider) | **Connected App (OAuth 2.0)** — `/v2/oauthapp` + `/v2/oauthgrant/*` | [04](04-authentication-and-connected-apps.md) |
| Auth Provider (per-user delegated OAuth out) | **Auth Provider** — Google / Microsoft / HubSpot sign-in and outbound tokens | [04](04-authentication-and-connected-apps.md) |
| Experience Site / `force.com` Sites | **Site** — a hosted static site or SPA at a stable public URL | [07](07-sites-forms-and-endpoints.md) |
| Web-to-Lead / Web-to-Case | **Form** — `Form` + `formSchema` + `mappings[]`, submissions become records | [07](07-sites-forms-and-endpoints.md) |
| Apex REST endpoint (`@RestResource`) | **Custom Endpoint** — `/v2/endpoint/{method}/{routeName}` dispatching to a script | [07](07-sites-forms-and-endpoints.md) |
| Agentforce / Einstein tool-calling | **AI & MCP interface** — MCP tools over the data model + native AI agents | [08](08-ai-and-mcp.md) |
| Profiles + Permission Sets + Sharing + FLS | **Roles & Permissions** — `role` scopes, record access modes, `ProtectedField@…` | [10](10-security-and-permissions.md) |
| Org (isolated tenant) + partitioning | **Workspace / account** — a tenant host, with `workspace` partitions inside it | [10](10-security-and-permissions.md) |
| Named Credential callout (`Http.send`) | **Outbound HTTP from a Script** referencing a Service Credential | [09](09-connecting-external-services.md) |
| Sandbox / scratch org | **Test account** (separate host + API key) | [11](11-best-practices.md) |

---

## Integration paths: pick the right primitive for the goal

Start from what you're trying to do; the table tells you which surface(s) to reach for.

| Your goal | Use | Salesforce analog |
|---|---|---|
| Read or write existing records from another system | **REST API** ([03](03-rest-api.md)) | REST / Composite API |
| Store a new kind of entity Prolibu doesn't ship | **Custom Object** ([02](02-custom-objects-and-fields.md)) | Custom Object `__c` |
| Add a few extra attributes to an existing object | **Custom Fields** ([02](02-custom-objects-and-fields.md)) | Custom Fields |
| Run logic **as part of** a write (validate, enrich, block) | **Script on a record event** ([05](05-automation-and-scripts.md)) | `before/after` Apex trigger |
| Be **notified** when a record changes, out-of-band | **Webhook** ([06](06-webhooks-and-events.md)) | Outbound Message |
| Run recurring work on a schedule | **Scheduled script** ([05](05-automation-and-scripts.md)) | Scheduled Apex |
| Receive an inbound HTTP call / a third party's webhook | **Custom Endpoint** ([07](07-sites-forms-and-endpoints.md)) | Apex REST |
| Turn public web submissions into records | **Form** ([07](07-sites-forms-and-endpoints.md)) | Web-to-Lead |
| Host a public marketing site or SPA | **Site** ([07](07-sites-forms-and-endpoints.md)) | Experience Site |
| Let another app act on behalf of a signed-in user | **Connected App + OAuth 2.0** ([04](04-authentication-and-connected-apps.md)) | Connected App |
| Give an AI agent tools over the account's data | **AI & MCP interface** ([08](08-ai-and-mcp.md)) | Agentforce / Einstein |
| Call out to an external SaaS from automation | **Service Credential + outbound HTTP** ([09](09-connecting-external-services.md)) | Named Credential + callout |
| Keep two systems in sync bi-directionally | **Compose** endpoint + webhook + scheduled script ([09](09-connecting-external-services.md)) | Integration patterns |
| Lock down what an integration identity can touch | **Roles & Permissions** ([10](10-security-and-permissions.md)) | Profiles + Permission Sets + Sharing |

**Rule of thumb — synchronous vs. reactive.** If the logic must run *inside* the write and can change or reject it, use a **script on a record event**. If you only need to *learn that it happened* and react elsewhere, use a **webhook**. If you need to *pull* on a cadence, use a **scheduled script**. Don't poll the REST API for changes you could receive as a webhook.

---

## Document index (reading order)

Read them in order the first time; after that, jump straight to the surface you need.

1. **[01-platform-and-data-model.md](01-platform-and-data-model.md)** — Platform & Data Model. Objects (standard vs custom), field types, record identifiers (`_id` / `primaryKey`), audit fields, relationships, the camelCase standard, and OpenAPI discovery. *[Salesforce: sObjects + Object Manager]*
2. **[02-custom-objects-and-fields.md](02-custom-objects-and-fields.md)** — Custom Objects & Custom Fields. Declaratively define a new object (`/v2/cob`) or add fields to an existing one (`/v2/customfield`), including relationships and validation. *[Salesforce: Custom Objects (`__c`) + Custom Fields]*
3. **[03-rest-api.md](03-rest-api.md)** — REST API Reference. The complete contract: base URL, auth headers, `select` / `populate` / `query` / `sort` / `page` / `limit`, response envelopes, error shape, and custom RPC actions. *[Salesforce: REST / Composite API]*
4. **[04-authentication-and-connected-apps.md](04-authentication-and-connected-apps.md)** — Authentication & Connected Apps. API keys (`/v2/token`), the OAuth 2.0 authorization-code flow (`/v2/oauthapp` + `/v2/oauthgrant/*`), and the secure credential store. *[Salesforce: Connected Apps + Named Credentials + Auth Providers]*
5. **[05-automation-and-scripts.md](05-automation-and-scripts.md)** — Automation & Scripts. The `Script` resource, trigger modes (manual / record event / cron), sandbox limits, persisted variables, and outbound HTTP. *[Salesforce: Apex triggers + Scheduled Apex + Flows]*
6. **[06-webhooks-and-events.md](06-webhooks-and-events.md)** — Webhooks & Events. Subscribe URLs to record events, per-user event subscriptions and notification channels, and scheduled jobs, with delivery payloads. *[Salesforce: Outbound Messages + Platform Events + Scheduled Jobs]*
7. **[07-sites-forms-and-endpoints.md](07-sites-forms-and-endpoints.md)** — Sites, Forms & Custom Endpoints. Hosted sites/SPAs, web-to-lead forms and `FormSubmission`, and inbound HTTP endpoints that run your scripts. *[Salesforce: Experience Sites + Web-to-Lead + Apex REST]*
8. **[08-ai-and-mcp.md](08-ai-and-mcp.md)** — AI & MCP Interface. The MCP endpoint and session handshake, the built-in tool set over the data model, and native AI agents on a trigger. *[Salesforce: Agentforce / Einstein tool-calling]*
9. **[09-connecting-external-services.md](09-connecting-external-services.md)** — Connecting to External Services. A patterns cookbook: store credentials, call out, receive callbacks, and compose push / pull / two-way sync with a correlation `externalId`. *[Salesforce: Named Credential callouts + integration patterns]*
10. **[10-security-and-permissions.md](10-security-and-permissions.md)** — Security & Permissions. The object layer (scopes) vs. the record layer (visibility), roles, field-level protection, workspaces, and tenant isolation. *[Salesforce: Profiles + Permission Sets + Sharing + Orgs]*
11. **[11-best-practices.md](11-best-practices.md)** — Integration Best Practices. Naming, error handling, idempotent and bulk-safe writes, rate-limit-friendly design, observability, versioning, and testing against a sandbox account. *[Salesforce: Integration best practices + sandbox testing]*
12. **[12-integration-recipes.md](12-integration-recipes.md)** — End-to-end integration playbooks. Complete, copy-pasteable walkthroughs that assemble the primitives above into working integrations.

---

## Getting started

A first integration in three steps: authenticate, discover the schema, do a CRUD call. Throughout, `https://<domain>` is your account host (for example `https://acme.prolibu.com`).

### 1. Authenticate

Create an API key (a `Token`) for machine-to-machine access, then send it as a bearer token on every request. Details, scopes, and the OAuth 2.0 flow are in [Authentication & Connected Apps](04-authentication-and-connected-apps.md).

```bash
# Create an API key (admin credential required to mint one)
curl -X POST 'https://<domain>/v2/token' \
  -H 'Authorization: Bearer <ADMIN_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{ "name": "My integration", "tokenType": "API" }'
# -> 201 { "_id": "...", "apiKey": "<API_KEY>", ... }   # copy apiKey now — it is never shown again
```

Every subsequent call uses that key:

```bash
curl 'https://<domain>/v2/deal/' -H 'Authorization: Bearer <API_KEY>'
```

### 2. Discover the objects and schema (OpenAPI)

Don't hard-code object or field names — read them from the live OpenAPI 3.0.3 spec. See [Platform & Data Model §7](01-platform-and-data-model.md) and [REST API §7](03-rest-api.md).

```bash
# The whole catalog: every object, path and schema
curl 'https://<domain>/v2/openapi/specification' -H 'Authorization: Bearer <API_KEY>'

# One object's fields, types and operations
curl 'https://<domain>/v2/openapi/specification/deal' -H 'Authorization: Bearer <API_KEY>'
```

The spec's `servers[0].url` is your base URL and its `securitySchemes` list the supported auth methods.

### 3. Do your first CRUD call

Create a record, then read it back with a relationship expanded. Note the different response shapes per operation (see [REST API §5](03-rest-api.md)).

```bash
# Create a Deal (list/create paths are the lowercased object name under /v2/)
curl -X POST 'https://<domain>/v2/deal/' \
  -H 'Authorization: Bearer <API_KEY>' -H 'Content-Type: application/json' \
  -d '{ "dealName": "Acme renewal", "contact": "jane@acme.com", "closeDate": "2026-09-30" }'
# -> 201, returns the created record directly (with server-assigned _id, createdAt, ...)

# Read it back, expanding the contact relationship and selecting a few fields
curl -G 'https://<domain>/v2/deal/6408d61d2f88f1d606048139' \
  -H 'Authorization: Bearer <API_KEY>' \
  --data-urlencode 'populate=contact' \
  --data-urlencode 'select=dealName contact closeDate'
# -> 200, the record itself:
# { "_id": "6408...", "dealName": "Acme renewal",
#   "contact": { "_id": "665f...", "firstName": "Jane", "email": "jane@acme.com" },
#   "closeDate": "2026-09-30T00:00:00.000Z" }

# List recent deals (list wraps results in { pagination, data })
curl -G 'https://<domain>/v2/deal/' \
  -H 'Authorization: Bearer <API_KEY>' \
  --data-urlencode 'sort=-createdAt' --data-urlencode 'limit=5'
```

From here, follow the [Integration paths](#integration-paths-pick-the-right-primitive-for-the-goal) table above to whichever surface your use case needs — and read [Best Practices](11-best-practices.md) before you ship.

### Quickstart checklist

- [ ] Minted an API key with `POST /v2/token` and stored it securely (it is shown only once).
- [ ] Fetched `GET /v2/openapi/specification` (and the per-object spec) to discover objects and fields instead of guessing.
- [ ] Confirmed the object path is the **lowercased** object name under `/v2/`, and identifiers/fields stay camelCase.
- [ ] Ran a create → read → list round-trip and handled each operation's distinct response shape.
- [ ] Decided which primitive fits the goal (REST vs. script vs. webhook vs. endpoint vs. MCP) using the paths table.
- [ ] Reviewed [Security & Permissions](10-security-and-permissions.md) to run the integration under a least-privilege identity, and rehearsed against a **test account**, never production.
