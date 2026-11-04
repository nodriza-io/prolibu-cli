# How contacts and companies hold together

What a merge has to move, what it cannot move, and why the duplicate is never deleted.
Checked against the platform code and live on a test account (companies); contact moves are
checked in code and with tests, not live.

## There is no merge and no archive

- The API has no merge route for contacts or companies, and the app has no merge screen.
  A merge is built from ordinary updates: re-point each record that refers to the duplicate,
  fill the primary, mark the duplicate.
- Contacts and companies have no archive flag and no soft delete. `DELETE` removes the record
  for good. "Archive" here means a contact tag (`Archivado` by default) that lists can filter.
  Companies have no tags field, so they cannot be archived this way.

## How activities are linked

A note, task, call or meeting points at its parent with `origin: {modelName, docId}`. The
parent keeps its own list (`notes`, `tasks`, `calls`, `meetings`), and that list is what the
record's Activity tab shows. The lists are read-only in the API.

- Updating an activity's `origin` adds it to the new parent's list (first position).
- It is **not** removed from the old parent's list. After a merge the duplicate still lists
  the moved activities (seen live on a company merge).
- Deleting a contact or company deletes every activity in its lists. Deleting a merged
  duplicate would therefore delete the activities just moved to the primary. Never delete it.
- Deleting a contact also deletes its form and ad submissions, and the server refuses to delete
  a contact that still has a deal or a company that still has contacts.

## What a contact merge moves

| Points at the contact | How | Note |
| --- | --- | --- |
| Deals (`contact`) | set to the primary | fires `Deal.update` webhooks |
| Presentations (`contact`) | set | fires `Presentation.update` webhooks |
| Notes, tasks, calls, meetings (`origin`) | origin update | also updates the primary contact |
| Calls (`contact`) | set | |
| Meetings (`attendees`) | swap in the list | no calendar sync unless dates change |
| Conversations (`contact`) | set | |
| Contact lists (`contacts`) | swap in the list | |

What stays on the duplicate, and why:

| Stays | Why |
| --- | --- |
| E-mails | `Email.contact` is read-only in the API; they stay on the duplicate's timeline |
| Form and ad submissions | the submission's contact cannot be changed after creation |
| Converted leads | set by the server at conversion |
| Contract signers | legal evidence |
| Tickets (requester) | rewriting the requester would drop its read-only company |
| Invoices, subscriptions, payment methods | billing history |
| Campaign audiences, bookings, work orders, price books, referrals | history or not handled here |
| Consent and unsubscribe state | read-only: a duplicate that opted out does not pass it on |
| Stage and stage history, score, owner, collaborators, group | the primary keeps its own |

Owner, collaborators and the reception group are never copied: changing them sends in-app
notices (and a group without load balancing notifies all its members).

## What a company merge moves

| Points at the company | How |
| --- | --- |
| Contacts (`company`) | set (a contact write) |
| Notes and tasks (`origin`) | origin update |
| Tasks (`company`), conversations (`company`) | set |

Stays: deals, meetings, tickets, invoices, subscriptions, payment methods and work orders
(their `company` is read-only in the API). Deals matter most: the server only fills a deal's
company when it is empty, so after a merge those deals still count under the old company in
reports. Assets (supplier) and groups are reported, not moved.

## Filling the primary

Only empty fields are filled, from the first duplicate that has a value. E-mails the primary
lacks go to `otherEmails`; new phone numbers (compared by their last 8 digits) to `phones`;
the duplicates' tags are added; company domains are joined. A contact's `company` fills the
primary only when the primary has none.

## Marking the duplicate

- Company: renamed `[FUSIONADA] <name>` and its `domains` emptied. With "assign company by
  e-mail domain" on, new contacts would otherwise keep landing on the duplicate.
- Contact: tag `Fusionado` (created on first use). It keeps its e-mail: e-mails are unique per
  workspace, and the primary carries it in `otherEmails`.
- A note on the primary lists what moved. `apply` also writes a local JSON log of every record
  it re-pointed (model, id, from, to), the only way to move them back by hand.

## Detection rules

- E-mail: the main e-mail and the other e-mails, lower case.
- Phone: the last 8 digits of mobile, WhatsApp and phones (the same rule as lead conversion).
- Name: accent- and case-insensitive letter-pair similarity of 92% or more, inside blocks that
  share the first letters of the last name (contacts) or the first word (companies). Name-only
  groups are "low" confidence.
- Company name: compared without legal suffixes (S.A.S., S.A., Ltda., S.A. de C.V., Inc …).
- Company domain: `domains`, the website host and the primary e-mail's domain; free mail
  (gmail, hotmail …) never matches.
- Tax id: `identification` number, digits and letters only.
- A key shared by too many records (a switchboard phone, a seeded test domain) is skipped and
  listed: it is not one person.
- Only records the profile can see are compared. A seller usually sees few contacts and no
  companies.

## Traps

- **A filter on an unknown field is dropped and every record comes back.** Counting "deals of
  this contact" with a field the server does not know answers with all deals. The script
  checks that the server echoed the filter before trusting a count, and blocks the merge if a
  movable reference cannot be counted.
- **`limit` is capped at 500** per page.
- **Inactivity.** Adding a note, task, call or meeting updates the contact, so "not updated
  since" already covers them; deals and e-mails do not, so they are checked apart.
