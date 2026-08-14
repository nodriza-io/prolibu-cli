---
name: prolibu-endpoints
description: Expose a custom inbound HTTP endpoint on a Prolibu account — a public or authenticated URL that runs one of your Scripts and returns its result. Covers the Endpoint resource, the invocation URL, authentication and role gating, the exact success and failure response shapes, receiving third-party webhooks, and proxying a paid third-party API so its key never reaches the browser. Use it whenever the task involves building an inbound API, a webhook receiver, a callback URL, or letting a browser or external system trigger server-side logic on a Prolibu account.
---

# Prolibu Endpoints

## Read the reference first

**Before creating an endpoint, read
`docs/integrations-for-ai-agents/07-sites-forms-and-endpoints.md` §1.** It is the complete,
verified source: the resource, the invocation URL, authentication behavior, what the script
receives, every response shape, and webhook receivers. For the API-proxy pattern read Recipe 7 in
`docs/integrations-for-ai-agents/12-integration-recipes.md`.

An endpoint is only the front door — the logic is a Script. Read the `prolibu-scripts` skill
before writing the handler; its sandbox has constraints that rule out some designs.

Do not work from memory and do not duplicate that content here.

## Shape of the contract

```
https://<domain>/v2/endpoint/{method}/{routeName}      # method segment lowercase
```

Success is always the envelope — clients must read `response.output`, not the top level:

```json
{ "authenticated": true, "output": <whatever the script assigned> }
```

Failures are **not** that envelope. They are `{ statusCode, error }`:

| Situation | Status |
|---|---|
| Script threw, rejected, or timed out | `400` |
| `authentication.enabled` and no/invalid credential | `401` |
| Authenticated but missing a `requiredRoles` role | `403` |
| Unknown `routeName`, or endpoint inactive | `404` |
| Rate limited | `429` |

## Rules that are easy to get wrong

**Give every endpoint a globally unique `routeName`.** Dispatch resolves by name alone and
ignores the method segment, so a `POST` endpoint also answers `GET /v2/endpoint/get/<routeName>`.
The model only rejects a duplicate name **+** method pair, so two endpoints can share a name and
one becomes unreachable. Use `thing-pull` / `thing-push`, not one `thing` per verb.

**A thrown message reaches the caller verbatim.** Return expected failures as data
(`output: { ok: false, reason }`) and reserve `throw` for the exceptional — and never throw a
provider's raw error or anything containing a credential.

**`authentication.enabled` defaults to `true`.** Set it to `false` deliberately for webhook
receivers and open APIs, and understand that this makes the URL callable by anyone.

**You cannot verify a webhook signature.** The sandbox has no `crypto` and no base64, so HMAC
schemes are out. Authenticate third-party senders with a static shared-secret header compared
against a value in the script's `variables`, and answer a mismatch with `output`, not a throw —
a `400` tells a prober it found a real route. Treat the payload as untrusted and prefer
re-fetching the object from the provider by id.

**The caller's API key is never passed into the sandbox.** An authenticated call gives the script
`requestUser` so it can decide *who* is asking; to *act* on the account it uses its own
least-privilege key from `variables`.

## When to reach for this

Use an endpoint whenever something outside the platform must trigger logic inside it, and
whenever a secret must stay server-side while a browser or third party benefits from it — the
endpoint holds the credential in its script, so the client never sees it. That is the only
pattern where a key is genuinely protected: anything shipped in a page bundle is public.
