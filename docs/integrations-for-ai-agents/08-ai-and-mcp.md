# AI & MCP Interface

> Salesforce analogy: this is Prolibu's **Agentforce / Einstein tool-calling** layer. The account exposes its data and actions to an AI agent as **MCP tools**; an external MCP client (Claude Desktop, Cursor, your own agent) connects over a standard endpoint, discovers the tools, and calls them on behalf of an authenticated user. The account can also run **native AI agents** — LLM-driven automations triggered on a schedule or by a record event.

## When to use this

Reach for this layer when you want an AI agent to **read and operate a Prolibu account** — search contacts, create deals with proposals, price a quote, draft or send email, add notes and tasks — without hand-writing a REST client for every action. Prolibu speaks the **Model Context Protocol (MCP)**: you point any MCP-capable client at the account's MCP endpoint, authenticate with an API key, and get a set of ready-made tools over the account's data model. For **reactive** AI (an agent that runs when a `Deal` is created, or every morning at 09:00) the account configures a **native AI agent** bound to a trigger. Both paths ultimately call the same tools.

If you only need deterministic, non-AI automation on a record event or a schedule, use a script instead — see [Automation & Scripts](05-automation-and-scripts.md). If you need raw CRUD without an agent, use the [REST API](03-rest-api.md) directly.

## Prolibu ↔ Salesforce

| Prolibu | Salesforce | Notes |
|---|---|---|
| MCP endpoint + built-in tools | Einstein tool-calling / external actions | The whole data model is exposed to the LLM as callable tools. |
| MCP client session (`Mcp-Session-Id`) | Agent session | One session per connected client; API-key authenticated. |
| Server `instructions` (system prompt) | Agent instructions / prompt template | Global behavioral rules the agent receives on connect. |
| Native AI agent (schedule / record-event triggered) | Agentforce Agent + Scheduled / Record-Triggered Flow | LLM automation bound to a trigger. |
| `serviceCredential` (`providerType`) | Named Credential / Einstein model config | Where the LLM provider API key is stored (encrypted). |
| `getMyProfile` permissions map | Profile / Permission Set | **Advisory** — surfaced to the agent, see the security note in §6. |
| `find` / `findOne` / `create` / `update` / `delete` / `search` | SOQL / DML actions exposed to the LLM | Generic CRUD over any object. |
| `createProposal` / `updateProposal` / `calculateQuote` | CPQ / Revenue Cloud quote actions | Proposal-and-quote actions on `Deal`. |
| Streamable-HTTP MCP + OAuth 2.0 metadata | External Client App / Connected App for agents | Lets external MCP clients auto-discover the endpoint and auth. |

Sibling docs: [REST API](03-rest-api.md) · [Authentication & Connected Apps](04-authentication-and-connected-apps.md) · [Automation & Scripts](05-automation-and-scripts.md) · [Custom Objects & Fields](02-custom-objects-and-fields.md) · [Security & Permissions](10-security-and-permissions.md).

---

## 1. The MCP endpoint

Prolibu exposes a single Model Context Protocol server per account over **streamable HTTP**. All traffic goes to one path under the versioned API prefix:

| Method + Path | Purpose |
|---|---|
| `POST /v2/mcpsession/ses` | Initialize a session and send JSON-RPC MCP requests (`initialize`, `tools/list`, `tools/call`). |
| `GET /v2/mcpsession/ses` | Open the server→client event stream for an existing session (SSE). |
| `DELETE /v2/mcpsession/ses` | Close an existing session. |
| `GET /v2/mcpsession/metadata` | **Public.** Discovery document: endpoint URL, protocol version, capabilities, and OAuth 2.0 endpoints. No auth required. |

The MCP surface follows the standard protocol, so any conformant MCP client library works. The details a client needs:

- **Transport:** streamable HTTP (`POST` for requests, `GET` for the SSE stream).
- **Protocol version:** `2025-03-26`.
- **Capabilities:** `tools` only (`resources` and `prompts` are not served).
- **Session header:** after `initialize`, the server returns an `Mcp-Session-Id`. Send it back on every subsequent request on that session. Sessions expire after **30 minutes** of inactivity — re-`initialize` to get a fresh one.

### 1.1 Enable MCP first

MCP is **off by default**. An administrator must enable it in the account's integration preferences before any `/v2/mcpsession/ses` request will succeed. While disabled, those requests return **`403`**. The public `GET /v2/mcpsession/metadata` document still responds even when MCP is disabled, so you can discover the endpoint before it is turned on.

### 1.2 Authentication

Every request to `/v2/mcpsession/ses` is authenticated as a specific user via an **API key** (bearer token). The agent then acts **as that user**: records it creates are stamped with that user, and `getMyProfile` reports that user's identity and permission map.

Send the key exactly as on any other REST endpoint (see [Authentication & Connected Apps](04-authentication-and-connected-apps.md)):

```
Authorization: Bearer <apiKey>
```

Requests with no key, or a key whose user no longer exists, return **`401`**. Because the agent operates with the full reach of the token's user, scope the API key you hand to an agent to the **narrowest** set of permissions it needs — do not give an autonomous agent an admin key unless it truly needs one.

External MCP clients that prefer a user-delegated flow (Claude Desktop, Cursor) can instead obtain a bearer token through the account's OAuth 2.0 authorization server; the metadata document (§1.3) advertises the OAuth endpoints so the client can auto-configure.

### 1.3 Discovery — `GET /v2/mcpsession/metadata`

Fetch the public metadata document to learn the endpoint and the auth flow. Works even while MCP is disabled and requires no credentials:

```bash
curl 'https://<domain>/v2/mcpsession/metadata'
```

Response (`200`):

```json
{
  "name": "Prolibu MCP Server",
  "version": "1.0.0",
  "protocol": "mcp",
  "protocolVersion": "2025-03-26",
  "transportType": "streamable-http",
  "endpoint": "https://<domain>/v2/mcpsession/ses",
  "capabilities": { "tools": true, "resources": false, "prompts": false },
  "authentication": {
    "type": "oauth2",
    "tokenEndpoint": "https://<domain>/v2/oauthgrant/token",
    "authorizationEndpoint": "https://<domain>/v2/oauthgrant/authorize",
    "metadataEndpoint": "https://<domain>/v2/oauthgrant/metadata"
  }
}
```

A well-behaved MCP client reads this to find `endpoint` and, if using OAuth, the `authorizationEndpoint` / `tokenEndpoint`. For the full OAuth 2.0 authorization-code flow that issues those tokens, see [Authentication & Connected Apps](04-authentication-and-connected-apps.md).

---

## 2. Session lifecycle

An MCP session is the standard three-step handshake, all over `/v2/mcpsession/ses`:

1. **`initialize`** — the client announces its protocol version and capabilities; the server replies with its own and issues an `Mcp-Session-Id` (returned as a response header). Keep that id.
2. **`tools/list`** — the client discovers the available tools. Each tool comes back with a `name`, a `description`, and a JSON-Schema `inputSchema` describing its arguments.
3. **`tools/call`** — the client invokes a tool by `name` with an `arguments` object. The server runs it as the authenticated user and returns a result.

On connect, the server also provides a set of **`instructions`** (a global system prompt) describing how the agent should behave: prefer small result pages when searching, refer to records by their human-readable `displayName` rather than raw ids, follow the proposal workflow for deals, respect the user's time zone, and treat the permission map from `getMyProfile` as authoritative. A conformant client surfaces these instructions to the LLM automatically. **Call `getMyProfile` first** in any session so the agent knows who it is and what it may touch.

Every tool result uses the standard MCP content envelope. On success:

```json
{ "content": [{ "type": "text", "text": "<JSON-encoded result>" }] }
```

On failure the same envelope is returned with `isError: true`:

```json
{ "content": [{ "type": "text", "text": "{\"error\":\"Model \\\"Widget\\\" not found.\"}" }], "isError": true }
```

The `text` field is always a JSON string. Parse it to read the tool's structured result.

---

## 3. Built-in tools reference

These tools are available out of the box in every session, over **any** object in the account — standard or custom. Argument names are the public interface; use them verbatim. Optional arguments are marked `?`.

### 3.1 Discovery & identity

| Tool | Arguments | Purpose |
|---|---|---|
| `getMyProfile` | *(none)* | Returns `{ profile: { _id, firstName, lastName, email, isAdmin, status, roles[], company, locale }, permissions?, availableModels[] }`. Admins get every model in `availableModels`; non-admins get a `permissions` map of `{ ModelName: [actions] }`. **Call this first.** |
| `listModels` | *(none)* | Lists every object the account exposes: `{ models: [{ name }], count }`. |
| `describeModel` | `modelName` | Returns the full field schema for an object (types resolved to their type name). For `Deal`, it inlines the quote and line-item schema under `proposal.quote` so the agent can build proposals correctly. |

### 3.2 Reading records

| Tool | Arguments | Purpose |
|---|---|---|
| `find` | `modelName`, `query?`, `select?`, `sort?`, `limit?`, `skip?` | Filtered list query. `limit` defaults to `20` and is clamped to `1–100`. Returns `{ modelName, data: [...], pagination: { total, limit, skip, returned } }`. |
| `findOne` | `modelName`, `id`, `select?`, `populate?` | Fetch one record by `_id` (or by the object's primary key). Auto-populates all referenced records unless you pass an explicit `populate`; pass `"*"` to populate every reference. |
| `search` | `modelName`, `term`, `select?`, `populate?`, `sort?`, `page?`, `limit?` | Full-text search. `term` supports `"exact phrase"`, `wildcard*`, and `-exclusion`. `limit` defaults to `10`, clamped to `1–100`. Returns `{ modelName, term, data, pagination }`. |
| `getActivity` | `modelName` (`"Contact"` or `"Company"`), `docId` | Returns a merged activity feed (notes, tasks, emails, calls, meetings, deals, contracts). For a `Company`, activity is grouped by contact. |

### 3.3 Writing records

| Tool | Arguments | Purpose |
|---|---|---|
| `create` | `modelName`, `data` | Creates a record. Stamps the record's creator/updater as the session user. For a `Deal` **with a proposal, use `createProposal` instead.** Returns `{ modelName, data, webUrl }`. |
| `update` | `modelName`, `id`, `data` | Updates a record. For array fields, pass the **complete** array — partial arrays replace the whole value. Do **not** use this to edit proposal line items (use `updateProposal`). |
| `delete` | `modelName`, `id` | Deletes a record (soft-delete where the object supports it). Returns `{ modelName, deleted: true, data }`. |
| `addNote` | `modelName`, `docId`, `content` (HTML), `color?`, `sticky?` | Attaches a note to a record. Returns `{ modelName: "Note", data, linkedTo }`. |
| `addTask` | `modelName`, `docId`, `title`, `description?`, `assignee?`, `startAt?`, `dueAt?`, `dueReminder?` | Attaches a task (with optional dates and reminder) to a record. This is also how the agent creates **reminders**. |

### 3.4 Proposals & quotes

| Tool | Arguments | Purpose |
|---|---|---|
| `calculateQuote` | `currency?`, `lineItems[]` (`{ productName, price, quantity?, discountRate?, currency? }`, min 1) | **Preview pricing without saving.** Returns `subTotal`, `discountAmount`, `taxAmount`, `total`, plus per-item `netUnitPrice` / `netTotal` / `taxAmount` / `total`. |
| `createProposal` | `contactId`, `dealName`, `proposalTitle`, `currency?`, `lineItems[]` (min 1), `closeDate?`, `expirationDate?` | Creates a `Deal` with an enabled proposal and its quote line items. **The only correct way to create a deal-plus-proposal.** Returns `{ modelName: "Deal", data, webUrl, previewUrl, trackingUrl }`. |
| `updateProposal` | `dealId`, `lineItems[]` (min 1), `currency?`, `proposalTitle?`, `expirationDate?` | Rewrites a deal's proposal line items and recalculates totals. **`lineItems` fully replaces the existing set — any item you omit is removed.** Never use the generic `update` for line items. |

### 3.5 Email

| Tool | Arguments | Purpose |
|---|---|---|
| `draftEmail` | `to`, `subject`, `message` (HTML), `cc?`, `bcc?` | Prepares a draft for the user to review; the sender address is resolved from the user's connected mailbox. **Does not send.** If no mailbox is connected, returns an error carrying a `connectUrl`. |
| `sendEmail` | `to`, `subject`, `message` (HTML), `cc?`, `bcc?` | Sends immediately from the user's connected mailbox. Returns `{ success, emailId, status, from, to, subject }`. Requires a connected mailbox. |

> **`draftEmail` / `sendEmail` need a connected mailbox** (a Google or Microsoft mailbox the user has authorized). Without one, both tools return a `connectUrl` and do nothing. The `from` address is **always** taken from that connected mailbox — the agent cannot spoof an arbitrary sender.

For the field-level detail behind `describeModel`, `create`, and the proposal tools, see [Custom Objects & Fields](02-custom-objects-and-fields.md).

---

## 4. Native AI agents (account-configured)

Beyond an externally-connected client, the account can run its **own** AI agents — LLM-driven automations that use the same tools. You configure a native agent from three pieces:

1. **A provider credential** (`serviceCredential`) that stores the LLM provider's API key (encrypted). See [Authentication & Connected Apps](04-authentication-and-connected-apps.md).
2. **A skill** — the instructions/prompt that tells the agent what to do (a task prompt plus an optional system prompt).
3. **A trigger** — *when* the agent runs. Two modes:
   - **Scheduled** — a cron expression plus an IANA time zone (for example, every day at 09:00 in `America/Bogota`).
   - **On a record event** — bound to an object and a record event (created / updated / deleted); the changed record is passed to the agent as context.

The agent runs as an assigned user with an API key, so it operates over the account exactly like a connected MCP client — same tools, same authorization model, same per-user stamping.

### 4.1 Choosing the LLM provider and model

The provider credential's `providerType` selects the model family. The supported AI providers and their models:

| `providerType` | Models (default first) | Context window |
|---|---|---|
| `openai` | `gpt-5.4-mini`, `gpt-5.4`, `gpt-5.5`, `gpt-5.4-nano` | 128k (200k for `gpt-5.5`) |
| `anthropic` | `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-8` | 200k |
| `google` | `gemini-2.5-flash`, `gemini-2.5-pro` | 1M |
| `deepseek` | `deepseek-chat`, `deepseek-reasoner` | 128k (64k for `deepseek-reasoner`) |

Store the provider key in a `serviceCredential` and reference it by id — never paste an LLM API key into a prompt or a request body.

### 4.2 Interactive chat entry point

To drive an agent conversationally from your own front end (rather than from a generic MCP client), post a message and let the platform run the tool-calling loop:

```
POST /v2/aiChat/sendMessage
```

Body:

| Field | Type | Notes |
|---|---|---|
| `messages` | `[Object]`, required | Conversation turns; each `{ role, content }` with `role` one of `user`, `assistant`, `system`. |
| `credentialId` | `String`, required | The `serviceCredential` id that provides the LLM. |
| `model` | `String` | Optional model override from the table above; otherwise the provider default is used. |
| `conversationId` | `String` | Optional — continue an existing conversation. |

The call returns immediately with a `jobId` (and a `conversationId`); the agent's incremental output — text deltas, tool calls, and the final message — streams back over the account's realtime channel, not in the HTTP body.

---

## 5. Worked examples

### 5.1 Connect, list tools, and query (raw JSON-RPC over HTTP)

Most integrators use an MCP client library, but the wire protocol is plain JSON-RPC over `POST`. First, **initialize** a session and capture the session id:

```bash
curl -i -X POST "https://<domain>/v2/mcpsession/ses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "my-agent", "version": "1.0.0" }
    }
  }'
```

The response headers include the session id you must echo on every later request:

```
Mcp-Session-Id: 6b1f0c8e-...-a2d4
```

Now **discover the tools** on that session:

```bash
curl -X POST "https://<domain>/v2/mcpsession/ses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: 6b1f0c8e-...-a2d4" \
  -d '{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }'
```

Response (abridged) — each tool carries a JSON-Schema `inputSchema`:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      { "name": "getMyProfile", "description": "Return the current user's profile and permissions.", "inputSchema": { "type": "object", "properties": {} } },
      { "name": "find", "description": "List records of a model with an optional query.", "inputSchema": { "type": "object", "properties": { "modelName": { "type": "string" }, "query": { "type": "object" }, "limit": { "type": "number" } }, "required": ["modelName"] } }
    ]
  }
}
```

Finally, **call a tool** — the five most recent deals in the negotiation stage:

```bash
curl -X POST "https://<domain>/v2/mcpsession/ses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: 6b1f0c8e-...-a2d4" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "find",
      "arguments": {
        "modelName": "Deal",
        "query": { "stage": "negotiation" },
        "sort": "-createdAt",
        "limit": 5
      }
    }
  }'
```

Result — the tool's structured output is JSON-encoded in `content[0].text`:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"modelName\":\"Deal\",\"data\":[{\"_id\":\"665f...\",\"dealName\":\"Acme rollout\",\"stage\":\"negotiation\"}],\"pagination\":{\"total\":1,\"limit\":5,\"skip\":0,\"returned\":1}}"
      }
    ]
  }
}
```

### 5.2 Create a deal with a proposal (`createProposal`)

Never build a `Deal` proposal with the generic `create`. Call `createProposal`, which sets up the deal, enables the proposal, and prices the quote in one step:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "createProposal",
    "arguments": {
      "contactId": "665f0a...contactId",
      "dealName": "Acme rollout — Q3",
      "proposalTitle": "Acme Platform Subscription",
      "currency": "USD",
      "lineItems": [
        { "productName": "Platform license", "price": 1200, "quantity": 10 },
        { "productName": "Onboarding", "price": 3000, "quantity": 1, "discountRate": 0.1 }
      ],
      "expirationDate": "2026-09-30"
    }
  }
}
```

The tool result (decoded from `content[0].text`):

```json
{
  "modelName": "Deal",
  "data": { "_id": "665f...", "dealName": "Acme rollout — Q3", "proposal": { "enabled": true, "quote": { "total": 14700 } } },
  "webUrl": "https://<domain>/ui/spa/suite/deals/edit/665f...",
  "previewUrl": "https://<domain>/ui/spa/view/deal/665f.../665f0a...contactId",
  "trackingUrl": "https://<domain>/ui/spa/view/deal/665f.../665f0a...contactId"
}
```

To change the quote later, call `updateProposal` with the **complete** `lineItems` set — anything you omit is removed.

### 5.3 Price a quote without saving (`calculateQuote`)

Use `calculateQuote` to preview totals before committing to a deal:

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "calculateQuote",
    "arguments": {
      "currency": "USD",
      "lineItems": [
        { "productName": "Platform license", "price": 1200, "quantity": 10, "discountRate": 0.15 }
      ]
    }
  }
}
```

Decoded result:

```json
{
  "currency": "USD",
  "subTotal": 12000,
  "discountAmount": 1800,
  "taxAmount": 0,
  "total": 10200,
  "lineItems": [
    { "productName": "Platform license", "netUnitPrice": 1020, "netTotal": 10200, "taxAmount": 0, "total": 10200 }
  ]
}
```

No `Deal` is created — this is a pure pricing calculation you can show the user before calling `createProposal`.

---

## 6. Common pitfalls

1. **MCP is off by default.** Until an administrator enables it in the account's integration preferences, every `/v2/mcpsession/ses` request returns `403`. The public `metadata` document still responds, which can be misleading — discovery working does not mean sessions will.
2. **Call `getMyProfile` first.** It tells the agent who it is (`profile`), whether it is an admin, and — for non-admins — the `permissions` map of what it may touch. Skipping it leaves the agent guessing.
3. **The permission map is advisory to the agent, not a hard gate at the tool layer.** Authorization for MCP tool calls is enforced by the **API key's own permissions/scopes** (the same permission model as the REST API — see [Security & Permissions](10-security-and-permissions.md)). Do not rely on the LLM policing itself: give an agent an API key scoped to exactly the objects and actions it needs, and no more.
4. **Send `Mcp-Session-Id` on every call after `initialize`.** Omitting it (or reusing an expired one) breaks the session; sessions time out after 30 minutes of inactivity — re-`initialize` to recover.
5. **`createProposal` / `updateProposal` — not `create` / `update` — for deal proposals.** Building a proposal quote with the generic tools produces broken pricing. And `updateProposal` **replaces** the entire `lineItems` set: any item you leave out is deleted.
6. **`update` replaces arrays wholesale.** For any array field, send the full array; a partial array overwrites the stored value.
7. **`draftEmail` / `sendEmail` require a connected mailbox.** Without a Google/Microsoft mailbox authorized for the user, both return a `connectUrl` and send nothing. The sender address always comes from that mailbox.
8. **Search returns small pages by default.** `find` defaults to `limit: 20`, `search` to `limit: 10`, both clamped to `1–100`. For large scans, page with `skip` / `page`.
9. **Scope the agent's API key.** The agent acts as the token's user with that user's full reach. An admin key gives an autonomous agent unrestricted access — prefer a purpose-scoped key.
10. **Native scheduled agents can't run sub-minute.** A scheduled trigger uses a standard cron expression and requires a time zone; the minimum interval is once per minute.
11. **Agent-initiated writes don't recursively re-trigger record-event agents.** A native agent that creates or updates records will not cause its own or another record-event agent to fire again in the same run — don't design a flow that depends on that chaining.

---

## 7. Checklist

**Connect an external MCP client**

- [ ] Ask an administrator to enable MCP in the account's integration preferences (otherwise `/v2/mcpsession/ses` → `403`).
- [ ] Fetch `GET /v2/mcpsession/metadata` to discover the `endpoint` and (if using OAuth) the authorization/token endpoints.
- [ ] Obtain a bearer credential: an API key scoped to the objects/actions the agent needs, or a user-delegated OAuth token.
- [ ] `initialize` a session, capture the `Mcp-Session-Id`, and send it on every subsequent request.
- [ ] `tools/list` to discover tools, then `getMyProfile` before any real work.
- [ ] Use `describeModel` to learn an object's fields before `create` / `update`.

**Operate the account through tools**

- [ ] Read with `find` / `findOne` / `search`; page with `limit` + `skip` / `page`.
- [ ] Write with `create` / `update` / `delete`; send full arrays on array fields.
- [ ] Build deal proposals only with `createProposal` / `updateProposal`; preview pricing with `calculateQuote`.
- [ ] Confirm a mailbox is connected before `draftEmail` / `sendEmail`.

**Configure a native AI agent**

- [ ] Store the LLM provider key in a `serviceCredential` and pick a `providerType` + model from §4.1.
- [ ] Author the skill (task prompt + optional system prompt).
- [ ] Bind a trigger: a cron schedule (with time zone) or a record event (object + create/update/delete).
- [ ] Assign the agent a user with an API key scoped to only what it needs.
- [ ] For a conversational front end, drive it via `POST /v2/aiChat/sendMessage` with `messages` + `credentialId`, and consume the streamed output over the account's realtime channel.

---

**See also:** [REST API](03-rest-api.md) · [Authentication & Connected Apps](04-authentication-and-connected-apps.md) · [Automation & Scripts](05-automation-and-scripts.md) · [Custom Objects & Fields](02-custom-objects-and-fields.md) · [Security & Permissions](10-security-and-permissions.md)
