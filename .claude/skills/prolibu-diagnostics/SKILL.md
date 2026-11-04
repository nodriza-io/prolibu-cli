---
name: prolibu-diagnostics
description: Trace why something did or did not happen on a Prolibu account, and who changed what, by reading the platform's own traces only — script logs and the switches that let a script run, which webhooks would fire for an event, the status and events of an e-mail and the contact's suppression, why a user got or missed a notice, sign-in attempts, the audit log, stage history and a record's timeline. Strictly read-only. Use it whenever someone asks "why didn't my script run", "did the webhook fire", "the client never got the e-mail", "she didn't get the notification", "who changed this deal and when", "he can't sign in", or wants the history of a record. Spanish triggers: "por qué no corrió", "no se ejecutó el script", "no llegó el correo", "no le llegó la notificación", "quién cambió", "quién modificó", "historial del negocio", "no puede entrar", "auditoría", "logs".
---

# Prolibu Diagnostics

## Central idea

The platform keeps a few traces, each with gaps. A good diagnosis reads the right trace,
then says what that trace **cannot** show. The most common mistake is reading an empty
trace as proof: **no log does not mean it did not run.** A script that works leaves no log.
A webhook delivery leaves no trace at all. An e-mail notice leaves no record.

`scripts/diagnose.js` reads every trace the way it must be read (nested filters, local
filters where the server ignores one, the audit log's short default window) and filters the
output: no message bodies, no secrets, IPs masked. It only sends `GET`, and it never calls
the reads that change data (tracking links, the notice-settings "mine" route, log cleanup).

```
node .claude/skills/prolibu-diagnostics/scripts/diagnose.js <command> <domain> …
  record  <Model> <recordId> [--from D --to D] [--values]   timeline of one record
  script  <scriptCode|scriptId> [--model <Model>] [--from D]  can it run? what did it log?
  webhook <Model.event>                                        which webhooks receive it
  email   --recipient <e-mail> | --contact <id> | --code <emailCode> [--from D]
  notice  --user <e-mail> --event <group.onEvent> [--record <id>] [--actor <e-mail>]
  login   <e-mail> [--from D] [--ip]                           sign-in attempts
  audit   [--from D --to D] [--event e] [--actor <e-mail>] [--model M] [--id <id>] [--values] [--ip]
```

Every command accepts `--profile <name>`. Dates are ISO (`2026-11-03` or
`2026-11-03T15:00:00Z`). Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error
(nothing sent), 3 blocked (the audit log is off, or the script does not exist).

## Ask the user first

1. **Which account**, if `accounts/` has several domains, and which profile. Audit log,
   script logs, webhooks and notice settings need an admin profile.
2. **The record or person:** the deal name or contact e-mail (find the id with
   `prolibu-api.js` and a `select`), the user's e-mail, or the script code.
3. **When:** turn "yesterday afternoon" into `--from`/`--to`. The audit log answers only the
   last 24 hours unless you pass `--from`. Script and form logs are kept 7 to 14 days.
4. **Values or only names:** by default the audit shows which fields a save sent, not their
   values. Add `--values` only when the user asks what the values were. Add `--ip` only when
   they ask for IP addresses.

## Steps

1. **Pick the command** from the symptom table below. Run it.
2. **Read `verdict`, `gates` and `notes`** first; they say which switch blocks the event and
   what the trace cannot prove.
3. **Report in plain words:** what happened (with times and who), what blocks it, and what
   is unknowable from the platform (say it, do not guess).
4. **Send the fix to the owner skill.** This skill changes nothing.

## Commands in detail

- **record** — one timeline, newest first: created and last saved (`updatedAt/updatedBy`),
  stage moves (when stage history tracks that object), audit-log saves with the field names,
  in-app notices about the record, and e-mails to its contact. A deal keeps only its last
  `updatedBy`: without the audit log there is no per-field history.
- **script** — the gates for running on record events: script active, lifecycle hooks on for
  the account, the object enabled for hooks on the account, the script listening to that
  object. If a gate fails, the code never runs, whatever it says. Then its logs: failures,
  timeouts and `console.info/warn/error` lines only; `console.log` is never stored.
- **webhook** — the account switch, then every webhook whose `eventNames` has the event or
  `<Model>.*`, with its host only. There is no delivery history on the platform: only the
  receiving system's logs can prove a delivery.
- **email** — status (`pending`, `sent`, `failed`), error, provider, opens and clicks, and the
  contact's e-mail state. A contact that is `unsubscribed`, `bounced` or `complained` makes
  new e-mails fail before they are created, so there is no e-mail record to find.
- **notice** — why a user did or did not get a notice: user Active, the event caused by the
  same user (own actions are not notified; pass `--actor`), the channels on in the user's
  notice settings, and in-app notices found. Only the in-app channel leaves a record.
  Notice e-mails are sent only from production accounts.
- **login** — attempts for that e-mail, failures by reason (wrong password, too many
  attempts, blocked IP, no password, unknown user). The second-factor step is not recorded.
  A non-admin profile sees only its own attempts.
- **audit** — sign-ins, user/role changes, security settings and (when the account turned it
  on for those objects) record saves. Rows whose record or person is not on this account (for
  example, deleted) are left out and counted in `droppedNotOnThisAccount`. Values are never
  shown for users, roles, tokens or security settings.

## Symptoms

| Symptom | Command | Usual cause |
| --- | --- | --- |
| "My script didn't run on the deal" | `script <code> --model Deal` | The object is not enabled for hooks on the account, or the script is inactive or does not listen to it |
| "The script ran but did nothing" | `script <code>` | No log is normal for a clean run; look at failures and info lines |
| "The webhook didn't arrive" | `webhook <Model.event>` | Webhooks off, inactive, event not listed; else check the receiver |
| "The client didn't get the e-mail" | `email --recipient …` | `failed` with an error, suppressed contact (no record), or sent by Gmail/Microsoft with no delivery data |
| "She didn't get the notification" | `notice --user … --event …` | Self-caused, user inactive, channel off, or e-mail notices on a test account |
| "Who changed this and when?" | `record <Model> <id> --from …` or `audit --model … --id …` | — |
| "He can't sign in" | `login <e-mail>` | Wrong password, lockout for 5 minutes, blocked IP, no password set |
| A user cannot see or open a record | `prolibu-access-review` (`can`) | Role, record rule or workspace |

## How the platform behaves

Details and edge cases are in `references/traces.md`.

- **Absence is not proof.** Clean script runs, webhook deliveries and e-mail/WhatsApp notices
  leave no record. Say "the platform keeps no trace of this", never "it did not happen".
- **Short retention.** Script and form logs disappear 7 to 14 days after they are written.
- **The audit log shows what a save sent**, not the old and new value. Changes made by
  scripts inside the server are not audited; changes made through the API are.
- **Gmail and Microsoft e-mails stop at "sent".** Delivery and bounce data exist only for
  e-mails sent through SendGrid.
- **Notice e-mails go out only from production accounts;** WhatsApp notices go out wherever
  WhatsApp is on for the account and the user has a phone.

## Don't

- Call `/v2/eventsubscription/getMine`, any `/v2/email/view|click|unsubscribe|consent` link,
  `/v2/log/clear` or `/v2/notification/clean`: they change data even when they look like reads.
- Export the audit log (`format=csv` or `xlsx`).
- Print e-mail bodies, notice values, passwords, tokens, headers, or IPs nobody asked for.
- Trigger a test (send an e-mail, push a notice, move a stage) to "see if it works" without a
  separate yes. Those belong to the owner skills, with their own previews.
- Filter logs with a dotted key (`meta.scriptCode`) or StageHistory with `modelName`/`docId`
  parameters: the server ignores both and returns every row. The script uses the nested form.

## Where fixes go

Scripts: `prolibu-scripts`. Webhooks: `prolibu-webhooks`. Campaigns, templates and sending:
`prolibu-messaging`. Stage moves and time in stage: `prolibu-stages`. Commercial-exception
notices: `prolibu-commercial-exceptions`. Contract reminders: `prolibu-contracts`. WhatsApp
or SMS conversations: `prolibu-conversations`. Form submissions: `prolibu-forms`. Users,
roles, passwords, sign-in rules and preferences are changed by an admin in the app.

## Reading an account

This skill only reads. It still follows [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md)
for choosing the domain and profile. A `403` (or an entry in `forbidden`) means the profile's
user may not read that trace: stop and say so, never retry it another way or with another
profile. For objects and how they relate, see `prolibu-platform-map`.
