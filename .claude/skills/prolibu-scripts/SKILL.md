---
name: prolibu-scripts
description: Write, deploy and debug a Prolibu Script — server-side JavaScript that runs on demand, on a record create/update/delete event (lifecycle hook), on a cron schedule, or behind a custom Endpoint. Covers what the sandbox does and does not provide, how to return a result, where credentials live, and how a script reads or writes account data. Use it whenever the task involves platform automation, a trigger on a record, a scheduled job, a webhook handler's logic, or when a script fails with a timeout, a ReferenceError, or "is not defined".
---

# Prolibu Scripts

## Read the reference first

**Before writing any `code`, read `docs/integrations-for-ai-agents/05-automation-and-scripts.md`.**
It is the complete, verified source: the `Script` resource, the execution model, the full sandbox
allow-list, the three trigger modes, the variables store, data access and the run-result shape.

Do not work from memory and do not duplicate that content here.

## The sandbox is smaller than you expect

This is the single biggest source of wasted work: code is written against assumptions that do not
hold, and the failure only appears at run time.

**Available:** `axios`, `console.{log,error,warn,info}`, `setVariable`, `variables`, `output`,
`eventName`, `eventData`, `localDomain`, `env`, `scriptCode`, `locale`, `lifecycleHooks`,
`setTimeout`/`setInterval`/`setImmediate` and their `clear*`, `URLSearchParams`, and the standard
built-ins (`JSON`, `Date`, `Math`, `Promise`, `Error`, `RegExp`, `Intl`).

**Absent:** `require` (so **no npm packages at all** — no lodash, no date library, no vendor SDK),
`fetch`, `process`, `global`, `module`, `Buffer`, `crypto`, `btoa`/`atob`/`TextEncoder`.

Two consequences change architecture rather than syntax:

- **No `crypto` and no base64** ⇒ a script cannot compute an HMAC, verify a provider's webhook
  signature, or build a `Basic` auth header. Authenticate inbound callers with a static shared
  secret in a header; for outbound, use token/header auth or pre-compute the encoded value into
  `variables`.
- **No `require`** ⇒ every integration is a hand-written `axios` call. There is no SDK to reach for.

## Rules that are easy to get wrong

**The result is whatever you assign to `output`, not what you return.** `return {...}` alone
yields `output: null`. Wrap I/O in an async IIFE and assign `output` at the end.

**`requestUser` is undefined, not null, when the caller is anonymous.** A bare reference throws a
`ReferenceError` — guard with `typeof requestUser !== 'undefined'`.

**Secrets live in `Script.variables`, and only there.** `ServiceCredential` is not reachable from
a script: it comes back encrypted over REST and the sandbox has no decrypt primitive. Note that
`variables` are stored in clear text on the record, so restrict who can read the script.

**`variables` is a start-of-run snapshot.** A value written with `setVariable` is visible on the
*next* run, not the current one. Values are strings — serialize accordingly.

**There is no database access.** Read and write account data over your own REST API with `axios`,
using a least-privilege key from `variables` and building the base URL from `localDomain`. The
script acts with that key's permissions, not the caller's.

**A thrown message is echoed to the caller** when the script runs behind an Endpoint. Never throw
a provider's raw error or anything containing a credential; log it with `console.error` and throw
something generic, or return the failure as data in `output`.

**Nothing runs unless `active: true`,** and lifecycle hooks additionally require the object to be
enabled for triggers at the account level — both are off by default.
