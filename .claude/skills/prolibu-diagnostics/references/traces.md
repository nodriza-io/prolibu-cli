# Traces: what each one records, and what it cannot show

Verified against the platform's code and a test account. Read this when a case falls
outside the steps of `SKILL.md`.

## Who can read what

| Trace | Admin | Default seller role |
| --- | --- | --- |
| Audit log (`/v2/auditlog/getlogs`) | yes, when enabled | 403 |
| Logs (`/v2/log`) | yes | 403 |
| Webhooks | yes | 403 |
| Notice settings (`/v2/eventsubscription`) | yes | 403 on the list |
| Users (`/v2/user`) | yes | 403 on the list |
| Sign-in attempts (`/v2/loginactivity`) | all | own attempts only, whatever the filter |
| Stage history, e-mails, notices | all | records the user can see |
| Account switches (`/v2/user/preferences`) | yes | yes |

## Logs (`Log`)

- Types: `Script`, `Contact Submission`, `Ticket Submission`, `System`, `AiAgent`,
  `All User Sessions Deleted`, `Other`. Status: `Success`, `Failure`, `Warning`, `Info`.
- A script writes a log only on failure, timeout, or `console.info/warn/error`. Its `meta`
  holds `scriptId`, `scriptCode`, `scriptName`, `eventName`, `executionTimeMs`,
  `errorStack`. `console.log` lines are never stored.
- Retention: `expiresAt` is 7 days after creation and the cleanup removes rows 7 days after
  that, so a log lives 7 to 14 days.
- `meta` is free-form. Filter it with a **nested** xquery, `{"meta":{"scriptCode":"x"}}`.
  A dotted key, `{"meta.scriptCode":"x"}`, is dropped without error and every row comes back.
- Submission logs keep the submitted form; the script never prints their `meta`.

## Script gates (record events)

A lifecycle script runs on a record event only when all of these hold: lifecycle hooks are
on for the account, the object is in the account's enabled list, the script is `active`,
and its `lifecycleHooks` lists the object. An error inside the hook fails the user's save
with `"<error> - Lifecycle script [<name>]"`. Scheduled scripts and quote-calculation
scripts have their own triggers (see `prolibu-scripts`).

## Webhooks

- Sent only when the account's webhook switch is on and the copy is not a sandbox; each
  active webhook whose `eventNames` has the event or `<Model>.*` receives it.
- Sent one after another; each waits up to its `timeoutMs` (5 000 by default).
- Status, response and timing are not stored anywhere readable. Only the receiver's own
  logs can prove a delivery.

## E-mails (`Email`)

- `status`: `pending`, `sent` (the provider accepted it), `failed` (with `error`,
  `retries`). `provider`: `google`, `microsoft` or `sendgrid`.
- `delivered`, `bounced`, `complained` are set only by SendGrid's event feed. For Gmail and
  Microsoft, a bounce arrives in the sender's mailbox and is not tracked.
- `events[]`: `open`, `click`, `reply`, `delivered`, `bounce`… with `machine: true` for
  security scanners.
- A contact whose `emailStatus.state` is `unsubscribed`, `bounced` or `complained` makes
  the e-mail fail at creation: no record exists for those attempts.
- `POST /v2/email/notify` and system notices create no e-mail record.
- The tracking and opt-out links (`/v2/email/view|click|unsubscribe|consent/…`) record an
  open, a click or an opt-out when called. Never call them.

## Notices (`Notification`, `EventSubscription`)

The decision for each recipient, in order:

1. The user must be `Active`; otherwise nothing, silently.
2. Notice settings are read raw. A user without settings gets the defaults, saved at the
   first notice.
3. No channel on for that event: nothing for that user.
4. The person who caused the event is the recipient: skipped (unless the sender marks it as
   a self-notice).
5. `notificationCenter` creates a `Notification` record — the only channel that leaves one.
6. `email` sends only from production accounts.
7. `ultramsg` (WhatsApp) needs WhatsApp on for the account and the user's WhatsApp or
   mobile number.
8. Slack, Telegram and Discord need their integration on and the user's channel ids.
9. The same notice, for the same record and channel, goes out at most once in 24 hours.
10. Errors are swallowed; nothing reports a failed send.

`GET /v2/eventsubscription/getMine` saves the merged defaults: it writes. Read settings with
`/v2/eventsubscription?xquery={"user":"<id>"}` (admin).

## Stage history (`StageHistory`)

- Written only when stage history is on and `<Model>.<field>` is in the tracked list.
- `origin.modelName`, `origin.docId`, `stageField`, `fromStage`, `toStage`, `movedBy`,
  `movedAt`. Filter with `xquery {"origin":{"modelName":"Deal","docId":"<id>"}}`; the
  `modelName`/`docId` query parameters are ignored and return every row.
- `populate=movedBy` returns the whole user; use `populatePath` with a `select`.

## Audit log

- Parameters: `startTime`, `endTime` (ISO; **default: the last 24 hours**), `event`,
  `actorEmail` (exact), `targetModel`, `limit` (≤ 500), `page`. There is no `targetId`
  filter: the script filters locally.
- Row: `occurredAt, event, actor, actorEmail, ip, userAgent, targetModel, targetId, detail,
  result, reason`. On create and update, `detail.changes` is the payload sent; on delete,
  the record's display name.
- Events: `auth.signin|signout|signinFailed|mfaVerified|mfaFailed|passwordReset`,
  `user.*`, `role.*`, `token.*`, `security.policyChange`, `operation.create|update|delete`.
  Record operations appear only for the objects the account enabled; user, role and token
  changes always appear while the audit log is on.
- Only saves made through the API are audited; changes made inside the server by hooks and
  scheduled jobs are not.
- A window with more than 10 000 matches loses the **newest** rows. Keep windows short or
  filter by event, actor or model.
- An account without the feature answers "Audit log feature is not enabled" (exit 3).
- The script keeps a row only if its record (or, when there is none or it was deleted, its
  actor) exists on this account, and reports how many it left out.

## Sign-in attempts (`LoginActivity`)

- `email, loginStatus (Success|Failure), reason, ip, country, regionName, city, isp, os,
  browser, device, createdAt`. The reason is stored in the account's language at the time.
- Usual reasons: invalid credentials, unknown user, too many attempts (wait 5 minutes),
  suspicious activity (IP blocked), user without a password, password changed.
- The second-factor step and failed second-factor codes are not recorded here.

## Things that do not exist as traces

- HTTP access logs and server console output (webhook errors, SMTP errors, notice errors).
- Per-field history of a record, other than the audit log and stage history.
- Delivery of webhooks, notice e-mails, WhatsApp, Slack, Telegram or Discord messages.
