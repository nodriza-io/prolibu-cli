---
name: prolibu-support
description: Handle Prolibu support tickets the way the app does — find a ticket and read its thread, open a ticket for a contact with case type, priority and assignee, reply to the customer or add an internal note (knowing when a reply is e-mailed and who is copied), explain how case types assign tickets to a team and how routing rules classify e-mail from the support mailbox, and write help articles and the portal's article lists. Use it whenever someone wants to open, find, assign, answer or reclassify a ticket, asks how tickets get assigned or routed or why an e-mail ticket got a case type, wants to write or publish an article in the portal, or reports a reply e-mailed by mistake, a ticket that reopened by itself, a CC that changed, or e-mail tickets with no stage. Spanish triggers: "ticket", "caso de soporte", "tipo de caso", "responder al cliente", "nota interna", "con copia", "reglas de enrutamiento", "buzón de soporte", "artículo de ayuda", "portal".
---

# Prolibu Support

## Central idea

A **ticket** is a support case from a requester: a contact or a user, never both. It has a
**case type** (the area that resolves it, optionally with a team), a **stage** and a **priority**
(two pipelines), an assignee, and a thread of **comments** and **internal notes**. Tickets come
from the app (channel `App`) or from the support mailbox (channel `Email`).

The rule that breaks things: **on an e-mail ticket every comment is an e-mail.** It goes at once
to the requester and the CC, from the support mailbox, and again if the comment is edited.
Internal remarks go in a **note**, which e-mails nobody.

`scripts/support.js` does the fragile parts in code: it resolves case types, stages and people,
says who will be assigned and notified, sends the exact CC it showed, never reads the mailbox's
credential, keeps portal lists whole, and reads every write back. Your job is the conversation:
what the user wants, the preview, and a clear yes.

```
node .claude/skills/prolibu-support/scripts/support.js <command> <domain> …
  setup    <domain>                         case types and teams, mailboxes, routing rules, pipelines, settings
  find     <domain> <text or ticket number>
  show     <domain> <ticket id or number>   ticket, requester, CC, thread, what a reply would do
  contacts <domain> <name or e-mail>        find the requester
  route    <domain> --subject "<text>" --from <e-mail> [--hub <code>]   which case type an e-mail would get
  content  <domain> [text]                  portals and articles
  create|update|reply|article|portal <domain> '<plan json>'          preview, writes nothing
    … same command + --version <v> --confirmed [--sends-email] [--publish]   write
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked (nothing
written).

## Ask the user first

1. **Which ticket?** A number (`TIC-…`) or words from the subject; `find` gets the id.
2. **For a new ticket:** who asked (a contact, by name or e-mail), what happened, the case type,
   the priority, and **who handles it**: them, someone else, or the case type's team.
3. **For an answer:** is it for the customer, or an internal note? On an e-mail ticket, who is
   copied.
4. **For an article:** draft only, or publish now / on a date, and in which portal.

If `accounts/` has several domains, ask which one.

## Steps

**Read.** `setup <domain>` once per conversation: it gives the case types (and what each does
with a new ticket), the stage and priority names, the mailboxes and their rules, and the
settings. Then `find` and `show` the ticket. `show` says in `replyWould` what a reply does.

**Open a ticket.** Find the requester with `contacts`. If the contact does not exist, stop and
ask: create it first in the app or with the platform map. Preview:

```json
{"subject": "Cannot download the invoice", "description": "Plain text or HTML",
 "requester": "<contact _id or e-mail>", "caseType": "<name or code>", "priority": "high",
 "stage": "<optional; default: the first open stage>", "assignee": "me | <user e-mail or _id>",
 "collaborators": [], "deal": "<deal _id>", "dueAt": "2026-11-05T15:00:00Z"}
```

A user as requester: `"requester": {"user": "me"}`. Tell the user the `summary`, every `effect`
(who gets the ticket, the company it takes) and `warning`. Then write with the version.

**Change a ticket.** `update` with `{"ticket": "<id or number>", "set": {…}}`. It accepts
`subject`, `description`, `caseType`, `assignee`, `collaborators` (the whole list), `deal`,
`dueAt`, `tags` and, on e-mail tickets, `ccEmails`. A user is `"me"`, an e-mail or an `_id`.
Stage and priority: use `prolibu-stages` (`stages.js move … Ticket <id> --to "<stage>"`, add
`--field priority` for priority). Closing stages (Resolved, Closed) need its `--end-flow`.

**Answer.** `reply` with `{"ticket": "…", "content": "…", "as": "reply" | "note", "cc": [ … ]}`.
- `note`: internal, e-mails nobody.
- `reply` on an App ticket: a comment in the app; nobody gets an e-mail; `cc` is refused.
- `reply` on an e-mail ticket: the preview names the recipient and the CC (by default the
  ticket's CC). Read them to the user. The write needs `--sends-email`, added only after the
  user said yes **to sending that e-mail**. A different `cc` also becomes the ticket's CC.
- A reply to a Resolved or Closed ticket moves it to Reopened (account setting, on by default).

**Mailbox and routing.** Explain from `setup` and `route`; do not configure them from here.
- E-mail to the mailbox becomes a ticket; a reply in the same thread becomes a comment.
- Routing rules apply only to new e-mail threads, only if the mailbox lists them.
- Case types and routing rules can be created through the generic helper (with the write flow).
  Linking a rule to the mailbox is a change to the mailbox: an admin does it in the app.

**Articles and portal.** `content` lists them. `article` with `{"article": "<code or _id, omit to
create>", "set": {"articleTitle", "summary" (≤ 300), "body", "status", "publishAt", "expireAt",
"language"}}`. Status `published` or `scheduled` needs `--publish`. `portal` with `{"portal":
"<code>", "list": "articles" | "slides", "add": [...], "remove": [...]}` adds to the news stream
or the carousel; a published portal needs `--publish`. Creating a portal, its menu and audience
are done in the app.

## How the platform behaves

Details, ids and evidence: `references/support-model.md`.

- **Comments link themselves.** The server adds a comment or note to the ticket from its
  `origin`; never PATCH `comments` or `notes`.
- **Every comment on an e-mail ticket is sent**, also when edited later. There is no "internal
  comment": use a note. The script has no comment edit.
- **Assignment by case type happens only on create, and only without an assignee.** A team with
  rotation assigns the next active member; a team without it tells every member the ticket is
  available. The app pre-fills the creator as assignee, so its tickets usually skip the rotation.
  Changing the case type later assigns nobody.
- **E-mail tickets arrive with no stage** and their case type comes from the first matching
  rule, else the mailbox's default. Rules run oldest first, not in the mailbox's order.
- **The CC moves.** Each customer e-mail in the thread replaces the ticket's CC with that e-mail's
  CC. An agent reply uses the CC it sends. Check `show` before replying.
- **Closing a ticket can e-mail the customer:** with satisfaction surveys on, a ticket with an
  assignee that reaches Resolved or Closed sends one. Resolved tickets can close by themselves.
- **Company is automatic:** the contact's company, else a company whose domains include the
  e-mail's domain.
- **An article goes live by status.** Published means every signed-in user can open it by its
  link at once; a portal shows it only if the portal is published and lists it. The portal is
  the account's internal home for its users, not a public help center: for public help pages,
  use `prolibu-sites`.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| The customer got an "internal" remark | A comment on an e-mail ticket | Use `"as": "note"` from now on; it cannot be unsent |
| The customer got the same reply twice | The comment was edited | Never edit comments on e-mail tickets |
| A closed ticket is open again | A comment arrived (reply or customer e-mail) | Expected; move it with `prolibu-stages` |
| E-mail tickets are not on any board column | They arrive without a stage | Move them with `prolibu-stages` |
| An e-mail ticket got the wrong case type | Rule order or a stray comma in a pattern | `route` with that subject and sender; fix the rule in the app |
| The team never gets tickets by rotation | Tickets are created with an assignee | Create without `assignee` |
| The CC changed by itself | A customer e-mail replaced it | `show`, then `update` `ccEmails` if the user wants |
| 400 "Document not found by primaryKey '…' in 'assignee'" | No user with that e-mail | Ask for the right person |
| 403 changing subject, case type or stage | The user's support role protects them | Tell the user; an admin decides |
| An article link answers 404 | Draft, archived, expired or scheduled for later | `content`; publish with the user's yes |

## Verify

- Every write reads back: `saved`, the ticket number or article code, and `problems`.
- `reply` reports `emailed`, `stageBefore`, `stageAfter` and `reopened`.
- `article` reports `liveNow`: whether its link works for users now.

## Don't

- Comment on an e-mail ticket for anything internal, or add `--sends-email` before the user
  agreed to that e-mail.
- Read, create or change a mailbox (`EmailHub`) with the generic helper: it holds a credential
  the helper does not mask. `setup`, `show` and `route` read only its safe fields.
- PATCH a ticket's `comments`, `notes`, `channel`, `to` or `emailHubCode`.
- Move a ticket with an assignee to a closing stage just to test: it may e-mail a survey.
- Publish an article or change a published portal without the user's separate yes.
- Use `POST /v2/ticket/submit` or `/v2/ticket/forwardEmail`: they are the mailbox's and the
  public form's doors, and forwarding e-mails people.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. Each command without `--confirmed` is the
summary step. Stages: `prolibu-stages`. Other objects: `prolibu-platform-map`.
