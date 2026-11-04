# Form model: how the platform stores, serves and runs a form

Reference for `prolibu-forms`. Read the section you need.

## The Form record

Managed through `/v2/form` (`POST` to create, `GET`/`PATCH`/`DELETE /v2/form/<_id or formCode>`).

| Field | Notes |
| --- | --- |
| `formName` | Required. The browser title, and the heading of a one-page form. |
| `formCode` | Generated (`FRM-…`). |
| `type` | `web` (default) or `meta`. Fixed after creation. `meta` mirrors a Meta Lead Ads form; it is never served publicly. |
| `description` | Shown under the heading of a one-page form. |
| `formSchema` | The questions (below). A JSON string is parsed on save. Keys set to `null` inside it are dropped. |
| `mappings[]` | `{modelName, action: "create", fieldMap, defaults?, assignmentGroup?}`. |
| `access` | `mode` (`""` default, `public`, `authenticated`, `password`), `enableCaptcha` (default `true`), `password`, `serviceCredential` (a specific Cloudflare credential). |
| `thankYou` | `title` (default "¡Gracias!"), `message` (default "Tu respuesta ha sido enviada exitosamente."), `redirectURL`. |
| `submissions` | `persist` (default `false`): keep each submission as a `FormSubmission`. `notifyOnSubmit`: user ids that get an email per submission. |
| `assignmentGroup` | User group that receives the new records. |
| `uploads` | `enabled` (default `true`), `maxFileSizeMB` (capped at 5). |
| `active` | Default `true`. Inactive: every public route answers 404. |
| `endings` | Deprecated. Use `thankYou.redirectURL` and `submissions.notifyOnSubmit`. |

`PATCH` merges `access`, `thankYou`, `submissions` and `uploads` key by key, and replaces
`formSchema` and `mappings` whole.

## formSchema

Two shapes, both written by the app's builder:

- **One page, no theme: flat.** `{ "<key>": {field}, … }`. The keys `title`, `description`,
  `mode`, `theme` and `pages` are meta keys, never fields.
- **Several pages, or a theme: paged.** `{ "title", "description", "mode": "form", "theme": {…},
  "pages": [{ "name", "title", "description", "visibleIf", "fields": { … } }] }`. Any `pages`
  array makes it a step-by-step wizard. The server merges every page's fields into one set: a
  key repeated on two pages keeps one value.

### Field formats (as the builder writes them)

| Question | Field |
| --- | --- |
| Short text | `{"type":"String"}` |
| Email | `{"type":"String","format":"email"}` |
| Long text | `{"type":"String","uiCom":"TextArea"}` |
| Phone | `{"type":"String","uiCom":"PhoneWithIndicative","defaultCountry":"CO"}` |
| Number | `{"type":"Number"}` |
| Date | `{"type":"Date"}` (sends `YYYY-MM-DD`) |
| Yes / no | `{"type":"Boolean"}` |
| Dropdown | `{"type":"String","enum":["A","B"]}` |
| Radio buttons | `{"type":"String","uiCom":"RadioGroup","enum":[…]}` |
| Rating | `{"type":"Number","uiCom":"Rating","max":5}` |
| Slider | `{"type":"Number","uiCom":"Slider","min":0,"max":100}` |
| Color | `{"type":"String","uiCom":"ColorPicker"}` |
| File | `{"type":"String","uiCom":"File"}` (see Uploads) |
| Section title | `{"uiCom":"Section","label":"…"}` (sends nothing) |

Common properties: `label`, `placeholder`, `required`, `default`, `full` (full width),
`helperText`, `minLength`, `maxLength`, `min`, `max`, `visibleIf`, `requiredIf`.

The server accepts these `type` values (any case): `string number boolean date objectid mixed
array text select email phone url textarea rating slider color file html section`; anything
else is a 400 on save. The builder's Matching field (`type: "Object"`) is rejected. The
lowercase pseudo-types (`email`, `textarea`, `phone`, `rating`…) save, but the hosted page
does not know them and draws a plain one-line box with no check; `file` is the exception.

On submit the form itself only checks `required`. Formats, lengths and options are checked by
the hosted page; after that, only the object's own rules apply when the record is created (a
Contact rejects a malformed email; a fixed-list field rejects other values).

## Mappings

- `fieldMap`: `{ "<form field key>": "<field path on the object>" }`. Paths may go into the
  object's own groups (`address.city`), never through a link (`company.companyName` fails).
  A path the object does not have is dropped without an error. `fields <domain> <Object>`
  (the server's `GET /v2/form/getmodelfields/<Object>`) lists the valid paths.
- `defaults`: `{ "<field path>": <value> }`, applied first; mapped answers override them.
- The server validates on save: `modelName` exists, `action` is `create`, `fieldMap` is not
  empty, and each key is a form field key. It does not check the paths or the required fields.
- Type fit (what the app offers): text → text, link or any; number → number; yes/no → yes/no;
  date → date. A link field takes the `_id` as text. A fixed-list field (`enum`) fails the
  record on any value outside its list.
- Each mapping creates its own record. Two mappings in one form (a Contact and a Deal) are not
  linked to each other.
- The old app (V1) rebuilds `mappings` from its mapping screen and drops `defaults` and
  `assignmentGroup` when someone edits a mapping there. The current app keeps them.

## Access and captcha

| Mode | Page | Submit |
| --- | --- | --- |
| `public` + captcha | Turnstile widget, if the account has a site key | Needs `captchaToken`, verified with Cloudflare |
| `public`, captcha off | Plain form | Anyone, limited by the rate limit |
| `""` (empty) | No captcha widget, ever | Treated as public: with captcha on, "Captcha token required" for everyone |
| `password` | Password gate, checked with `verifyOnly` | Needs `password`; wrong or missing → 403 |
| `authenticated` | Uses the app session of that browser, else a sign-in button | Needs a bearer token of the account; none → 401 |

The captcha keys live in a Service credential with provider Cloudflare (`turnstileSiteKey`,
`turnstileSecretKey`). The form uses `access.serviceCredential` if active, else the active
Cloudflare credential of its workspace, else any active one. `GET /v2/form/jsonschema/<_id>`
returns `turnstileSiteKey`: empty means the page will show no captcha.

## Submitting

`PUT /v2/form/register` (public route) with `{id: "<_id>", data: {key: value}}`, plus
`captchaToken`, `password` or a bearer token, and optionally `verifyOnly: true` (checks access
only, returns `{"verified": true}`).

1. Rate limit: 1000 per IP and 60 per form, per clock minute → 429.
2. The form must be active and not `meta` → else 404. A `formCode` as `id` → 400 (cast error).
3. Access check (table above).
4. Required questions: a missing, null or empty one → 400 naming the field.
5. Each mapping: `defaults` + mapped answers → create. The creator is the group's pick, else
   the signed-in sender, else the form's creator. The workspace is the creator's.
6. Stored submission (`persist`), then the email to `notifyOnSubmit` (answers in the body,
   files attached).
7. Response `200 {results: [{modelName, action, recordId?, status: "success"|"failed",
   error?}], redirectURL}`.

The hosted page shows a success message, then after 2.5 s goes to `thankYou.redirectURL` or to
`/v2/form/thanks/<_id>`.

**Repeated email (Contact):** the mapping fails with `Duplicated value`. The existing contact
gets a note with the answers (once per identical submission) and a new entry in its submission
history; an active owner is notified, and an unowned contact is handed out again by the group.

**Unmapped answers:** kept in the `FormSubmission.data` and, for a Contact, in the
`ContactSubmission.data` of that contact (`/v2/contactsubmission?xquery={"contact":"<id>"}`).

## Stored submissions

`/v2/formsubmission` (when `persist` is on): `form`, `data` (raw answers), `mappingResults`
(same shape as `results`), `status` (`processed`, or `failed` if any mapping failed), `source`
(`web`), `ip`, `submittedBy` (when signed in).

## Assignment

- Group with load balancing on: the next active member becomes the owner (`assignee`) and the
  creator.
- Group with it off: a Contact keeps `assignmentGroup`, stays unassigned and every member is
  told; objects without that field fall back to round-robin.
- A mapping's `assignmentGroup` overrides the form's. In the waiting mode, an `assignee` in
  `defaults` wins and silences the group; with load balancing on, the group's pick wins.

## Uploads

1. `GET /v2/form/view/<id>` embeds a signed `uploadToken` (30 minutes) in the page script.
2. `POST /v2/form/upload`, multipart: `formId`, `uploadToken`, `fieldKey`, `file`.
   Only for a `file` field; `.pdf .doc .docx .jpg .jpeg .png`, content checked; up to
   `uploads.maxFileSizeMB` (5 MB ceiling) → 413; uploads off → 403; bad token → 401;
   60 per IP and 200 per form per minute.
3. Send the returned `fileId` as that field's value in `register`. Files are private.

## Headless rendering

`GET /v2/form/jsonschema/<_id>` (public) returns `formName`, `formSchema`, `fields` (flattened,
keyed by field key), `access: {mode, enableCaptcha}` and `turnstileSiteKey`. It never returns
`mappings` or the password.
