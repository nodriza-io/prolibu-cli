# How Prolibu models activities

Verified against the server code, the app's code and a non-production account. Read it when a
case falls outside the steps of `SKILL.md`.

## The four objects

| Object | API path | Required on create | Text field (HTML) | Code |
| --- | --- | --- | --- | --- |
| Task | `task` | `title` (max 250 characters, HTML included) | `title` | `TSK-…` |
| Note | `note` | `content` | `content` | `NOT-…` |
| Meeting | `meeting` | `title`, `dates.startAt`, `dates.endAt`, `attendance.mode`, `assignee` | `description` (title is plain text) | `MTG-…` |
| Call | `call` | `channel` (default `Phone`), `direction` (default `Outbound`); the app also requires a summary | `summary` | `CAL-…` |

The server keeps a plain-text copy of each text field (`titleText`, `contentText`,
`summaryText`, `descriptionText`) for search.

Other fields worth knowing:

- **Task:** `description` (plain text), `assignee`, `collaborators`, `dates.startAt`,
  `dates.dueAt`, `dates.dueReminder`, `dates.dueReminderAt`, `dates.notifyUsers`, `stage`
  (stage type `Task.stage`), `priority` (`Task.priority`), `checklist`, `tags`, `company`
  (copied from the parent's `company` on create, with its `tags`).
- **Note:** `checklist`, `attachments`, `color`, `sticky`, `assignee`, `collaborators`.
- **Meeting:** `status` (`Scheduled` by default, `Completed`, `Cancelled` with
  `cancelledReason`), `attendees` (contact ids), `attendance.address` (in person) or
  `attendance.videoLink` (virtual), `collaborators`, `provider` (`google`/`microsoft`),
  `inviteParticipants` (default `true`), `participantsEmails` (set by the server).
- **Call:** `contact`, `stage` (`Call.stage`), `duration` in seconds, `scheduledAt`,
  `recordingFile`, `transcriptionFile`, cold-call fields (`isColdCall`, `firstName`,
  `phoneNumber`…).

Stages are per account: read them with `options`, or
`GET /v2/stage?stageType=Task.stage&sort=index`. A task with no stage is "to do" in the app;
"Done" is the task stage with `endFlowStage: true`. Neither tasks nor calls get a default
stage on create, in the app or the API.

## How an activity is linked to its parent

1. The create body carries `origin: {modelName, docId}`. The model name is resolved without
   regard to case, but it is stored as sent: send `Contact`, `Company` or `Deal`.
2. If `body.workspace` is missing, the activity takes the parent's workspace.
3. The server saves the activity and runs its hooks (notifications included).
4. It then updates the parent: it reads the list named after the activity's model
   (`tasks`, `notes`, `meetings`, `calls`), puts the new id first and saves the parent through
   its normal update, with all of the parent's rules.
5. Only then does it answer `201`.

Consequences:

- **No rollback.** If step 4 fails, the call answers an error and the activity stays saved,
  pointing at the parent but not in its list. Seen on the test account with an unknown model
  name: `400 "Cannot read properties of undefined (reading 'findOne')"`, and the note
  existed. `apply` looks for that orphan (same parent, same text) and reports it.
- **A parent that does not exist** (wrong id) gives `201` and an activity linked to nothing.
  The script reads the parent first.
- **A parent without that list** (a meeting or call on a deal or company) gives `201`. The
  parent update carries only the unknown list, which the parent's schema drops, so nothing is
  linked, but the parent's `updatedAt` and `updatedBy` change and its update webhooks fire.
- **The parent's lists are read-only** through the API (`avoid: always`). A `PATCH` of
  `{"notes": [...]}` answers `200` and changes nothing but `updatedAt`.
- The app also never patches the parent: it creates the activity, then re-reads the parent's
  list.

Which lists each parent has (and so where the app shows each activity):

| Parent | `notes` | `tasks` | `meetings` | `calls` | Activity tab |
| --- | --- | --- | --- | --- | --- |
| Contact | yes | yes | yes | yes | yes |
| Company | yes | yes | — | — | yes (activity of its contacts) |
| Deal | yes | yes | — | — | no (deal history instead) |

A call with `contact` is also added to that contact's `calls` by the call's own hook. With no
`origin`, a call takes the contact as origin, and a meeting takes its first attendee.

### Relinking an orphan

Updating the activity with `origin` runs the same append. After the user agrees:

```
node .claude/skills/_shared/prolibu-api.js <domain> PATCH /v2/<task|note|meeting|call>/<id> \
  --data '{"origin":{"modelName":"Deal","docId":"<deal id>"}}' --confirmed
```

Then run `history` on the parent: the activity must leave `unlinked`. It does not remove the
id from a previous parent's list. On a closed deal that rejected the link, the same rejection
happens again.

## Closed deals

A deal whose stage has `endFlowStage: true` (won, lost, denied…) rejects updates except a
short list of fields, unless the account allows edits in closing stages
(`modules.sales.deals.stageRules.allowEditInEndFlowStages`). The list includes `tasks` and
`notes` on current servers, so the link step passes and notes and tasks can be added to a
closed deal. On older servers the list ended at `contracts`: the note or task was saved, the
link was rejected with `400 'This deal is in the "<stage>" stage. The following fields cannot
be modified: [tasks]'`, and the activity was left orphaned. The app's own check matches the
current list: in a closed deal it keeps the Notes and Tasks tabs open and locks the rest.

## Notifications and invitations

Delivery follows each user's notification settings. The defaults a new user gets are below;
users can switch events and channels on or off. A user is never notified of their own action,
except for due reminders. A live stream (a manager following a user) can forward the same
events to its subscribers.

| Event | Who | Default channels |
| --- | --- | --- |
| Task assigned (on create or later) | The assignee | In-app and e-mail |
| Added as collaborator (task, note) | The new collaborator | In-app |
| Note assigned | The assignee | In-app and e-mail |
| Mentioned in a note | The mentioned user | In-app and e-mail |
| Mentioned in a task title | The mentioned user | In-app |
| Due reminder (task) | Assignee, creator, last editor, `dates.notifyUsers` | In-app and e-mail |
| Task created, stage or priority changed, deleted | The user who did it, so in practice only live streams | Off by default |
| Meeting or call created | Nobody | — |

E-mail notifications are only sent by production servers.

- Mentions only notify when the text carries the app's mention markup (a hidden
  `#userMentionsTracker` element). Plain `@name` text notifies nobody. The script never builds
  that markup.
- **Reminders.** `dates.dueReminder` is an offset (`On Due Date`, `1 Minute` … `1 Week`,
  `Custom`). The server sets `dates.dueReminderAt = dueAt − offset`, rounded to the minute, and
  a job sends it in the minute it falls due, once, unless the task is already in a closing
  stage. A reminder time already in the past is never sent. `dueAt` is rounded down to the
  minute. Without `dueAt`, the reminder fields are cleared.
- **Rescheduling bug.** The reminder time is only recomputed when `dueReminder` itself
  changes. Changing only `dates.dueAt` keeps the old `dueReminderAt`; sending the same
  `dueReminder` again does not help. Send `dates.dueReminderAt` with the new `dueAt`
  (`PATCH /v2/task/<id>` with `{"dates":{"dueAt":"…","dueReminderAt":"…"}}`). A `PATCH` of
  `dates` merges key by key: the other date fields stay.
- **Calendar invitations.** A meeting with `provider: "google"` or `"microsoft"` is created
  in the creator's connected calendar; Google is called with `sendUpdates: all`, which
  e-mails an invitation to every participant. Changing its dates updates the event, and
  cancelling deletes it. Participants (`participantsEmails`) are the attendees' e-mails plus
  the assignee, collaborators and creator, filled only while `inviteParticipants` is `true`.
  Without `provider`, nothing is sent; Prolibu's own calendar uses `participantsEmails` to show
  the meeting to those users, which is why the script leaves `inviteParticipants` alone.
- In the app, the provider is chosen in the contact's Meetings panel when the user has a
  connected calendar, and the contact is added as an attendee automatically.

## History

- **Contact:** `GET /v2/contact/<id>?outputFormat=activity` adds `activity: {notes, tasks,
  emails, calls, meetings, deals, contracts, presentations, consents}`. Notes, tasks, e-mails,
  calls and meetings come from the contact's lists; deals are those whose `contact` is this
  one; contracts are those it signs. The app sorts by `updatedAt` or `createdAt`, newest
  first, and ignores `consents`.
- **Company:** the same call on a company adds `contacts: [{…, activity}]`, one per contact of
  the company. Its own notes and tasks are in its lists (`populate`).
- **Deal:** the app's deal history is built from stage moves (`GET /v2/stagehistory` with
  `origin.docId` = the deal and `stageField: stage`), proposal views and the proposal's
  creation. Its notes and tasks are in their own tabs. A deal created directly in a stage has
  no stage-move entry for it.
- **Anything that points at a record:** `GET /v2/<task|note|meeting|call>?xquery=
  {"origin.docId":"<id>"}`. What is there but not in the record's lists is what the app does
  not show (`unlinked` in `history`).

## Edge cases

- **Assignee by e-mail** is resolved by the server and an unknown e-mail answers `400`
  before anything is saved. An `_id` that is not a user is saved silently and reads back as
  `null`. A meeting with no assignee is rejected; the app fills it with the record's owner, or
  the current user.
- **Task dates:** the server's own date check looks at fields that do not exist, so a start
  after the due date is accepted.
- **Mixed models:** a note's `origin` can point at any object with a `notes` list (tickets,
  for example); this skill covers contacts, companies and deals.
- **Permissions:** creating an activity does not check that the user may see the parent. The
  script reads the parent with the same key first, so a record the user cannot see stops it.
