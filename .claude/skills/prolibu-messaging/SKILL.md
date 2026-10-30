---
name: prolibu-messaging
description: Build e-mail templates with variables, contact lists and e-mail campaigns in Prolibu the way the app does it — check every {{variable}} against what a campaign can fill, preview the e-mail rendered for a real contact, count who would really receive it (unsubscribed, bounced, consent), save campaigns only as drafts, and send only after a separate yes, defaulting to one test e-mail to the user's own address. Also reads WhatsApp channels, conversations and messages (read only). Use it whenever someone wants an e-mail template, a mailing list, a newsletter or campaign, a test send, to schedule or pause a campaign, to see who opened it, or to look at WhatsApp conversations; or reports variables that came out empty, "[object Object]" in an e-mail, a campaign that cannot be saved, or contacts that did not receive it. Spanish triggers: "plantilla de correo", "campaña de correo", "lista de contactos", "envío de prueba", "programar campaña", "variables vacías", "conversaciones de WhatsApp".
---

# Prolibu Messaging

## Central idea

Four objects make an e-mail campaign:

- a **MessageTemplate** (subject + HTML with `{{variables}}`);
- a **ContactList** (a plain array of contact ids);
- an **EmailCampaign**, which holds its own **copy** of the subject and HTML and its own
  **copy** of the contact ids (it has no link to the template or the list);
- one **Email** record per recipient, created while it sends.

The server fills the variables per recipient with only four roots: `contact`, `me` (= `sender`,
the user who created the campaign), `variables` (the campaign's own key/values) and two
send-time links. **Anything else renders empty, silently.** And **a sent e-mail cannot be
recalled**: that is why saving never sends, and sending has its own preview and its own yes.

`scripts/messaging.js` does the fragile parts in code: it validates templates with the server's
engine rules (five helpers), lints every variable against the account's fields, renders the
e-mail for one real contact, counts recipients by the server's send gates, keeps existing
contacts when a list changes, copies template and lists into a campaign like the app, and
sends only with a send-preview version plus `--confirmed-send`.

```
node .claude/skills/prolibu-messaging/scripts/messaging.js <command> <domain> …
  templates <domain> [term] [--whatsapp]    lists <domain> [term]    campaigns <domain> [term]
  contacts  <domain> <name, e-mail or id>   show <domain> <template|list|campaign> <id> [--sample <contactId>]
  preview   <domain> '<plan json>' [--sample <contactId>]           writes nothing; returns a version
  apply     <domain> '<plan json>' --version <v> --confirmed        saves; NEVER sends
  send-preview <domain> <campaignId> [--live] [--test-contact <id>] writes nothing; returns a sendVersion
  send      <domain> <campaignId> --send-version <v> --confirmed-send [--live --recipients <n>]
  pause     <domain> <campaignId> --confirmed
  channels <domain>    conversations <domain> [--contact <id>] [--channel-type whatsapp]    messages <domain> <conversationId>
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written).

## Ask the user first

In plain business terms:

1. **What the e-mail says**, and which personal data goes in it (name, company, the sender's name).
2. **Who gets it:** an existing list, contacts to search, or a new list.
3. **Which mailbox it leaves from:** Google or Microsoft (the campaign creator's own connected
   mailbox), or SendGrid if the account has it.
4. **Test first?** Always offer it; the default test goes to the user's own address.
5. **When:** now or a date and time (with the time zone).

If `accounts/` has several domains, ask which one.

## Steps

1. **Read.** `templates`, `lists`, `campaigns` or `contacts <term>` to find ids. Pick a real
   recipient as the sample (`--sample`) so the preview shows real values.
2. **Template.** Plan `{"template": {"name", "subject", "content"}}` (add `"id"` to change one).
   Write variables as `{{contact.firstName}}`, `{{contact.company.companyName}}`,
   `{{me.firstName}}`, `{{variables.promo}}`. Helpers: `{{default contact.firstName "there"}}`,
   `uppercase`, `lowercase`, `{{shortDate contact.createdAt "DD/MM/YYYY"}}` (UTC),
   `{{toCurrency amount "COP"}}`. Nothing else exists (`capitalize`, `formatDate`… are rejected).
3. **List.** Plan `{"list": {"name", "description", "add": [ids], "remove": [ids]}}`. The script
   keeps the contacts already in it.
4. **Campaign draft.** Plan `{"campaign": {"name", "provider", "templateId", "listIds": [...],
   "addContacts", "removeContacts", "variables": {"promo": "NOV-10"}, "scheduledAt"}}`.
   Template and lists are **copied** at this moment; later edits to them do not reach the
   campaign (repeat the plan with `templateId` or `listIds` to copy again).
5. **Preview.** `preview <domain> '<plan>' --sample <contactId>`. Tell the user: what changes,
   the rendered subject and text for that contact, every warning (empty variables, skipped
   recipients), and the recipient counts. `sample.notPreviewed` are sender fields this key cannot
   read; say they fill in at send time.
6. **Wait for an explicit yes, then save.** `apply <domain> '<same plan>' --version <v> --confirmed`.
   It refuses when anything changed since the preview. A saved campaign stays a draft (`Paused`).
7. **Test send (only if the user asks for it, after its own yes).** `send-preview <domain> <id>`
   names the one address that gets it (the user's own contact by default). Show it, ask
   "send one test e-mail to <address>?", and only after that yes: `send <domain> <id>
   --send-version <v> --confirmed-send`. A different test recipient only when the user names it
   (`--test-contact`).
8. **Launch or schedule (after a separate yes that names the number).** `send-preview <domain>
   <id> --live` gives the recipients, how many really receive it, when, the sender and a sample.
   Say clearly that it cannot be undone. Only when the user answers yes to *that* number:
   `send <domain> <id> --send-version <v> --confirmed-send --live --recipients <n>`. With a
   future `scheduledAt` this schedules; otherwise it starts now.
9. **Report.** Ids, names, the status (`Paused`, `Scheduled`, `Sending`), and for a test the
   address and whether it left. Follow a campaign with `show <domain> campaign <id>`.

A yes to save is never a yes to send. A yes to a test is never a yes to launch.

## How the platform behaves

Details and evidence are in `references/messaging-model.md`. Read it for cases outside the steps.

- **Saving a campaign needs the creator's mailbox.** Even a draft is refused (400) when the user
  behind the key has not connected Google or Microsoft with send permission (or SendGrid is off).
  `from` is that mailbox. Do not look for a way around it: the user connects it in the app.
- **Only creator, assignee or a collaborator** may send, test, pause or read live stats; not even
  an admin. The e-mails still leave from the creator's mailbox.
- **Campaign variables:** `contact` (any depth: the server populates what the template names),
  `me`/`sender`, `variables`. `{{firstName}}` without `contact.` and `{{deal.…}}` render empty.
  A path that ends on a record (`{{contact.company}}`) prints "[object Object]".
- **The server validates on save:** an unknown helper or an unclosed block answers 400. The
  script blocks it first.
- **Send gates, per recipient, at send time:** no e-mail, unsubscribed, bounced or complained
  contacts are skipped; if the account enforces habeas data, only accepted consent (or not
  rejected, by setting) gets marketing. `consent` and `emailStatus` cannot be changed by API.
- **Unsubscribe is automatic** in campaign e-mails (footer link and one-click header). Do not add
  your own; there is no `{{unsubscribe}}` tag. One-off e-mails have none.
- **One e-mail per contact per campaign.** A test counts in the stats, cannot be repeated to the
  same contact, and if the test contact is also a recipient, the launch skips them.
- **Launched means frozen.** The server refuses content edits while `Sending` and after `Sent`;
  the script edits only `Paused` drafts. `pause` stops the e-mails not sent yet; sent ones stay
  sent.
- **A scheduled date does nothing alone:** only `send --live` schedules.
- **WhatsApp is read only here.** Sending, retrying, saving a WhatsApp template (it goes to Meta
  or Twilio for review) and changing channels, numbers or flows all reach real people or outside
  services: send the user to the app. Outside 24 h from the customer's last message, only an
  approved template can be sent (`whatsappWindowOpen` in `conversations`).

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| "No email provider found…" when saving a campaign | Creator has no connected mailbox | User connects Google/Microsoft in the app |
| A variable came out empty | Bare `{{firstName}}`, other root, typo, or empty on that contact | `preview --sample`; use `contact.` paths |
| "[object Object]" in the e-mail | Variable ends on a record | Name a field: `contact.company.companyName` |
| 400 "Missing helper" / "Parse error" | Helper the engine lacks, or unclosed block | Use the five helpers; close blocks |
| Fewer people got it than were in the list | Unsubscribed, bounced, no e-mail, no consent, already e-mailed | `show … campaign <id>`: `delivery.failedReasons` and `recipients` |
| New list contacts did not get the campaign | The campaign copied the list earlier | Plan with `listIds` again before launching |
| Second test fails | One e-mail per contact per campaign | Another test contact, or a new campaign |
| 400 "Forbidden…" on send, pause or stats | Not creator, assignee or collaborator | The owner does it, or adds the user as collaborator |
| A paused campaign relaunched: sent at the old time, or some never got it | Queued jobs keep their time and id for 7 days | To reschedule or edit a launched campaign, make a new one |

## Verify

- To diagnose a sent campaign, `show <domain> campaign <id> [--sample <contactId>]` gives its
  variables with warnings, `delivery` (sent, failed and each failure reason) and live stats.

- `apply` reads the record back: template fields as sent; the list holds every contact; the
  campaign is `Paused`, with the expected recipients and a `from`.
- `send` reads back: a test e-mail's status (`sent` or the error); a launch's campaign status.

## Don't

- Send, test, schedule or pause without the user's separate yes to that exact action.
- Call `PUT /v2/emailcampaign/sendCampaign`, `PUT /v2/email/send`, `POST /v2/email` (it sends
  immediately by default), `POST /v2/email/notify` or `POST /v2/message/send` by hand, or use an
  AI assistant's send-email tool. Only `send` in this script sends.
- Set `sequence`, `consentRequest` or a presentation on a campaign: do it in the app.
- Edit a block-editor template's HTML, or create or change WhatsApp templates, channels, phone
  numbers or conversation flows. Never read `ChannelProvider` (credentials).
- Add an unsubscribe link, or try to re-subscribe a contact.
- Read `profile.json` or call the API with `curl`: reads go through this script (`show`,
  `contacts <id>`) or the generic helper.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step and `apply`
the write. Sending adds a second, separate cycle: `send-preview`, its own yes, `send`. For
sequences (cadences) and objects without a skill, see `prolibu-platform-map`.
