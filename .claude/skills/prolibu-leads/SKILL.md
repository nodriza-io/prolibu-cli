---
name: prolibu-leads
description: Work Prolibu leads the way the app does — triage them through the Lead pipeline, share them out between sellers by turns (round robin computed here, the user group is never rewritten), convert a lead into a contact without creating a duplicate (e-mail, phone and similar-name checks the server lacks) and keep it with the seller who worked it; read a contact's re-contact history (submissions); create and edit follow-up protocols (the call / WhatsApp / e-mail steps shown as a badge on boards), diagnose why a badge or a sequence e-mail did or did not happen, and pause a running sequence; load sellers' goals (quotas) per period without duplicates. Use it whenever someone asks to qualify, discard, assign or convert leads, asks who should get the new leads, wants a contact's submissions, wants a follow-up protocol or cadence, asks why a sequence e-mail never arrived or a badge is missing, or wants to load or change sales goals. Spanish triggers: "leads nuevos", "convierte el lead", "reparte los leads", "por turnos", "calificar lead", "descartar lead", "recontactos", "protocolo de seguimiento", "secuencia de correos", "no le llegó el correo", "pausar la secuencia", "metas de ventas", "cuotas de los vendedores".
---

# Prolibu Leads

## Central idea

A **Lead** is raw interest that is not yet a customer. It lives in its own pipeline:
New (no stage) → Reviewing → Qualified → Discarded, and **Converted**. Converting creates a
**Contact** in the same save. The server only refuses a conversion when a contact already has
the exact same e-mail; a lead with the same phone or name becomes a duplicate. It also makes
the converting user the owner of the lead and the new contact. After that the lead is frozen:
moving it or setting `converted: false` answers OK and changes nothing.

A **ContactProtocol** is a follow-up guide for one pipeline (Contact, Deal or Call) and its
stages: steps (call, WhatsApp, e-mail) with a delay each. Boards show it as a badge that turns
red when a step is overdue. It sends nothing by itself. Only an e-mail campaign with a
sequence enrolls contacts in a **cadence**, and then only its e-mail steps are sent. A
**Goal** is one seller's target for one period. The server allows any number of goals for
the same seller and month.

`scripts/leads.js` does all of this in code: duplicate checks, round robin, owner hand-back,
protocol rules, cadence diagnosis and goal dedupe.

```
node .claude/skills/prolibu-leads/scripts/leads.js <command> <domain> …
  leads <domain> [--stage new|reviewing|qualified|discarded|converted] [--source s] [--assignee email] [--search text]
  show <domain> <lead e-mail|id>             lead + duplicate check
  submissions <domain> <contact e-mail|id>   re-contact history
  protocols <domain> [--entity Contact|Deal|Call]
  diagnose <domain> <contact e-mail|id> [--entity Contact|Deal|Call]
  goals <domain> [--period YYYY-MM] [--assignee email]
  preview <domain> '<plan>'  →  apply <domain> '<plan>' --version <v> --confirmed [--reaches-people]
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written). Every command takes `--profile <name>`. Plans go inline in single quotes,
or as a path to a temp file.

## Ask the user first

1. **Which account.** If `accounts/` has several domains, ask.
2. **Which leads:** e-mails, or a filter (stage, source, unassigned).
3. **To convert:** who owns the new contact. Default: the lead's owner.
4. **To share out leads:** a user group or a list of sellers, and who goes first.
5. **For a protocol:** pipeline (Contact, Deal or Call), stages, country or all countries,
   each step with its delay, an e-mail subject and template per e-mail step, approved
   WhatsApp templates.
6. **For goals:** seller e-mail, period, target value, currency (default: the account's).

## Steps

**Triage.** List with `leads`, then preview
`{"kind":"triage","leads":["lead@example.com"],"stage":"qualified"}` (`new` clears the stage).
Moving to Converted is refused here: use a convert plan.

**Share out by turns.**
`{"kind":"assign","filter":{"stage":"new","source":"Fair","unassigned":true},"group":"<group name|id>"}`,
or `"users":["seller1@example.com","seller2@example.com"]` instead of `group`, plus `"startAt":"seller2@example.com"`. Only
active users get leads, in the group's order. The preview has `perUser` counts. Up to 200
leads per plan; a larger filter says how many remain.

**Convert.** First run `show` and tell the user what it found.

```json
{"kind": "convert", "leads": ["ana@example.com"], "owner": "keep"}
```

`owner` is `keep` (the lead's owner), `me`, or a user e-mail. The preview blocks an exact
e-mail match. It also blocks phone, other-e-mail or similar-name matches. If the user says one
of them is a different person, add its id to `"differentFrom": ["<contactId>"]`. If it is the
same person, do not convert: work on the existing contact instead. Ask it as a closed
question with two named options ("¿Es la misma persona que <contacto>? Responde «misma» o
«distinta»"); a bare "sí" or "adelante" is not an answer, ask again. The preview lists
`recipients`: the key's user and the new owner get in-app notices. Stop there. After a yes to
those recipients, run `apply … --confirmed --reaches-people`. It converts, hands the contact
to the owner, and reads both records back. The lead's description becomes a note on the
contact.

**Re-contacts.** `submissions <domain> <contact>` lists each form or ad submission: sequence
(1 = first arrival, 2+ = came back), source and campaign.

**Protocol.** Preview a plan with the full step list. The script turns each `delay`
("30m", "2h", "3d") into milliseconds and creates the protocol **inactive**.

```json
{"kind": "protocol", "set": {"contactProtocolName": "Qualified follow-up", "entity": "Contact",
  "stages": ["Qualified"], "country": null, "flow": [
  {"actionType": "call", "actionName": "Call today", "delay": "0d"},
  {"actionType": "whatsapp", "actionName": "WhatsApp tomorrow", "delay": "1d", "messageTemplate": "<approved template>"},
  {"actionType": "email", "actionName": "E-mail in 3 days", "delay": "3d", "subject": "…", "messageTemplate": "<e-mail template>"}]}}
```

To edit, add `"id": "<id or CTP- code>"` and send only the changed fields (`flow` goes
whole). Turning it on is a separate plan, `{"kind":"protocol","id":"…","set":{"active":true}}`,
with its own yes. Say whether the account's protocol preference is on: if it is off, boards
show no badge. An admin turns it on in the app settings.

**Diagnose.** `diagnose <domain> <contact>` (or `--entity Deal|Call <id>`) explains the
badge: which protocol the board picks, each step done, pending or overdue. For a contact in a
cadence it lists each step's e-mail and why a step was not sent. Explain it in plain words and
offer the fix as a protocol or pause plan.

**Pause a cadence.** `{"kind":"pause","contact":"<e-mail|id>"}`. It cannot be resumed here.

**Goals.**

```json
{"kind": "goal", "goals": [{"assignee": "anlead@example.com", "period": "2026-11", "targetValue": 50000000, "currency": "COP"}]}
```

Use `startDate` and `endDate` (YYYY-MM-DD) for other periods. The same seller and period
updates the existing goal. An overlapping period is blocked: give its `"id"` or change dates.

Every write: `preview`, show the user `changes`, `recipients`, `warnings` and `blockers`, stop.
After a yes, `apply` with the preview's `--version` and `--confirmed`. The script answers in
English JSON; report the result in the user's language (Spanish if they wrote in Spanish),
after `apply` too.

## How the platform behaves

Details and edge cases are in `references/leads-model.md`.

- **Conversion** copies identity fields (name, e-mails, phones, address, company name, source,
  campaign, tags, group). Not stage, notes or activities. The contact may get a company linked
  by e-mail domain, an ad campaign, scoring and webhooks.
- **Lead owners and groups.** Assigning a lead notifies nobody; a lead's `assignmentGroup`
  rotates nobody. Rotation by groups exists only for contacts from forms and ad campaigns.
- **Badge rules.** The board picks a protocol whose stages include the record's stage, the
  one for the record's country first, else one without country. Only one shows per card. A
  step is done when a call (Phone or WhatsApp channel) or e-mail exists after the stage move.
- **Cadence rules.** E-mails go out from the contact owner's mailbox. Call and WhatsApp steps
  never send; only their delay counts. An e-mail step without its own subject is skipped. A
  reply, a suppressed address or missing consent stops it. Deactivating a protocol does not
  stop running cadences: pause them.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| "A contact with this email already exists" | Exact e-mail match | Work on that contact |
| Converted lead does not move or un-convert | Converted leads are frozen | Nothing to do; it is history |
| New contact belongs to the wrong seller | Converter becomes owner | Convert with `owner: keep` |
| No badge on a card | Preference off, protocol inactive, stage or country mismatch | `diagnose` |
| Badge overdue far too early | Delay below 1000 read as hours | Re-save the flow with `delay` |
| Second sequence e-mail never arrived | No own subject, WhatsApp step, reply, suppressed | `diagnose` |
| Goals counted twice in reports | Two goals, same seller and month | `goals`, then update one |
| Ad leads go to the wrong seller, or an existing contact is duplicated | Ad routing / an old duplicate | `prolibu-ads` / `prolibu-data-cleanup` |

## Verify

- `apply` reads every record back and lists any field that did not save under `problems`.
- After a conversion, check `converted[].contact`, `owner` and `notes`.
- A new protocol must read back `active: false`.

## Don't

- Enroll anyone in a cadence (`/v2/contactprotocol/enroll`): only campaigns do it, in the app.
- Convert by moving a lead to Converted with the stages skill or a hand-made PATCH.
- Change a user group's members or order, or account preferences.
- Delete leads or submissions.
- Use `--reaches-people` before the user approved the listed recipients.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step. A `403`
means the profile's user may not do that (sellers cannot list users or groups, nor set
goals): stop and say so; never retry it another way or with another profile. Lead imports from
a file go to `prolibu-imports`; forms that create leads go to `prolibu-forms`; tasks and calls a
step asks for go to `prolibu-activities`; sequence campaigns to `prolibu-messaging`; goals vs.
actual sales to `prolibu-dashboards`.
