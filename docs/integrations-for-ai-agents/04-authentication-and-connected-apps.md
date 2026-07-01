# Authentication & Connected Apps

> Salesforce analogy: this area combines **Connected Apps** (an external app authenticates *to* Prolibu via OAuth 2.0), **Auth Providers** (Prolibu obtains delegated tokens to call a SaaS *on behalf of a user*), and **Named Credentials / External Credentials** (static third-party API keys kept in a secure store so automation never hardcodes secrets). Prolibu can act as an OAuth **authorization server** or as an OAuth **client**, depending on the direction of trust.

## When to use this

Read this before building any integration that needs **credentials**. There are two trust directions, and you pick the mechanism by which way the call flows:

- **Inbound — something authenticates *to* Prolibu.** A backend, a data pipeline, an MCP client, or an AI assistant needs to call the Prolibu REST API. Use an **API key** (a `Token`, section 2) for machine-to-machine access, or the **OAuth 2.0 authorization server** (a Connected App, section 3) when a third-party app acts on behalf of a signed-in user.
- **Outbound — Prolibu calls *out* to a SaaS.** Your automation needs to hit OpenAI, Twilio, SendGrid, Anthropic, etc. Store the third-party secret in the account's **secure credential store** (`serviceCredential`, section 4) and reference it by id — never paste a secret into a script or a request body.

## Prolibu ↔ Salesforce

| Prolibu | Salesforce | Direction |
|---|---|---|
| API key (`token`, `tokenType: "API"`) | Session ID / API-enabled token | External → Prolibu |
| Connected App (`/v2/oauthapp`) + OAuth server (`/v2/oauthgrant/*`) | **Connected App** (Prolibu is the identity provider) | External → Prolibu (delegated by a user) |
| `authorizationCode` → `accessToken` + `refreshToken` | OAuth 2.0 Web Server / PKCE flow | External → Prolibu |
| Auth Providers (Google / Microsoft / HubSpot sign-in + outbound tokens) | **Auth Providers** | Prolibu → External (per user) |
| Secure credential store (`/v2/servicecredential`) | **Named Credentials / External Credentials** | Prolibu → External (static API key) |
| `scopes: ["Resource@Model.fn"]` on a token | Permission Sets / Profiles / FLS | — |

> **Rule of thumb:** decide the direction first. If another system consumes Prolibu, you are in section 2 or 3 (Prolibu issues the credential). If Prolibu consumes another system, you are in section 4 (you store the other system's credential). Do not mix them just because both involve the word "OAuth".

All endpoints below live under the versioned API prefix `/v2/`. Resource paths in the URL are always **lowercase** (`/v2/oauthapp`, `/v2/servicecredential`), even though the JSON field names are camelCase. See [REST API](03-rest-api.md) for the shared conventions (query params, response envelope, error shape).

Sibling docs: [Platform & Data Model](01-platform-and-data-model.md) · [Custom Objects & Fields](02-custom-objects-and-fields.md) · [REST API](03-rest-api.md) · [Automation & Scripts](05-automation-and-scripts.md) · [Connecting External Services](09-connecting-external-services.md) · [Security & Permissions](10-security-and-permissions.md).

---

## 2. Inbound: API keys (machine-to-machine)

An **API key** is the simplest way for an external system to authenticate to Prolibu. It is analogous to a Salesforce session id / API-enabled token: one long-lived secret sent on every request. You create it once, copy the plaintext value **at creation time only**, and send it as a bearer token.

### 2.1 Creating an API key — `POST /v2/token`

An administrator (or a user with permission to manage tokens) creates a token. For a machine key set `tokenType` to `"API"` and give it a human-readable `appName`.

| Field | Type | Notes |
|---|---|---|
| `tokenType` | string | `"API"` for a machine key, `"Session"` for an interactive session (default). |
| `appName` | string | **Required when `tokenType` is `"API"`.** The label you'll recognize this key by. |
| `description` | string | Optional free-text note. |
| `scopes` | `[string]` | Permission strings in the form `Resource@<Model>.<fn>` (for example `Resource@Contact.create`). Mutually exclusive with `roles`. |
| `roles` | `[string]` | Role ids to grant. Mutually exclusive with `scopes`. |
| `expiresAt` | date (ISO 8601) | Optional. API keys do **not** expire by default; set this to force an expiry. |

```bash
curl -X POST 'https://demos.prolibu.com/v2/token' \
  -H 'Authorization: Bearer <ADMIN_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "tokenType": "API",
    "appName": "Lead Manager Integration",
    "description": "Server-to-server key for the contact-form backend",
    "scopes": ["Resource@Contact.create", "Resource@Contact.find"]
  }'
```

Response (`201`) — the plaintext `apiKey` is returned **only in this response**:

```json
{
  "_id": "6408d61d2f88f1d606048139",
  "tokenType": "API",
  "appName": "Lead Manager Integration",
  "apiKey": "64d266180886c6dc9b5f74cc-1691511959894",
  "apiKeyLastDigits": "9894",
  "scopes": ["Resource@Contact.create", "Resource@Contact.find"],
  "provider": "local"
}
```

> **Copy the `apiKey` now.** It is stored encrypted at rest and is `unselect`, so any later `GET /v2/token/:id` returns the token metadata (including `apiKeyLastDigits`) but **never** the plaintext key again. If you lose it, revoke the token and issue a new one.

**Scope rules.** If you omit `scopes` (and `roles`), the key inherits the creating user's own permissions. A non-admin can only grant scopes or roles they themselves already hold. Grant the **narrowest** set that gets the job done — a key scoped to `Resource@Contact.create` cannot read deals, which is exactly what you want for a contact-form backend.

### 2.2 Sending the API key

Send the key on every request. Three forms are accepted, in this priority order:

| # | Form | Header / param |
|---|---|---|
| 1 | **Bearer (recommended)** | `Authorization: Bearer <apiKey>` |
| 2 | **Basic** | `Authorization: Basic base64("apiKey:<apiKey>")` — the "username" must be the literal string `apiKey`. |
| 3 | **Query fallback** | `?apiKey=<apiKey>` (avoid; ends up in logs and browser history). |

```bash
# Recommended:
curl -G 'https://demos.prolibu.com/v2/contact' \
  -H 'Authorization: Bearer 64d266180886c6dc9b5f74cc-1691511959894' \
  --data-urlencode 'limit=1'

# Basic-auth equivalent (username is the literal word apiKey):
curl -G 'https://demos.prolibu.com/v2/contact' \
  -H "Authorization: Basic $(printf 'apiKey:64d266180886c6dc9b5f74cc-1691511959894' | base64)"
```

### 2.3 What the request is authorized to do

Each protected operation checks the token's `scopes` against the model and function being called. The required permission is one of:

```
Resource@*.*
Resource@<Model>.*
Resource@<Model>.<fn>
```

If the token holds none of these for the requested operation, the API responds `403` with a message naming the model and function it refused. Admin users bypass scope checks (unless the API key was deliberately locked to scopes). Requests are also rate-limited per token; exceeding the per-minute ceiling returns `429 Too many requests`. See [Security & Permissions](10-security-and-permissions.md) for the full permission model.

---

## 3. Inbound: Connected Apps (OAuth 2.0 authorization server)

When a **third-party application acts on behalf of a signed-in user** — an AI assistant, an MCP client, a partner backend — register it as a **Connected App** and use the OAuth 2.0 authorization-code flow. Prolibu is the **authorization server**: it authenticates the user, issues an `accessToken` and a `refreshToken` to the app, and rotates them. This is the direct analog of a Salesforce Connected App.

> **The OAuth server may be disabled by default.** An administrator enables it in the account's security preferences before any `oauthapp`/`oauthgrant` endpoint will issue tokens; while disabled these endpoints return `403`. The public metadata endpoint (§3.5) still works.

### 3.1 Register the Connected App — `POST /v2/oauthapp/register`

Admin-only. Registration returns the `clientId` and, **once only**, the `clientSecret`.

| Field | Type | Notes |
|---|---|---|
| `clientName` | string | **Required.** Display name of the app. |
| `redirectUris` | `[string]` | **Required.** Exact callback URLs. Must be HTTPS except for `localhost` / `127.0.0.1`. Matched by exact string (no prefix matching) during the flow. |
| `grantTypes` | `[string]` | Subset of `["authorizationCode", "refreshToken"]`. Default `["authorizationCode", "refreshToken"]`. |
| `clientType` | string | `"public"` (SPA / native / no secret storage) or `"confidential"` (a backend that can keep a secret). Default `"public"`. |
| `scopes` | `[string]` | Permission strings the app may request (for example `["Resource@Contact.find", "Resource@Deal.find"]`). If omitted, issued tokens inherit **all** of the authorizing user's permissions — so set this explicitly to constrain the app. |
| `pkceRequired` | boolean | Whether PKCE is mandatory. Public clients default to `true`. |
| `tokenExpirationDays` | number | Lifetime of issued access tokens. |

```bash
curl -X POST 'https://demos.prolibu.com/v2/oauthapp/register' \
  -H 'Authorization: Bearer <ADMIN_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "clientName": "Partner Portal",
    "redirectUris": ["https://partner.example.com/callback"],
    "grantTypes": ["authorizationCode", "refreshToken"],
    "clientType": "public",
    "scopes": ["Resource@Contact.find", "Resource@Deal.find"]
  }'
```

Response (`201`):

```json
{
  "clientId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "clientName": "Partner Portal",
  "redirectUris": ["https://partner.example.com/callback"],
  "clientType": "public",
  "pkceRequired": true,
  "scopes": ["Resource@Contact.find", "Resource@Deal.find"],
  "clientSecret": "a1b2c3d4e5f6...<64 hex chars — shown only here>",
  "clientSecretLastFour": "a1b2"
}
```

> **Store `clientSecret` immediately.** Like the API key, it is shown once and never returned again; later reads expose only `clientSecretLastFour`. Public clients don't need to store the secret (they authenticate with PKCE instead), but confidential clients must keep it.

### 3.2 The authorization-code flow (with PKCE)

The flow has four moving parts: the user's browser, your app, Prolibu's `authorize` endpoint, and Prolibu's `token` endpoint. Endpoint parameters accept **camelCase** (the Prolibu convention) and **snake_case** (the OAuth 2.0 spelling) interchangeably.

| Step | Endpoint | Purpose |
|---|---|---|
| 1 | (client-side) | Generate a PKCE `codeVerifier` and its `codeChallenge`. |
| 2 | `GET /v2/oauthgrant/authorize` | User approves; you receive a one-time `code`. |
| 3 | `POST /v2/oauthgrant/token` | Exchange `code` (+ `codeVerifier`) for `accessToken` + `refreshToken`. |
| 4 | any `/v2/*` endpoint | Call the API with `Authorization: Bearer <accessToken>`. |
| 5 | `POST /v2/oauthgrant/token` | Refresh: exchange `refreshToken` for a fresh pair. |
| 6 | `POST /v2/oauthgrant/revoke` | Revoke a token (RFC 7009). |

**Step 1 — PKCE (in the app):**

```js
import crypto from 'crypto';
const codeVerifier  = crypto.randomBytes(32).toString('base64url');
const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
// keep codeVerifier; send codeChallenge to /authorize
```

**Step 2 — Authorize.** Redirect the user's browser to `authorize`. With `Accept: text/html` and no bearer token, Prolibu renders its own login/consent screen; after the user signs in it 302-redirects to your `redirectUri` with `code` and `state` appended. For a machine-driven flow where the user is already authenticated with a Prolibu bearer token, the same endpoint returns JSON:

```bash
curl -G 'https://demos.prolibu.com/v2/oauthgrant/authorize' \
  -H 'Authorization: Bearer <USER_API_KEY>' \
  --data-urlencode 'responseType=code' \
  --data-urlencode 'clientId=f47ac10b-58cc-4372-a567-0e02b2c3d479' \
  --data-urlencode 'redirectUri=https://partner.example.com/callback' \
  --data-urlencode 'codeChallenge=<codeChallenge>' \
  --data-urlencode 'codeChallengeMethod=S256' \
  --data-urlencode 'state=xyz123'
```

Response (`200`):

```json
{
  "redirectUri": "https://partner.example.com/callback?code=<64 hex>&state=xyz123",
  "code": "<64 hex, single use>",
  "state": "xyz123"
}
```

**Step 3 — Token exchange.** A **public** client sends the `codeVerifier` (PKCE). A **confidential** client sends `clientSecret` as well.

```bash
curl -X POST 'https://demos.prolibu.com/v2/oauthgrant/token' \
  -H 'Content-Type: application/json' \
  -d '{
    "grantType": "authorizationCode",
    "code": "<code from step 2>",
    "clientId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "redirectUri": "https://partner.example.com/callback",
    "codeVerifier": "<codeVerifier from step 1>"
  }'
```

Response (`200`) — the token endpoint returns **both** camelCase and snake_case keys so either OAuth client library works:

```json
{
  "accessToken": "<bearer token>",
  "tokenType": "Bearer",
  "expiresIn": 604800,
  "refreshToken": "<64 hex>",
  "scopes": ["Resource@Contact.find", "Resource@Deal.find"],

  "access_token": "<bearer token>",
  "token_type": "Bearer",
  "expires_in": 604800,
  "refresh_token": "<64 hex>",
  "scope": "Resource@Contact.find Resource@Deal.find"
}
```

The `code` is single-use; replaying it returns `400`.

**Step 4 — Call the API.** The `accessToken` is a normal bearer credential: it works on **any** `/v2/*` endpoint the app is scoped for, not just OAuth endpoints.

```bash
curl -G 'https://demos.prolibu.com/v2/contact' \
  -H 'Authorization: Bearer <accessToken>' \
  --data-urlencode 'limit=5'

# Who is this token for?
curl 'https://demos.prolibu.com/v2/oauthgrant/userinfo' \
  -H 'Authorization: Bearer <accessToken>'
# → { "sub": "<userId>", "name": "Jane Partner", "email": "jane@example.com", "picture": null }
```

**Step 5 — Refresh (rotates both tokens).** The old `refreshToken` is revoked and a new access/refresh pair is issued. Store the new `refreshToken`; replaying the old one returns `400`.

```bash
curl -X POST 'https://demos.prolibu.com/v2/oauthgrant/token' \
  -H 'Content-Type: application/json' \
  -d '{
    "grantType": "refreshToken",
    "refreshToken": "<current refreshToken>",
    "clientId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  }'
# → 200 with a NEW accessToken and a NEW refreshToken
```

**Step 6 — Revoke (RFC 7009).** Revoking an unknown or already-revoked token is **not** an error (still `200`).

```bash
curl -X POST 'https://demos.prolibu.com/v2/oauthgrant/revoke' \
  -H 'Content-Type: application/json' \
  -d '{ "token": "<accessToken or refreshToken>", "tokenTypeHint": "accessToken" }'
# → 200 { "revoked": true }
```

### 3.3 OAuth endpoint reference

| Endpoint | Method | Purpose |
|---|---|---|
| `/v2/oauthapp/register` | `POST` | Register a Connected App (admin-only); returns `clientSecret` once. |
| `/v2/oauthgrant/authorize` | `GET` | Start the flow; returns/redirects with a one-time `code`. |
| `/v2/oauthgrant/token` | `POST` | Exchange `authorizationCode` or `refreshToken` for tokens. |
| `/v2/oauthgrant/revoke` | `POST` | Revoke an access or refresh token (RFC 7009). |
| `/v2/oauthgrant/userinfo` | `GET` | OpenID-style profile for the bearer token (`sub`, `name`, `email`, `picture`). |
| `/v2/oauthgrant/metadata` | `GET` | Public authorization-server metadata (RFC 8414). |

### 3.4 Parameters accepted by `authorize` / `token`

| camelCase | snake_case | Where | Notes |
|---|---|---|---|
| `responseType` | `response_type` | authorize | Must be `code`. |
| `clientId` | `client_id` | authorize, token | The registered app. |
| `redirectUri` | `redirect_uri` | authorize, token | Must exactly match a registered `redirectUris` entry. |
| `codeChallenge` | `code_challenge` | authorize | PKCE challenge. |
| `codeChallengeMethod` | `code_challenge_method` | authorize | Only `S256` is supported. |
| `state` | `state` | authorize | Opaque value echoed back to your callback. |
| `grantType` | `grant_type` | token | `authorizationCode` or `refreshToken`. |
| `code` | `code` | token | The one-time authorization code. |
| `codeVerifier` | `code_verifier` | token | PKCE verifier (public clients). |
| `clientSecret` | `client_secret` | token | Required for confidential clients. |
| `refreshToken` | `refresh_token` | token | Used with `grantType: refreshToken`. |

### 3.5 Discovery — `GET /v2/oauthgrant/metadata`

Returns RFC 8414 authorization-server metadata so OAuth libraries can auto-configure. Works even when the OAuth server is otherwise disabled.

```bash
curl 'https://demos.prolibu.com/v2/oauthgrant/metadata'
```

```json
{
  "issuer": "https://demos.prolibu.com",
  "authorizationEndpoint": "https://demos.prolibu.com/v2/oauthgrant/authorize",
  "tokenEndpoint": "https://demos.prolibu.com/v2/oauthgrant/token",
  "revocationEndpoint": "https://demos.prolibu.com/v2/oauthgrant/revoke",
  "userinfoEndpoint": "https://demos.prolibu.com/v2/oauthgrant/userinfo",
  "responseTypesSupported": ["code"],
  "grantTypesSupported": ["authorizationCode", "refreshToken"],
  "codeChallengeMethodsSupported": ["S256"],
  "tokenEndpointAuthMethodsSupported": ["clientSecretPost", "none"]
}
```

---

## 4. Outbound: connected apps & the secure credential store

When **Prolibu needs to call a SaaS**, there are two patterns depending on whether the third party uses a static API key or per-user OAuth.

### 4.1 Static third-party API keys — `POST /v2/servicecredential`

This is the **Named Credentials / External Credentials** analog: store a provider's static secret in the account's secure credential store instead of hardcoding it in automation. Secrets are encrypted at rest and access is controlled **per record** (see [Security & Permissions](10-security-and-permissions.md)). Your automation and AI features reference a credential **by id**; the secret is never exposed back to callers or embedded in code.

| Field | Type | Notes |
|---|---|---|
| `serviceCredentialName` | string | **Required.** Display name. |
| `providerType` | string | One of `openai`, `anthropic`, `deepseek`, `twilio`, `sendgrid`, `google`. |
| `priority` | number | Selection order when several credentials match (lower = tried first). |
| `active` | boolean | Only active credentials are used. |
| `<providerType>` | object | A provider-specific sub-object holding the secret(s) — see below. |
| `assignee` / `collaborators` / `allowEveryone` | (access control) | Who may use this credential. Same record-level access model as business objects. |

Provider sub-objects (send only the one matching `providerType`):

```
openai:    { apiKey, organizationId }
anthropic: { apiKey }
deepseek:  { apiKey }
twilio:    { accountSid, authToken, apiKey, apiSecret }
sendgrid:  { apiKey }
google:    { apiKey, projectId }
```

The secret fields (for example `openai.apiKey`, `twilio.authToken`) are encrypted at rest; non-secret metadata such as `openai.organizationId` and `google.projectId` is stored in the clear.

```bash
curl -X POST 'https://demos.prolibu.com/v2/servicecredential' \
  -H 'Authorization: Bearer <ADMIN_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "serviceCredentialName": "OpenAI Production",
    "providerType": "openai",
    "priority": 1,
    "active": true,
    "openai": { "apiKey": "sk-proj-...", "organizationId": "org-abc123" }
  }'
```

Response (`201`) — the secret comes back **encrypted**, never in plaintext; the non-secret `organizationId` is echoed as-is:

```json
{
  "_id": "6501a2b3c4d5e6f708091a2b",
  "serviceCredentialName": "OpenAI Production",
  "providerType": "openai",
  "priority": 1,
  "active": true,
  "openai": { "apiKey": "<encrypted>", "organizationId": "org-abc123" }
}
```

Now your automation or AI configuration points at `_id` `6501a2b3c4d5e6f708091a2b`; the platform decrypts and uses the secret at call time. You never handle the plaintext again, and the secret never appears in a script, a webhook payload, or a request body. See [Automation & Scripts](05-automation-and-scripts.md) for how a script references a stored credential, and [Connecting External Services](09-connecting-external-services.md) for provider-specific setup.

### 4.2 Per-user OAuth to Google / Microsoft / HubSpot (Auth Providers)

When Prolibu must act **as a specific user** against Gmail, Microsoft Graph, or HubSpot (send mail as them, read their calendar), each user connects their own account through the Auth Providers surface. Prolibu stores the resulting per-user tokens securely and refreshes them automatically before they expire — you don't manage the raw `accessToken`.

| Endpoint | Method | Purpose |
|---|---|---|
| `GET /v2/oauth/getproviders` | `GET` | List available providers and whether the current user is `connected`. |
| `GET /v2/oauth/connect` | `GET` | Render the connect screen to start a provider's OAuth flow. |
| `DELETE /v2/oauth/disconnect/{provider}` | `DELETE` | Disconnect the current user from a provider. |

```bash
curl 'https://demos.prolibu.com/v2/oauth/getproviders' \
  -H 'Authorization: Bearer <USER_API_KEY>'
```

```json
[
  { "provider": "google",    "connected": true,  "scopes": ["gmail.send", "calendar.events"] },
  { "provider": "microsoft", "connected": false },
  { "provider": "hubspot",   "connected": false }
]
```

An administrator must enable each provider in the account's security preferences before users can connect. Because these tokens are per-user, an integration that relies on them only works for users who have connected — check `connected` before assuming access.

---

## Common pitfalls

1. **Two different "OAuth" systems.** The Connected App / OAuth server (§3) is where Prolibu **issues** tokens to other apps that consume *you*. Auth Providers (§4.2) are where Prolibu **obtains** tokens to consume *Google/Microsoft/HubSpot*. Don't confuse them because both say "OAuth".
2. **Secrets are shown once.** `apiKey` (on a token) and `clientSecret` (on a Connected App) appear only in the creation response. Later reads return only `apiKeyLastDigits` / `clientSecretLastFour`. Capture them at creation or reissue.
3. **The OAuth `accessToken` is a full bearer credential.** It works on any `/v2/*` endpoint the app is scoped for, not just `/oauthgrant/*`. Scope your Connected App (`scopes`) to limit its reach — otherwise issued tokens inherit *all* of the authorizing user's permissions.
4. **`redirectUri` is matched exactly.** Exact string, not a prefix, in both `authorize` and the token exchange. Register every callback URL you use, and use HTTPS (only `localhost` / `127.0.0.1` may be plain HTTP).
5. **PKCE is `S256` only.** Public clients require a `codeChallenge`; omitting it fails `authorize` with `400`. Generate the `codeVerifier` per authorization and keep it until the token exchange.
6. **The authorization `code` and each `refreshToken` are single-use.** Refresh rotates both tokens; the old `refreshToken` is revoked. Always persist the newest `refreshToken` from the refresh response, or the next refresh returns `400`.
7. **Confidential vs public.** A confidential client must send `clientSecret` on the token exchange (missing → `400`, wrong → `401`). A public client authenticates with PKCE instead and must not embed a secret.
8. **The OAuth server may be disabled.** If `register` / `authorize` / `token` return `403`, an administrator has not enabled the OAuth server in security preferences. `metadata` still responds.
9. **Never hardcode third-party secrets.** Store them in `serviceCredential` (encrypted, record-level access) and reference by id. Don't paste provider keys into scripts, webhook payloads, or request bodies.
10. **Least privilege for API keys.** Grant the narrowest `scopes` (`Resource@<Model>.<fn>`) the integration needs. A read-only pipeline should not hold a `create`/`delete` scope. Non-admins can only grant scopes they already hold.
11. **Rate limits apply per token.** A busy integration can hit the per-minute ceiling and get `429`; back off and retry, and split heavy workloads across purpose-specific tokens.
12. **Resource paths are lowercase.** It's `/v2/oauthapp`, `/v2/oauthgrant`, `/v2/servicecredential`, `/v2/token` — even though the JSON fields are camelCase.

## Checklist

**Inbound — an external system authenticates to Prolibu:**
- [ ] Simple backend or pipeline? Create a `token` with `tokenType: "API"` and a required `appName`, grant the **minimal** `scopes`, and send `Authorization: Bearer <apiKey>`.
- [ ] Captured the plaintext `apiKey` at creation (it is never returned again).
- [ ] Third-party app acting on behalf of a user (AI assistant / MCP / partner backend)? Ask an admin to enable the OAuth server, `POST /v2/oauthapp/register`, and store the one-time `clientSecret`.
- [ ] Used PKCE (`S256`) for public clients; registered exact HTTPS `redirectUris`.
- [ ] Constrained the Connected App with explicit `scopes` (otherwise tokens inherit all of the user's permissions).
- [ ] Implemented refresh (rotates both tokens — persist the new `refreshToken`) and revoke (RFC 7009).
- [ ] Remembered the OAuth `accessToken` is a normal bearer token usable on any `/v2/*` endpoint.

**Outbound — Prolibu calls a third party:**
- [ ] Static API key (OpenAI / Twilio / SendGrid / etc.)? Created a `serviceCredential`, set `providerType` and the provider sub-object, and configured record-level access (`assignee` / `collaborators` / `allowEveryone`).
- [ ] Automation references the credential **by id** — no plaintext secret in any script, payload, or request body.
- [ ] Per-user Google/Microsoft/HubSpot access? Confirmed an admin enabled the provider, and each user connected via `/v2/oauth/*`; checked `connected` before assuming access.
- [ ] Filtered credentials by `active: true` and relied on `priority` for selection order.

Related: [REST API](03-rest-api.md) · [Automation & Scripts](05-automation-and-scripts.md) · [Connecting External Services](09-connecting-external-services.md) · [Security & Permissions](10-security-and-permissions.md).
