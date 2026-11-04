---
name: prolibu-activities
description: Log activities on a Prolibu contact, company or deal the way the app does it — tasks with an owner, due date and reminder, notes, meetings and calls — linked so they show on the record, warning who gets notified, and read a record's activity history (the contact's Activity tab, a company's contacts, a deal's notes, tasks and stage moves). Use it whenever someone asks to create a task or to-do, schedule or log a meeting, log a call, add a note or follow-up to a record, see what happened with a client or deal, or reports a task or note that "does not show on the record", an error that still created the note, a reminder at the wrong time, or a meeting that never appeared on a deal. Spanish triggers: "crear una tarea", "asignar tarea", "agendar reunión", "registrar llamada", "agregar nota", "seguimiento", "historial de actividad", "qué ha pasado con el cliente".
---

# Prolibu Activities

## Central idea

An activity (Task, Note, Meeting, Call) is its own record that points at its parent through
`origin: {modelName, docId}`. The server saves the activity first and **then** adds its id to
the parent's list (`tasks`, `notes`, `meetings`, `calls`). The app shows a record's activities
from those lists. If that second step fails, the server answers an error but keeps the
activity, unlinked and invisible on the record: nothing is undone.

`scripts/activity.js` does the fragile parts in code: it checks the parent exists and where
that kind of activity can live, builds the body the way the app does (HTML text, canonical
model name, dates with their offset, assignee by e-mail), refuses calendar invitations, then
reads back both the activity and the parent's list, and finds the orphan when the server
errs after saving. Your job is the conversation: what to log, on which record, who owns it and
when; show the preview, and write only after a clear yes.

```
node .claude/skills/prolibu-activities/scripts/activity.js <command> <domain> …
  find    <domain> <contact|company|deal> "<text>"            look up the record
  options <domain>                                             your user, task/call stages, reminders
  history <domain> <contact|company|deal> <id> [--limit <n>]   what the record shows, newest first
  preview <domain> '<plan json>'                               writes nothing; returns a version
  apply   <domain> '<plan json>' --version <v> --confirmed
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written).

## Ask the user first

In plain business terms:

1. **On which record?** A contact, company or deal; a name is enough. Meetings and calls go
   on a contact (see below).
2. **What exactly?** The task title, the note text, the meeting subject, or the call summary.
3. **Who is responsible?** "Me" or a colleague's e-mail. Say that a colleague is notified.
4. **When, and in which time zone?** Due date and time for a task (and a reminder?), start
   and end for a meeting. Never guess the time zone: `options` shows it when the account has
   one; otherwise ask.
5. **For a meeting:** in person (address) or virtual (link)? Does the contact attend? The
   app lists the contact as an attendee; no invitation is sent from here.

If `accounts/` has several domains, ask which one.

## Steps

1. **Find the record.** `find <domain> deal "<name>"`. Several matches: list them and ask.
   A deal shows `closed` and its `contact`.
2. **Read it.** `history <domain> <kind> <id>` when the user wants to know what happened, or to
   avoid logging the same thing twice. `options <domain>` gives your user, the task stages and
   priorities, the call stages and the reminder choices.
3. **Write the plan** (inline JSON in single quotes, or a temp file):

   ```json
   {"type":"task","parent":{"model":"Deal","id":"<id>"},"title":"Send the revised proposal",
    "assignee":"me","dueAt":"2026-11-05T17:00:00-05:00","reminder":"1 Hour","priority":"High"}
   ```

   | Type | Required | Optional |
   | --- | --- | --- |
   | `task` | `title` (plain text, short) | `description`, `assignee`, `startAt`, `dueAt`, `reminder`, `stage`, `priority` |
   | `note` | `content` | — |
   | `meeting` (contact only) | `title`, `startAt`, `endAt`, `mode` (`In-person`/`Virtual`) | `address` or `videoLink`, `description`, `assignee`, `attendees` (contact ids) |
   | `call` (contact only) | `summary` | `assignee`, `channel` (`Phone`), `direction` (`Outbound`), `stage`, `duration` (seconds), `scheduledAt` |

   - `assignee`: `"me"` or the user's e-mail. The server rejects an unknown e-mail.
   - Dates: `YYYY-MM-DDTHH:MM:SS±HH:MM`. Stages and priorities by name (`"Done"`) or id.
   - `reminder`: `On Due Date`, `5 Minutes` … `1 Week`; it needs `dueAt`.
   - The app creates tasks and calls with no stage; a task without one is "to do". Set
     `stage` only when the user asks.
4. **Preview.** `preview <domain> '<plan>'`. Tell the user, in plain words: what will be
   created and on which record, the dates in their time zone, everyone in `notifies`, every
   `warning`. On `blockers`, explain and stop.
5. **Wait for an explicit yes.**
6. **Write.** `apply <domain> '<same plan>' --version <version> --confirmed`. It refuses when
   the record changed since the preview, which also stops a second apply of the same plan.
7. **Report.** On `"saved": true`: the record name, what was created and its code. On
   `problems` or an `orphan`: say exactly what happened (see Symptoms) and ask before
   any repair.

## How the platform behaves

Details, evidence and edge cases are in `references/activity-model.md`.

- **Where each activity lives.** Notes and tasks: contacts, companies and deals. Meetings and
  calls: contacts only. A deal or company has no list for them and the app never shows them
  there, so the script blocks them and names the deal's contact.
- **Closed deals.** The app still lets you add notes and tasks to a deal in a closing stage.
  Some servers reject the link after saving and leave an orphan: `apply` checks and reports
  it.
- **Who hears about it.** A task assigned to someone else notifies them (in the app, and by
  e-mail if their settings say so). A reminder reaches the assignee and the creator at
  `dueAt` minus the offset. Notes, meetings and calls notify nobody. Apart from reminders,
  nobody is notified of their own action.
- **Calendar invitations.** Only a meeting with a Google or Microsoft calendar sends them,
  and it e-mails every participant. The script never sets that; the user creates those
  meetings in the app with their connected calendar.
- **Text is HTML.** Task titles, notes, call summaries and meeting descriptions are rich text.
  The script turns plain text into escaped paragraphs. Mentions (`@name`) do not notify from
  here.
- **The server checks little.** It accepts a start after the due date and an assignee id that
  is not a user, and drops unknown fields. The script checks these first.
- **History.** Contact: the app's Activity tab (notes, tasks, e-mails, calls, meetings, deals,
  contracts, presentations). Company: its contacts' activity plus its own notes and tasks.
  Deal: its notes, tasks and stage moves. `unlinked` lists activities that point at the record
  but are missing from its lists.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| A task or note "does not show" on the record | Not in the record's list: wrong or missing `origin`, or the link failed | `history` → `unlinked`; relink only after a yes (reference) |
| An error, yet the note or task exists | The server saved it, then failed to link it (closed deal, wrong model) | `apply` reports the `orphan`; ask whether to keep, relink or delete it |
| A meeting or call never appears on a deal | Deals and companies have no list for them | Log it on the deal's contact |
| 400 "Document not found by primaryKey '<e-mail>' in 'assignee'" | No user with that e-mail | Ask for the colleague's sign-in e-mail |
| After moving the due date, the reminder came at the old time | The server only recomputes it when the reminder choice changes | Send `dates.dueReminderAt` with the new `dueAt` (reference) |
| A customer received a calendar invitation | The meeting was created in the app with a connected calendar | Expected for those meetings; this skill never sends one |
| A task "done" in the app | Its stage is the closing one ("Done") | Use `prolibu-stages` to move tasks |
| A task that belongs to a project (gantt, dependencies, working days) | It is part of a task group | `prolibu-projects` |

## Verify

- `apply` reads the activity back (text, assignee, dates, stage, origin) and the parent's list.
  `linked: true` means the app shows it on the record. Give the user the code (`TSK-…`).
- `history` afterwards shows it first in the list.

## Don't

- Create activities with hand-made calls: use the script.
- Set `provider` or `inviteParticipants`, or build mention markup.
- Assign by raw user id, or to someone the user did not name.
- Add the activity id to the parent with a `PATCH`: those lists are read-only and the call is
  ignored with a `200`.
- Log a meeting or call on a deal or company.
- Delete an orphan or retry a failed apply without telling the user and getting a yes.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step and `apply`
the write. Moving a task to "Done" or a deal to another stage is `prolibu-stages`. For objects
and how they relate, see `prolibu-platform-map`.
