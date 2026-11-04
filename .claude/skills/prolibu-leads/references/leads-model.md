# Leads, protocols and goals: the model

What `scripts/leads.js` relies on, checked against the platform's code and a test account.

## Lead (`/v2/lead`)

- Same fields as a Contact, minus `company`, plus `companyName` (free text), `description`
  (becomes a note on conversion), `converted`, `convertedAt` and `convertedTo` (the contact;
  set by the platform).
- `email` is required and unique per workspace among leads. A lead can share its e-mail with
  a contact until it is converted.
- `stage` is a Stage of type `Lead.stage`. The platform seeds four, found by `stageCode`:
  `lead-stage-reviewing`, `lead-stage-qualified`, `lead-stage-discarded` (end of flow) and
  `lead-stage-converted` (end of flow). New = no stage. The server accepts a stage of any other
  pipeline without error; the board then loses the card. The script only uses Lead stages.
- `assignee` can be set freely. Nothing is notified and `assignmentGroup` does nothing on a
  lead.
- The Leads menu is hidden unless the account preference for leads is on. The API works
  either way.

### Conversion, step by step

Triggered by `converted: true` or by the Converted stage, inside the same save:

1. If a contact of the same workspace has the same e-mail, the save fails with
   "A contact with this email already exists." Nothing else is checked: other e-mails, phone
   and name are not.
2. A contact is created from: workspace, firstName, lastName, email, jobTitle, companyName,
   website, mobile, whatsapp, phones, address, socialNetworks, identification,
   assignmentGroup, otherEmails, tags, direction, industry, numberOfEmployees, profilePicture,
   adCampaign, adCampaignMeta, source, priority, collaborators, group.
3. `assignee` and `createdBy` of the contact, and `assignee` of the lead, become the user who
   converted. The script hands the contact back with a second write (`PATCH
   /v2/contact/<id> {"assignee"}`), which notifies the new owner.
4. `description` becomes a note on the contact.
5. The lead gets `converted`, `convertedAt`, `convertedTo` and the Converted stage.
6. The contact runs its normal life: company linked by e-mail domain (when the account allows
   it), an ad campaign created when `adCampaignMeta` names an unknown one, scoring, in-app
   notices ("new contact" to its creator, "you are the owner" to its owner, plus followers of
   their activity streams), contact webhooks. No submission is recorded and nobody is enrolled.
7. From then on any save of the lead keeps it converted and in the Converted stage: moving it
   or `converted: false` answers 200 and changes nothing.

The app converts the same way (one PATCH per lead), without any duplicate check or owner
choice.

### Duplicate check done by the script

| Check | How | Effect |
| --- | --- | --- |
| Same e-mail | `xquery {"email"}` on contacts | Blocked |
| Lead's other e-mails | `email $in` | Blocked unless `differentFrom` |
| Lead e-mail among a contact's other e-mails | `otherEmailsText $regex` | Same |
| Phone | last 8 digits in `phonesText` | Same |
| Name | `searchText` by last name, accent-free similarity ≥ 85 % | Same |

Only contacts the profile can see are checked. A seller may miss a contact of another seller;
the server still refuses an exact e-mail match.

## ContactSubmission (`/v2/contactsubmission`, read only)

One record per form or ad submission: `contact`, `sequence` (1 = first, 2+ = re-contact),
`source`, `adCampaign` (of this submission), `refId` (the platform's lead id, so the same
submission is never counted twice) and `data` (unmapped answers, personal data: never
print). The contact keeps a summary in `submissions` (`firstAt`, `lastAt`, `count`,
`lastAdCampaign`, `lastSource`). Creating or editing submissions through the API is not
possible.

## ContactProtocol (`/v2/contactprotocol`)

| Field | Notes |
| --- | --- |
| `contactProtocolName` | Required |
| `entity` | `Contact` (default), `Deal` or `Call` |
| `stages` | Stage ids of that pipeline |
| `country` | ISO code; empty = every country |
| `flow` | Whole list: `{actionType, actionName, time, subject, messageTemplate, conversationFlow}` |
| `active` | **Defaults to true**: the script always sends `false` on create |
| `allowEveryone.view` | Default true; false hides the badge from other users |

- `time` is the delay before the step, in milliseconds, 0 to 10 years. The app's editor
  offers minutes, hours and days. The board reads a value below 1000 as hours; the e-mail
  engine reads milliseconds. The script blocks anything under one minute.
- `messageTemplate`: for e-mail, a template of type Email; for WhatsApp, a Message template
  whose WhatsApp status is approved. Call steps can carry a `conversationFlow`.
- `subject` is a Handlebars template checked on save.
- Every role can create and edit protocols, including sellers.
- The boards ask for `entity` + `active: true` protocols only when the account preference
  for protocols is on.

### Badge (what the board shows)

1. Contact and Deal cards: protocols whose `stages` include the card's stage. The one with the
   card's `address.country` wins; else one without country; else nothing. With no country on
   the card, the viewer's own country is used.
2. Call cards: only the protocol set on the call, and only if the call's stage is in it.
3. Steps are walked in order from `pipelineStages.stage.movedAt` (else `createdAt`): the next
   call with channel Phone, call with channel WhatsApp, or e-mail completes the step. The first
   step not completed is overdue once its delay has passed since the last completed one.

### Cadence (what is e-mailed)

- Enrolment comes from an e-mail campaign with a sequence. It restarts from step 1 with a new
  run id. Run state is on the contact: `protocolRun.status` (`active`, `processing`,
  `replied`, `completed`, `stopped`), `currentStep`, `nextDueAt`, `runId`.
- Each step waits its `time`. Only `email` steps send; others only add their delay.
- An e-mail step is skipped when it has no `subject` of its own (the template's subject is
  not used). Step e-mails are `Email` records with `contactProtocol`, `stepIndex` and `runId`.
- A reply (when the mailbox allows reading), an unsubscribed, bounced or complained address,
  or missing marketing consent (when the account requires it) stops the run. Three failed
  attempts on a step stop it too.
- The sender is the contact's owner mailbox (or its creator).
- Deactivating a protocol does not stop runs; deleting it does. Pause:
  `PUT /v2/contactprotocol/pause {"contactId"}` sets `stopped`.

## Goal (`/v2/goal`)

`goalName` (required), `assignee` (required, the seller), `startDate`, `endDate` (required,
end not before start), `targetValue` (≥ 0), `currency` (default: the account's). Code
`GOL-…`. No uniqueness by seller and period. Reports join goals to deals by `assignee` and
use `startDate` as the period. Rows without `goalName` come from an older version and are
listed apart. Sales Agents read their own goals only; creating or editing needs a manager
role. The Goals menu depends on an account preference.

## UserGroup (read only here)

`users` is the rotation order. The platform's own rotation (contacts from forms and ad
campaigns, with load balancing on) takes the first active user and moves it to the end of
the list. The script never writes the group, so that order is untouched. Users count as
active only with `status: "Active"`.
