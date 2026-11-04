# Messaging model: templates, lists, campaigns, e-mails, WhatsApp

Verified against the platform code and a non-production account. Read it when a case falls
outside the steps of `SKILL.md`.

## Objects and paths

| Object | Path | What matters |
| --- | --- | --- |
| MessageTemplate | `/v2/messagetemplate` | `messageTemplateName` (required), `modelName`, `subject`, `content` (HTML), `design` (block editor state), `assets` |
| ContactList | `/v2/contactlist` | `contactListName` (required), `description`, `contacts` (array of contact ids) |
| EmailCampaign | `/v2/emailcampaign` | `emailCampaignName` (required), `provider`, `subject`, `message`, `contacts`, `testContact`, `variables`, `scheduledAt`; system fields `status`, `from`, `sentAt`, `stats`, `jobId`, `error` |
| Email | `/v2/email` | One per recipient and send: `to`, `subject`, `message`, `status` (pending, sent, failed), `error`, `events` (open, click, reply, unsubscribe…), `emailCampaign`, `contact` |
| Channel, PhoneNumber | `/v2/channel`, `/v2/phonenumber` | WhatsApp/SMS/voice channels and numbers |
| Conversation, Message | `/v2/conversation`, `/v2/message` | One conversation per party and channel; messages point to it with `conversation` |
| ConversationFlow | `/v2/conversationflow` | A guide for the person answering in the inbox; nothing runs on its own |

## Templates

- `modelName` says which record the template is for. Campaigns offer only templates with **no
  type or type `Email`**; the script creates type `Email`. Type `Message` is a WhatsApp template.
- A **block-editor** template has `design.format = "blocks"`; its `content` is HTML the app
  regenerates from the blocks on every save. Change those only in the app. When the app copies a
  block template into a campaign it puts `<!-- pl-blocks-template:<template id> -->` and a line
  break before the HTML; the script does the same so the app still recognizes it.
- The app's variable pickers insert different shapes. The block editor inserts full paths
  (`{{contact.firstName}}`, `{{me.firstName}}`). The older HTML editor inserts **bare** paths
  relative to the template's type (`{{firstName}}`). Bare paths work in a one-off e-mail composed
  in that older editor, but **render empty in a campaign**. The script warns about them.
- **Validation on save:** the server compiles and runs `subject` and `content` with its message
  engine (only on the fields that changed). An unknown helper (`Missing helper`) or broken syntax
  (`Parse error`) answers 400. Campaigns run the same check on `subject` and `message`.

### The message engine

- Handlebars with exactly five helpers, the same in the server and the app's preview:

  | Helper | Does |
  | --- | --- |
  | `{{default value "fallback"}}` | The fallback when the value is empty (`undefined`, `null`, `""`; `0` and `false` are values) |
  | `{{uppercase x}}`, `{{lowercase x}}` | Case; empty stays empty |
  | `{{shortDate date "DD/MM/YYYY HH:mm"}}` | UTC; tokens `YYYY YY MMMM MMM MM DD D HH mm`, `[text]` literal; month names in English; default `YYYY-MM-DD` |
  | `{{toCurrency amount "COP"}}` | `en-US` number format; default `USD`; empty when not a number |

- Built-in blocks work: `{{#if}}`, `{{#unless}}`, `{{#each}}`, `{{#with}}`, `{{else}}`. The
  script validates them but leaves them unrendered in its sample (`approximate: true`).
- `{{x}}` escapes HTML (`&` → `&amp;`); `{{{x}}}` does not. The subject is never escaped.
- A missing value renders empty, never an error. An object renders "[object Object]".

## What a campaign e-mail can use

The server builds the same context for a campaign, its test and a sequence step:

| Root | Is | Notes |
| --- | --- | --- |
| `contact` | The recipient, re-read in full | Any field, any depth: the server populates the references the template names (`contact.company.companyName`). `contact.fullName` is first + last name, or the e-mail |
| `me`, `sender` | The campaign **creator** (not the person who launches it) | Any user field; `fullName` too |
| `variables` | The campaign's `variables` | Stored as `[{"promo": "NOV-10"}]`; the script takes `{"promo": "NOV-10"}` |
| `presentationUrl` | Link to a presentation | Only campaigns with a presentation; otherwise the save is refused |
| `consentAcceptUrl`, `consentRejectUrl` | Habeas data buttons | Only consent-request campaigns; otherwise the save is refused |

There is no `deal`, `company` (at the root) or `unsubscribe` tag. One limit of the server's
populate: inside `{{#with}}` or `{{#each}}`, a nested reference written relative to the block is
not populated.

## Contact lists

- `contacts` is a plain array of ids. A `PATCH` replaces the whole array: send all of them (the
  script does). The server does not check that the ids exist.
- A campaign does not point to a list. The app's "import contacts" merges the list's ids into
  the campaign's own `contacts` (no duplicates). Contacts added to the list later are not in the
  campaign until it is imported again.

## Campaign lifecycle

- `status` is set by the platform: `Paused` (draft or paused), `Scheduled`, `Sending`, `Running`
  (sequences), `Sent`.
- **Saving** (create or update) requires, for a single send, `provider`, `subject` and
  `message`, and resolves `from` from the creator's connected Google/Microsoft mailbox, checking
  it can send; SendGrid uses the account's sender. No mailbox: 400 "No email provider found to
  send the email" (translated). Ids in `contacts` that do not exist are dropped silently.
- Content edits are refused while `Sending` and after `Sent`. The script refuses them on every
  status but `Paused`.
- **Launch:** `PUT /v2/emailcampaign/sendCampaign {emailCampaignId, testMode:false}`. Only from
  `Paused`; only the creator, assignee or a collaborator (not admins); checks the mailbox again;
  queues one job per contact; status becomes `Scheduled` when `scheduledAt` is in the future,
  else `Sending`. Sending runs at about 5 e-mails per second; at the end the status is `Sent`.
- **Test:** the same call with `testMode:true` sends one e-mail to `testContact`, rendered exactly
  like the real one. It creates an Email linked to the campaign, so:
  - it counts in the campaign stats, and toward completion: with a test contact outside the
    audience, the campaign can show `Sent` before its last e-mail left (seen in code);
  - a second test to the same contact fails: one e-mail per contact per campaign;
  - if that contact is also a recipient, the launch skips them.
- **Pause:** `PUT /v2/emailcampaign/pauseCampaign {emailCampaignId}` stops the queued e-mails (on
  `Scheduled`, `Sending` or `Running`): each job still fires at its time and does nothing while
  the campaign is paused. Relaunching is the same launch call. Platform caveat (seen in code, not
  tested live): a job keeps its id while queued and for 7 days after it ran, and a relaunch does
  not replace it. So a paused scheduled campaign relaunched with a new date still sends at the
  **old** time, and contacts whose turn came while it was paused may never be sent. To change
  the date or content of a scheduled campaign, a new campaign is the safe route.
- The server itself does not block content edits on a `Scheduled` campaign; the queued e-mails
  read the campaign when they fire. The script blocks them anyway (pause first, or a new campaign).
- **Stats:** `GET /v2/emailcampaign/<id>/stats` recomputes from the Email records (only
  creator, assignee or collaborators); the campaign's `stats` field is a stored copy. Counts:
  `total`, `accepted` (sent), `delivered`, `opened` (human), `machineOpened`, `clicked`, `replied`,
  `bounced`, `complaints`, `unsubscribed`, `failed`, consent counters.

## Who is skipped at send time

Checked per recipient, in this order. Skipped recipients get a failed Email with the reason:

1. The contact no longer exists.
2. `emailStatus.state` is `unsubscribed`, `bounced` or `complained` ("Recipient suppressed").
3. Habeas data, when the account enforces it: not `consent.state = accepted` (or, with the
   "include pending" setting, `rejected`) → "No marketing consent". Consent-request campaigns
   are exempt. Only an admin can see the setting; the script reports the consent counts.
4. The contact already has an Email for this campaign (a test, or an earlier run).

`emailStatus` and `consent` are written only by the platform (unsubscribe page, provider
webhooks, consent landing). There is no API to re-subscribe a contact.

## Unsubscribe and compliance

Campaign and sequence e-mails get, automatically:

- a `List-Unsubscribe` one-click header;
- a footer with an "Unsubscribe" link and the account's postal address, when one is configured.

Unsubscribing marks the contact for every future campaign. One-off e-mails get none of this.

## One-off e-mails

- `POST /v2/email` **sends immediately** unless `sendImmediately: false` (a draft).
- `PUT /v2/email/send {emailId}` sends a draft and answers 200 even when the provider failed:
  read the Email's `status` and `error` afterwards.
- Both need the user's own connected mailbox. A sent e-mail cannot be edited. This skill does not
  send one-off e-mails: render the template for the contact with `show … template <id> --sample`,
  and the user sends it from the contact's e-mail tab in the app.

## WhatsApp and conversations (read only)

- **What sends:** only `POST /v2/message/send` and `POST /v2/message/<id>/retry`; also an AI agent
  set on a channel (`aiAgentProfile`), which answers inbound messages by itself. Creating a
  `Message` or `Conversation` record does not send, but fakes inbox state.
- **24-hour window:** free text only within 24 h of the customer's last inbound message
  (`lastInboundAt`); after that only an approved template. The server does not check before
  sending: WhatsApp rejects it and the message ends `failed` with `errorMessage`.
- **Templates** are MessageTemplates of type `Message`: `language`, `category`
  (MARKETING, UTILITY, AUTHENTICATION), `whatsappStatus` (approved, pending, rejected, paused,
  disabled), `channel`, numbered `{{1}}` slots. Saving one with a channel and content submits it
  to Meta or Twilio for review; deleting deletes it there.
- **Channel and number saves** configure Twilio webhooks or providers. `ChannelProvider` holds
  credentials: never read it.
- **Opt-out:** there is no WhatsApp opt-out field; `emailStatus` and `consent` apply to e-mail only.
- **Reads:** `conversations` filters by contact and channel type; `messages` lists a
  conversation's messages (status `queued`, `sending`, `sent`, `delivered`, `read`, `failed`,
  `undelivered`). Filtering messages by contact finds nothing: messages carry the conversation,
  not the contact.
