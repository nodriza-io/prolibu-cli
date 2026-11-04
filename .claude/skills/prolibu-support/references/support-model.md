# Support model: tickets, case types, routing, mailbox, articles, portal

How the support objects behave on the server and in the app. Each rule was checked in the
platform code, in the app's code or on a non-production account; "code only" marks what could
not be tried live without e-mailing someone.

## Objects

| Object | Path | Key | What matters |
| --- | --- | --- | --- |
| Ticket | `ticket` | `ticketNumber` | `subject` (≤ 250, required), `description` (HTML, required), `requester.contact` or `requester.user`, `caseType`, `stage`, `priority`, `assignee`, `collaborators`, `group`, `tags`, `deal`, `dates.dueAt`, `channel`, `to`, `ccEmails`, `comments`, `notes` |
| CaseType | `casetype` | `caseTypeCode` | `resolutionArea` (its name, required), `assignmentGroup` (a UserGroup) |
| UserGroup | `usergroup` | `userGroupCode` | The team: `users`, `enableLoadBalancing`, `userGroupType` ("Ticket Resolution") |
| RoutingRule | `routingrule` | `routingRuleCode` | `routingRuleName`, `ruleType`, `pattern` or `domains`, `caseType` or `ticketGroup` |
| EmailHub | `emailhub` | `emailHubCode` | The support mailbox. Holds a credential: read only through the script |
| Comment | `comment` | `commentCode` | `content`, `origin {modelName: "Ticket", docId}`, `ccRecipients`, `attachments` |
| Note | `note` | `noteCode` | `content`, `origin`: an internal note |
| Article | `article` | `articleCode` | `articleTitle`, `summary` (≤ 300, required), `body`, `status`, `publishAt`, `expireAt`, `language`, `tags`, `cover` |
| Portal | `portal` | `portalCode` | `portalName`, `status`, `audience`, `articles`, `slides`, `menu`, `blocks` |

The key column is the primary key: a reference can be sent as that code instead of the `_id`.
A contact is also found by e-mail, and so is a user (an assignee sent as an e-mail that matches
no user answers `400 Document not found by primaryKey '<e-mail>' in 'assignee'`, verified live).

## Pipelines

Factory stages of `Ticket.stage`, in board order: Open (`…fc101`), Reopened (`…ff101`),
Pending (`…fc102`), Waiting on customer (`…fc104`), Escalated (`…fc105`), Resolved (`…fc103`,
closing), Closed (`…fc106`, closing). Ids start with `64e6f53079d82378f83`.
`Ticket.priority`: Low, Medium, High, Critical. Moves go through `prolibu-stages`.

- The server gives a new ticket **no stage**. The app sends one only when the ticket is created
  from a board column; e-mail tickets never get one (verified live). The script defaults to the
  first open stage, like the board's first column.
- A comment added to a ticket in a closing stage moves it to Reopened when the account setting
  `reopenTicketsWithComments` is on (default on). Notes do not reopen (verified live).
- With `autoCloseResolvedTickets` on, Resolved tickets move to Closed after the set hours.

## Account settings (admins read them at `/v2/preference/read`, `modules.support.tickets`)

| Setting | Default | Effect |
| --- | --- | --- |
| `caseTypeIsRequired` | off | Only a label: neither the server nor the app enforces it |
| `reopenTicketsWithComments` | on | A comment reopens a closed ticket |
| `customerSatisfaction.sendSurveyOnEndStage` | off | A ticket **with an assignee** reaching a closing stage e-mails a survey to the requester |
| `autoCloseResolvedTickets.enabled`, `hoursBeforeClosing` | off, 48 | Resolved → Closed after that time |
| `companyAutoAssignation.byRequesterCompanyDomains` | on | No company on the contact: use a company whose `domains` include the e-mail's domain |
| `ascendingDocumentNumber`, `documentNumberPrefix` | off, `TKT-` | Numbered tickets instead of `TIC-<timestamp>` |

## Creating a ticket

- **In the app:** the form sends the schema fields; it pre-fills the current user as
  `assignee` and the board's active group as `group`, and a column's `stage` when created from
  the board. It sends `requester.contact` or `requester.user` (the other as `null`) and does not
  pre-fill `channel`, `caseType` or `deal`.
- **Server rules:** both requesters → 400; none → the current user is the requester; the
  company is filled in (see settings); `descriptionText` is derived.
- **Case type team (on create only):** no assignee and a team with rotation → the next active
  member is assigned and notified, and the team order rotates; a team without rotation → each
  member is told the ticket is available and nobody is assigned; an assignee given → the team
  is not used. Verified live with a one-member rotating team.
- **Who is notified:** users only (assignee, creator, team, subscribers), in the app; e-mail
  notifications to users are sent on production accounts only. Nothing goes to the requester.

## Tickets from e-mail (code only)

1. The mailbox service reads new mail and calls `POST /v2/ticket/submit` with the sender, name,
   subject, body, thread id, attachments and `ccEmails` (the Cc header plus every other To
   address except the mailbox's own).
2. If a ticket has that thread id, the e-mail becomes a comment on it (`generatedByTicketSubmit`,
   `commentByContact`), `customerResponded` becomes true, and **`ccEmails` is replaced by this
   e-mail's CC**.
3. Otherwise a ticket is created: requester = the user with that e-mail, else the contact, else
   a new contact (in the mailbox creator user's workspace); case type from the first matching
   Subject rule, else the mailbox's case type; group from the first matching Domain rule;
   `to` = sender; `channel` = `Email`; no stage.
4. An inactive mailbox refuses everything (403). Errors inside the creation are logged and the
   call still answers 200 with an empty body: "sent but nothing was created" is possible.

## Routing rules

- `Subject Matching`: `pattern` is comma-separated keywords, case-insensitive "contains". Sets
  the case type. A stray comma makes an empty keyword that matches every subject.
- `Domain Matching Group`: `domains` comma-separated, compared exactly with the sender's domain
  (no `@`). Sets the ticket's `group` (a Group of tickets).
- The server reads the mailbox's rules with one query and takes the first hit **in the order
  the database returns them** (creation order in practice), not in the mailbox list's order.
- Rules never run for tickets created in the app, nor for replies on an existing thread.
- The app's form requires `ticketGroup` only for Domain rules and offers only ticket groups; the
  server checks that the right pair is present (`pattern` + `caseType`, or `domains` +
  `ticketGroup`).

## Replies, notes and CC

- **App:** `POST /v2/comment {content, ccRecipients?, attachments?, origin}`; the server links it
  (`comments` gets the new id first). If the CC list changed, the app then sends
  `PATCH /v2/ticket/<id> {ccEmails}`. Internal note: `POST /v2/note {content, origin}`.
- **E-mail ticket:** every saved comment that did not come from the mailbox is e-mailed to `to`
  with its `ccRecipients`, in the thread, through the mailbox; `customerResponded` becomes false.
  Saving runs again on edit, so an edited comment is e-mailed again (code only). The e-mail
  is sent before the comment is linked; if linking fails, the e-mail is already out.
- A missing mailbox makes the comment fail with 400 "Email hub not found." An inactive or
  disconnected mailbox is not checked before sending.
- The composer starts from the ticket's CC, validates all addresses or none, and never offers
  BCC. The script also drops the requester from the CC and always sends the list it showed.
- Support roles: the "Ticket Resolver" profile cannot edit or delete comments on tickets; the
  "Ticket Creator" profile cannot change subject, description, attachments or case type after
  creation, nor set stage, priority, assignee, collaborators, dates or requester (403).
- Forward (`POST /v2/ticket/forwardEmail`) e-mails the whole thread to any address. Only the
  older app screen offers it.

## Articles

- Status: `draft` (default), `scheduled` (needs `publishAt`; a minute job publishes it),
  `published` (stamps `publishedAt`, sets `publishAt` to now if empty), `archived`. `expireAt`
  archives it automatically. Publishing is a plain `PATCH {status}`; there is no notification.
- On create the code becomes `<slug of the title>-<timestamp>` and never changes (verified live).
- `GET /v2/article/feed/<code>` answers 200 only for an active, published (or due scheduled),
  unexpired article, for any signed-in user; otherwise 404. With `?status=draft` an editor
  previews a draft when the account allows draft previews (verified live).
- Deleting an article removes it from every portal's lists and menu.
- Images: the app uploads them into `attachments` with the known ids; do it in the app.

## Portal

- The account's internal home at `/portal` for signed-in users: a carousel (`slides`, ≤ 20), a
  news stream (`articles`, ≤ 200), a navigation `menu` (≤ 50 items: `internal`, `external`,
  `article` link, `wrapper` section) and side widgets (`blocks`). It is not a public site.
- `status` `draft` / `published` / `archived`; only an active, published portal is delivered.
- `audience`: `global` or chosen workspaces, optionally limited to roles. Each user gets one
  portal: workspace + role, then global + role, then workspace, then global. The server
  refuses overlaps (two global portals for everyone, two portals for one workspace…).
- `PATCH` replaces `articles`, `slides` and `menu` whole; every listed article must exist.
- `GET /v2/portal/feed` returns the portal the calling user would see.
