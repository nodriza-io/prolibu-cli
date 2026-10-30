---
name: prolibu-forms
description: Create, change, test and troubleshoot a Prolibu web form (web-to-lead, web-to-case, survey, sign-up) the way the app's form builder does — the questions, what each submission creates (a Contact, Deal, Ticket or custom-object record) and which field each answer fills, who may send it, what the visitor sees afterwards, stored submissions and notifications — then check it against the account's real objects, save it, read it back and hand over the public link. Use it whenever someone wants a contact form, lead capture, landing-page form or questionnaire on a Prolibu account, or reports a form that asks for a captcha it never shows, answers 400, 404 or 429, or says "sent" but creates no record. Spanish triggers: "formulario", "formulario de contacto", "formulario web", "captar leads", "encuesta", "el formulario no crea contactos", "pide captcha".
---

# Prolibu Forms

## Central idea

A Form is a page the platform hosts at `https://<domain>/v2/form/view/<formId>`. Its questions
live in `formSchema`. Its `mappings` say what each submission creates: one new record per
mapping, filled from `fieldMap` (**key** = form field key, **value** = field path on the
object) plus fixed `defaults`. The records one submission creates are not linked to each other.

Forms break silently: a target path the object does not have is dropped, a required object
field nobody fills makes every submission "succeed" without a record, and an empty access mode
asks for a captcha the page never shows. `scripts/form.js` checks all of that against the
account's real objects before saving, saves, and reads the form back.

```
node .claude/skills/prolibu-forms/scripts/form.js <command> <domain> …
  list        <domain> [<part of the name>]
  show        <domain> <formId | formCode>
  fields      <domain> <Object>                       (Contact, Deal, Ticket, a custom object…)
  preview     <domain> '<form json>' [--form <formId>]
  create      <domain> '<form json>' --confirmed
  update      <domain> <formId> '<changes json>' --form-version <v> --confirmed
  submit-test <domain> <formId> '<data json>' --confirmed
  submissions <domain> <formId> [--limit <n>]
```

Output is JSON. Exit codes: 0 ok, 1 API error (or a test submission that created nothing),
2 usage error (nothing sent), 3 blocked (nothing written). JSON goes inline in single quotes,
or as the path of a file in a temp folder.

## Ask the user first

In plain business terms:

1. **What should each submission create?** A contact (lead), a deal, a ticket, a record of
   another object, or several.
2. **Which questions?** For each: the label, whether it is required, and which field of the
   record it fills. An answer that fills nothing is still kept (see "How the platform behaves").
3. **Who may send it?** Anyone (public, with a captcha), only signed-in users of the account,
   or anyone with a password.
4. **What does the visitor see after sending?** A thank-you title and message, in the
   visitor's language, or a jump to a web address.
5. **Keep each submission as a log entry?** Recommend yes: it is the only trace of a submission
   whose record failed.
6. **Notify or hand out?** Users who get an email per submission; a user group that receives
   the new records. Both reach real people, so confirm the names.

If the account has several domains under `accounts/`, ask which one.

## Steps

1. **Look first.** `list <domain> "<name>"`. If the form exists, `show <domain> <id>` and change
   it instead of making a second one.
2. **Read the target object.** `fields <domain> Contact` lists its field paths, which ones are
   required, and the allowed options of fixed-list fields. Use only these paths.
3. **Write the definition** the way the app's builder writes it:

   ```json
   {
     "formName": "Website contact",
     "formSchema": {
       "fullName": { "type": "String", "label": "Name", "required": true },
       "email":    { "type": "String", "format": "email", "label": "Email", "required": true },
       "phone":    { "type": "String", "uiCom": "PhoneWithIndicative", "defaultCountry": "CO", "label": "Phone" },
       "message":  { "type": "String", "uiCom": "TextArea", "label": "Message" }
     },
     "mappings": [{
       "modelName": "Contact", "action": "create",
       "fieldMap": { "fullName": "firstName", "email": "email", "phone": "mobile" },
       "defaults": { "source": "Website contact", "direction": "Inbound" }
     }],
     "access": { "mode": "public", "enableCaptcha": true },
     "thankYou": { "title": "Thank you!", "message": "We will contact you soon." },
     "submissions": { "persist": true, "notifyOnSubmit": [] }
   }
   ```

   - Field keys: letters and digits, never starting with `_`, never `title`, `description`,
     `mode`, `theme` or `pages` (reserved in a one-page form).
   - Field formats, multi-page forms and every setting: `references/form-model.md`.
   - Always set `access.mode`. Set `thankYou` in the visitor's language: the default is Spanish.
   - `defaults.source` names where the lead came from (shown in notifications and reports).
4. **Preview.** `preview <domain> '<json>'`. It writes nothing. Tell the user, in plain words:
   - each `error` (the server would reject the form, or it could never create its record) and
     how you will fix it; preview again until there are none;
   - each `warning` and `note`;
   - `submittable`: if `ok` is false, say why (for example, no captcha credential).
5. **Wait for an explicit yes.**
6. **Create.** `create <domain> '<same json>' --confirmed`. On `"saved": true`, give the user
   `form.links.view` and say in one line who can send it.
7. **Change an existing form.**
   - `preview <domain> '<changes>' --form <formId>`, then, after a yes,
     `update <domain> <formId> '<same changes>' --form-version <formVersion> --confirmed`.
   - Changes are top-level keys. `formSchema` and `mappings` replace the stored ones whole:
     send every field and every mapping, not only the new one. `access`, `thankYou`,
     `submissions` and `uploads` merge key by key.
   - Removing or renaming a field: send `mappings` without its key, or the save fails.
   - To turn a form off: `{"active": false}`. Do not delete it.
8. **Test, only with its own yes.** A test submission creates real records.
   - `submit-test <domain> <formId> '{"fullName":"…","email":"…@example.com"}' --confirmed`
     sends it, reads each created record back and shows the stored submission.
   - A public form with captcha cannot be tested from here: ask the user to open the link and
     send it by hand, then run `submissions` or look up the record.
9. **Troubleshoot.** `show <domain> <formId>` runs the same checks on the saved form and lists
   its latest stored submissions; `submissions` shows each one's per-object result.

## How the platform behaves

Details and sources: `references/form-model.md`.

- **Submitting** is `PUT /v2/form/register` with `{"id": "<form _id>", "data": {…}}`, plus
  `captchaToken` (public with captcha) or `password` (password mode). Not POST, not the
  `formCode`.
- **Required questions** are checked first; a missing one answers 400 and nothing is created.
- **Each mapping then runs on its own**: `defaults`, then the mapped answers, then a normal
  create. The answer is 200 even when a mapping fails; its result says `"status": "failed"`.
- **A repeated email** (Contact) does not create a second contact: the result is
  `Duplicated value`, the existing contact gets a note with the answers, and its owner may be
  notified.
- **Unmapped answers are kept** in the stored submission (when `submissions.persist` is on) and,
  for a Contact, in that contact's submission history.
- **Access.** `public` + captcha uses Cloudflare Turnstile and needs an active Cloudflare
  credential on the account; without one the page shows no captcha and every submission fails.
  An empty mode behaves as public on submit, but the page only shows the captcha for
  `public`, so nobody can send it. `password`: the server generates a password only when the
  form is created. `authenticated`: only users signed in to the app in that browser.
- **Who owns the records.** With a user group on the form or mapping: round-robin when the
  group balances load; otherwise a Contact waits unassigned and every member is told (other
  objects still use round-robin). Without a group, the creator is the signed-in sender, or else
  the user who created the form.
- **Public links** `view` and `thanks` take the `_id` or the `formCode`; `register`,
  `jsonschema` and `upload` take the `_id` only. An inactive form answers 404 on all of them.
- **Rate limits:** 60 submissions per form per minute and 1000 per IP per minute, then 429.
- **Error messages** come in the account's language.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| Page has no captcha; sending fails with "Captcha token required" | Empty `access.mode`, or public with no Cloudflare credential | Set the mode; for public, an admin adds the credential, or turn captcha off with the user's consent |
| 200 but no record; result `failed` | A required object field is empty, a value does not fit (bad email, option not allowed), or a duplicate | `submissions` shows the error; `show` lists the checks |
| A mapped answer is missing on the record | The target path is not a field of the object; the server drops it | Use a path from `fields` |
| Save fails: "fieldMap references unknown field key" | A mapping still uses a removed or renamed field | Send `mappings` without that key |
| Save fails: "invalid type" | A field type the server does not know (the builder's Matching field is `Object`) | Use a supported type |
| A field shows as a one-line box with no check | Type `email`, `textarea`, `phone`… instead of the builder's format | `String` with `format` or `uiCom` |
| 400 "Cast to ObjectId failed" | `register` or `jsonschema` called with the `formCode` | Use the `_id` |
| 404 on the link | The form is inactive | `{"active": true}` |
| 403 "Invalid password" for everyone | Password mode set on an existing form without a password | Set `access.password` |
| 429 | More than 60 submissions to the form in one minute | Wait a minute |
| "Cannot POST /v2/form/register" | Wrong method | `PUT` |

## Verify

- `create` and `update` read the form back; `saved` must be true and `problems` empty.
- `submittable.ok` is true, or the user knows why not.
- After a test, each created record shows the mapped values in `stored`.
- Give the `view` link and who can send the form.

## Don't

- Build a custom HTML page plus a custom endpoint when a form does the job.
- Write a form with the generic API helper or a hand-made PATCH.
- Turn captcha off on a public form unless the user agreed after hearing it invites spam.
- Show `access.password` in a reply, summary or log; the user reads it in the app.
- Send a test submission without its own yes, or burst submissions.
- Create forms of type `meta`: they mirror Meta Lead Ads and are managed from the Ad Hub.
- Delete forms or the records a test created.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step; `create`,
`update` and `submit-test` are the writes. For objects and how they relate, see
`prolibu-platform-map`; for custom fields on the target object, `prolibu-custom-fields`.
