---
name: prolibu-platform-map
description: Start here for any Prolibu account task. Routes the request to the right Prolibu skill (account setup, sites, scripts, endpoints, forms, webhooks, external ids, imports, custom fields, catalog, quotes, proposals, stages, commercial exceptions, calendars, billing, contracts, leads, scoring, the public quoter, projects and work orders, ads, data cleanup, access review, document designs, academy, list columns and saved filters, moving configuration between accounts, activities, support, messaging, conversations, dashboards, AI agents, virtual tours, diagnostics), maps business words to Prolibu objects and modules, and gives the safe procedure to read or write any other object through the API (schema first, then the write flow). Use it whenever someone asks what Prolibu has or "how does X work in Prolibu", wants to work with an object no other Prolibu skill covers (invoices, payments, custom objects…), or a call returns every record, 400 on a populate or sort, or a filter that seems ignored. Spanish triggers: "qué objetos tiene Prolibu", "cómo funciona", "qué módulo", "crear un registro", "consultar por API".
---

# Prolibu platform map

## Central idea

This skill is the entry point. It does three things:

1. **Routes** the request to the skill that knows that task (table below). When one fits,
   use it: it holds the tested recipe and the traps.
2. **Names the object.** `references/modules.md` lists every standard object by module, with
   its API path and one line on what it is for. Use it to turn a business request ("register
   a payment", "open a support case") into an object.
3. **Handles every other object** with one safe procedure: read the object's schema, then
   follow the write flow. The rules every API call obeys (filters, paging, `populate`,
   `PATCH`, errors) are in `references/api-conventions.md`.

Answer in the user's language. Object names, API paths and field names stay as written.

## Which skill to use

| The user wants to… | Skill |
| --- | --- |
| Publish a website, landing page or single-page app on the account: check the build, publish with read-back, roll back, gate or take down | `prolibu-sites` |
| Run code on record events, on a schedule or on demand | `prolibu-scripts` |
| Expose a custom URL or receive another system's webhook | `prolibu-endpoints` |
| Build or change a web form, or route ad lead forms | `prolibu-forms` |
| Notify an external system when records change | `prolibu-webhooks` |
| Connect the CLI to an account: API key, import/pull an account repo, check the key and its permissions, connect the account's MCP server to Claude Code | `prolibu-account-setup` |
| Store another system's id or link on records | `prolibu-external-refs` |
| Import contacts, companies or deals from a CSV or Excel file without duplicates, change one field on many records, or read an import's result | `prolibu-imports` |
| Add fields to an object, or create a Custom Object | `prolibu-custom-fields` |
| Create or update products, price lists and their prices, taxes, volume discounts or coupons, or load a catalog from Excel | `prolibu-catalog` |
| Add, change or remove products on a deal's quote, or set discounts that expire (Real-Time or Limited-Time) | `prolibu-quotes` |
| Turn a deal's proposal on or change its template, save or restore proposal versions, write contract templates, or generate a deal's contract ready for e-signature | `prolibu-proposals` |
| Build a product picker or configurator inside the quote editor; which site each workspace gets | `prolibu-extended-quote-sites` |
| Move records between pipeline stages, or understand a pipeline | `prolibu-stages` |
| Log tasks, notes, meetings or calls on a contact, company or deal, or read a record's activity history | `prolibu-activities` |
| Open, find, assign or answer support tickets; case types, routing, the support mailbox; help articles and the portal | `prolibu-support` |
| Build e-mail templates with variables, contact lists or e-mail campaigns; test, launch, schedule or pause one | `prolibu-messaging` |
| Build or change a report or dashboard (KPIs, charts, several reports, goals vs. actuals), or find why one shows zeros | `prolibu-dashboards` |
| Create or change a native AI agent (instructions, model, skills, actions) and the triggers that run it on a schedule or a record event | `prolibu-ai-agents` |
| Create, update or download virtual tours (car configurators, 360° spaces) | `prolibu-virtual-tours` |
| See why a product rule blocks a quote; request, edit, withdraw, approve (or counter) or reject a commercial exception; check it reached the quote; create or edit product rules | `prolibu-commercial-exceptions` |
| Set up a bookable calendar (hours, closed dates, rotation, units), check free slots, book, reschedule, cancel or confirm appointments, or diagnose a deal's bookings | `prolibu-calendars` |
| Invoice a won deal or by hand, record or remove payments, emit or void invoices, see receivables and billing metrics (subscriptions and payment methods read only) | `prolibu-billing` |
| Send a Draft contract for e-signature, see who still has to sign, remind pending signers, withdraw a sent contract, or download the original or signed PDF | `prolibu-contracts` |
| Read or summarize a contact's or deal's WhatsApp/SMS conversations, reply with text or an approved template, assign a chat, hand it back to the AI agent, or write conversation flows | `prolibu-conversations` |
| Triage, assign or convert leads without duplicates; follow-up protocols and why a sequence e-mail did not go out; sellers' goals | `prolibu-leads` |
| Explain a contact's or deal's score, create or edit a rules scoring profile, activate it, re-score named records | `prolibu-scoring` |
| Set up the public self-service quoter (/pw): wizards, wizard groups, assignment group, links and QR; diagnose quotes that did not arrive | `prolibu-proposal-wizard` |
| Find out why something did not happen or who changed what: script runs, webhooks, e-mail status, missed notices, sign-in failures, audit log, a record's history (read only) | `prolibu-diagnostics` |
| Projects of tasks (gantt, members, working days, timeline) and work orders: create, status, overdue tasks, reschedule | `prolibu-projects` |
| Meta / Facebook / Instagram ad leads: why they do not arrive, who receives them, leads per campaign, workspace per page, stage events to Meta | `prolibu-ads` |
| Duplicate contacts or companies: find, merge, tag stale contacts as archived | `prolibu-data-cleanup` |
| Who can see or do what: a user's roles and permissions, "can U open R and why not", who sees a record, admins, sign-in rules (read only) | `prolibu-access-review` |
| Proposal and document designs (templates, snippets, default layout, fonts), custom views for sharing a proposal, who viewed a presentation | `prolibu-document-design` |
| Academy: programs, courses, lessons, publish, enroll, who has not finished, missing certificates | `prolibu-academy` |
| Default list columns, saved or shared filters, menu links, row actions, field and cell widgets | `prolibu-ui-customization` |
| Move or compare configuration between accounts (dev to prod): scripts, endpoints, forms, webhooks, templates, stages, filters | `prolibu-config-promotion` |
| Create a new skill, or rebuild one that does not work | `prolibu-skill-creator` |
| Anything else: find, create or change records of any other object | This skill: Steps below |

A request can need two skills (for example a form whose leads go to an external CRM:
`prolibu-forms`, then `prolibu-webhooks`). Do them one after the other.

## Ask the user first

1. **Which account?** If there are several domains under `accounts/`, ask which one.
2. **What, in business terms?** Which records, which values, and how they recognize the
   record ("the deal called…", "the contact with email…").
3. **Read or change?** A read needs no confirmation. Any change follows the write flow.

## Steps (an object with no dedicated skill)

1. **Find the object** in `references/modules.md`. If the request does not map to one object,
   ask; do not guess between two.
2. **Check it exists on this account and read its fields.** Modules are switched on per
   account, so read the object's own OpenAPI entry (a few hundred KB, never the full 10 MB
   document):

   ```bash
   node .claude/skills/_shared/prolibu-api.js <domain> GET /v2/openapi/specification/<path> \
     > "${TMPDIR:-/tmp}/openapi-<path>.json"
   ```

   The create fields are under
   `body.paths["/v2/<path>/"].post.requestBody.content["application/json"].schema.properties`.
   For which fields are writable, read `modelSchemas.<ModelName>` from `GET /v2/user/me`
   (`avoid: always` = set by the platform). If the path is missing, the object is not enabled
   on that account: say so and stop. Never guess a field name.
3. **Find the records** with a list call: `GET /v2/<path>?xquery=…&select=…&sort=…&limit=…`,
   or `GET /v2/<path>/search?term=<text>`. Check `pagination.count`: a misspelled filter is
   dropped and returns every record.
4. **Resolve references** to `_id` strings: look the related record up first (the contact's
   `_id`, not its name or the whole object).
5. **Summarize and ask.** Say in plain words what will be created or changed, in which
   account, and wait for an explicit yes. Changes to existing records need their own yes.
6. **Write** with the helper and `--confirmed`. A `PATCH` sends only the fields that change.
7. **Read back** the record by `_id` and give the user the id and the values saved.

## How the platform behaves

The details, with examples, are in `references/api-conventions.md`. The ones that bite most:

- **Silent drops.** Unknown fields, misspelled filters, malformed `xquery` and a second
  operator on the same field (`$gte` with `$lte`) are dropped without an error. Use `$and` for
  ranges and check counts.
- **Case-insensitive search is inline:** `{"$regex": "(?i)text"}`. A separate `$options`
  answers 400.
- **`populate=*` is one level deep.** For a reference of a reference, use `populatePath` in
  tree form. A `populate` of a field that is not in the schema fails the whole call with 400.
- **References are `_id` strings,** also in `customFields`. An object gives 400. A wrong id
  is saved anyway and reads back as `null`.
- **`PATCH` merges plain objects** but **replaces arrays and `mixed` fields whole.**
- **Errors** are `{statusCode, error}` in the account's language. Act on the status code.
- **Account preferences** are readable only by admins (`/v2/preference/read`); everyone can
  read the resolved settings at `/v2/user/preferences`.

## Core relationships

- **Deal → Contact and Company.** A deal points to one `contact` and one `company`. A contact
  also points to its `company`.
- **Deal → Quote → lines.** The quote is not a separate record: it lives inside the deal, in
  `proposal.quote`, with its lines in `lineItems`. Change it only with `prolibu-quotes`: a
  save replaces the whole quote.
- **Deal → ProposalVersion.** Saved versions of a deal's proposal. The deal lists them in
  `proposalVersions.refs`; each version points back through `dealSource`.
- **Deal → Invoice, Contract.** A deal lists its `invoices` and `contracts`; an invoice
  points back through `originDeal`.
- **Ticket → Contact, Company, Deal.** A support case points to its requester contact and
  company, and may point to a deal.
- **Presentation → Contact.** A presentation points to a `contact` and a `layout` template.
  It has no link to a deal.
- **Pipelines.** A record's `stage` points to a Stage of that object's pipeline. Moving it
  has side effects (required fields, stage history, notifications): use `prolibu-stages`.

Every record also carries `_id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`,
`workspace`, `refId` and `refUrl` (table in `references/api-conventions.md`).

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| A filtered list returns every record | Misspelled field, `searchTerm` on a list, or malformed `xquery` | Check the field name in the schema; use `/search?term=`; build `xquery` with `JSON.stringify` |
| A date range returns too much | Two operators on one field; the server kept one | `$and` with one condition each |
| `400 $options needs a $regex` | Separate `$options` | Inline `(?i)` in `$regex` |
| `400 Cannot populate '<x>'…` | Field not in the schema | Fix the name, or use `populatePath` |
| `400 Sort field does not exist` | Space-separated sort, or a wrong field | Commas: `sort=-updatedAt,name` |
| `400 Document not found by primaryKey '[object Object]'` | A reference sent as an object | Send its `_id` string |
| A nested reference shows as an id | `populate=*` is one level | `populatePath` tree |
| A field "did not save" | Not in the schema, or set by the platform | Read the schema; read the record back |
| `403` | The key's user may not do this | Tell the user; never retry another way |
| The path is not in the OpenAPI document | Module not enabled on the account | Say so and stop |

## Verify

- After every write, read the record back by `_id` and compare the fields you sent.
- After a list, compare `pagination.count` with what you expected before acting on it.

## Don't

- Use an object's API without reading its schema first.
- Create, change or delete these through a skill, or read their secrets: `Token`,
  `ServiceCredential`, `User`, `Role`, `AuthenticationRule`, `OauthApp`, `OauthGrant`,
  `McpSession`, `SyncConnection`, `ChannelProvider`, `EmailHub`, `ConfirmationCode`, the
  Subscriptions module (`Account`, `Deployment`, `Pool`, `SubscriptionPlan`), and the account
  preferences. They hold keys, credentials, sign-in or access rules. Tell the user to use the
  Prolibu app or ask an admin, and stop. A skill may only read what it needs and holds no
  secret, with a fixed field list:
  - your own user and the account switches: `GET /v2/user/me`, `GET /v2/user/preferences`;
  - names, not credentials: users and roles by name (to assign or check access), whether a
    credential or mailbox exists and which models it offers (`prolibu-ai-agents`,
    `prolibu-forms`, `prolibu-support`), sync coverage (`prolibu-external-refs`);
  - an MCP tool call records an `McpSession` by itself; that is allowed (`prolibu-dashboards`).
  Never print or copy a key, token, password, secret or authorization header.
- Write a deal's quote, move a stage, or create custom fields by hand: use their skills.
- Bulk-change records without showing the user how many will change.
- Print values of fields that look like secrets (`password`, `token`, `headers`, `variables`)
  from any record.

## Writing to an account

Every read and write goes through the helper and the six steps in
[`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads only, plain-language
summary, explicit confirmation, write, read back. When a skill has its own script, use it
instead of hand-made calls.
