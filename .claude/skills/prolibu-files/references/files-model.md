# Cloud Drive and short links: the model

Read this when a case falls outside the steps in `SKILL.md`. Everything here was checked against
the platform's code and, where marked "live", on a test account.

## The `File` record

| Field | Meaning |
| --- | --- |
| `filePath` | Path inside the owner's drive. Folders end in `/`. Unique per owner (`createdBy` + `filePath`). The server swaps `< > : " \| ? *` for `-` and drops `.`/`..` segments. |
| `fileName` | Last part of the path (set by the server). |
| `type` | `File` or `Directory` (from the trailing `/`). A file cannot become a folder or the other way round. |
| `parent` | The folder record (set by the server; missing parent folders are created). |
| `isPublic` | Who opens the URL (below). Default `false`. |
| `url` | `https://s3.amazonaws.com/<store>/domains/<domain>/files/<ownerId>/<path>`, URL-encoded. |
| `size`, `mimeType`, `family`, `sha256`, `thumbnail` | Set by the server on upload. JPEG, PNG and video files get a `.thumb-<name>.jpg` record next to them (`isThumbnail`), created **public** even when the file is private; the file's `thumbnail` holds its URL. Closing it: `visibility` → private on that record. |
| `allowEveryone.view`, `collaborators` | In-app sharing (signed-in users only). |
| `trashedAt`, `trashedFrom` | Set on the trash copy: when, and the original `{filePath, isPublic}`. |
| `fileCode` | `FLE-…`; the trash copy gets `<code>-trash`. |

The drive app lists a folder with `parent=<folderId>`; this skill pages on `_id` with a filter on
`createdBy` + a `filePath` prefix instead, which the server indexes.

## Routes

| Call | Does | Role permission |
| --- | --- | --- |
| `GET /v2/file?xquery=…` | List (record permissions apply: own files, shared ones, same-workspace rules, `allowEveryone`) | `File.find` |
| `GET /v2/file/search?term=` | Search by name, description, tags | `File.search` |
| `GET /v2/file/<id>?signUrl=true` | Adds `signedUrl` (15 min; the requested expiry is ignored) | `File.findOne` |
| `POST /v2/file?filePath=<path>&isPublic=<bool>` multipart `file` | Upload | `File.create` |
| `POST /v2/file` `{"filePath":"X/"}` | New folder | `File.create` |
| `PATCH /v2/file/<id>` `{"isPublic":…}` / `{"filePath":…}` | Visibility / move or rename | `File.update` |
| `DELETE /v2/file/<id>` | Move to the trash (or erase, if the trash is off) | `File.delete` |
| `DELETE /v2/file/<trashId>?permanentlyDelete=true` | Erase from the trash | `File.delete` |
| `PUT /v2/file/actions/restoreFromTrash/<trashId>` | Restore | `File.actions` |
| `PUT /v2/file/actions/unzip/<id>` | Unzip next to the zip | `File.actions` |
| `PUT /v2/file/share/everyone/<id>` `{"share":true}` | Share with all users (view) | `File.share`, owner only |
| `PUT /v2/file/share/collaborators/<id>` `{"add":[ids],"remove":[ids]}` | Share with users | `File.share`, owner only |
| `GET /v2/file/shared-with-me` | What others shared with me | signed in |
| `GET /v2/file/userStorage` | Quota and use | `File.userStorage` |
| `GET /v2/file/info/<id>` | Metadata of a **public** file, **no key needed** | none |
| `GET /v2/file/list/view/<ownerId>/?filePath=<folder/>` | HTML listing of a **public** folder, **no key needed** | none |

A role check runs first (`Resource@File.<action>`); then the record check (owner, sharing,
workspace rules). Admins pass both, except sharing, which is owner-only. A sales profile on a
test account had create, delete, find, findOne and search, and got 403 on update, actions and
share (live).

## Public files: what is exposed

- The URL opens without signing in (live: 200, `Content-Disposition: inline`, no `X-Robots-Tag`,
  no cache headers). Private: 403 (live).
- The URL is the owner id plus the folder and file names: whoever has one public link of a user
  can guess siblings.
- `/v2/file/info/<id>` returns the whole record of a public file without a key (live), and a
  public folder has an anonymous listing page of its public children (live).
- A folder's visibility is copied to everything inside it, and a file created or left inside a
  public folder is forced public.
- Revoke: `visibility` → private (the store's access changes at once), or trash it. Then check
  the URL from outside. Copies made earlier by moves or renames of a public file keep their
  access and have no record (see below). Anything already downloaded or forwarded stays out.

## Moves, renames and copies

- Moving or renaming a **file** copies the stored bytes to the new name with the file's current
  access and recomputes `url`; the old copy stays. If the file was public, the old URL keeps
  working, and making the file private later does not reach it (live-verified). The only way
  through the API: upload a private placeholder at the exact old path, which replaces the stored
  copy as private (live-verified: old URL 200 → 403). The script avoids the leak with
  private → move → public (live-verified: old URL 403, new 200), unless a public folder forces the
  file public, and checks the old URL after the move.
- The preview image is **not** moved or renamed: its record and URL keep the old name and access.
- Moving or renaming a **folder** rewrites the children's `filePath` in the database only: their
  bytes and `url` stay at the old path, so private children no longer open with a signed link
  (live-verified: signed link 200 before, 404 after; renaming the folder back repairs it). The
  script blocks folders that have files.

## Trash

- On by default, kept 5 days (`modules.tools.cloudDrive.trash.retentionDays`, admin setting),
  emptied daily. If an admin turned it off, a delete erases for good: `limits` shows it to admins;
  the script blocks a trash plan when it can see the trash is off.
- Deleting a file creates a **new record** at `Trash/<path>` (`" (N)"` if taken), private, and
  erases the original record and its bytes. Records that referenced the old id lose the file.
- Deleting a folder erases the folder record and trashes each file inside separately.
- Restore uses `trashedFrom` and brings back the old visibility; the thumbnail is regenerated.
- A file in the trash cannot be deleted without `permanentlyDelete=true`.

## Upload limits (account preferences `modules.tools.cloudDrive`)

| Setting | Default | Who reads it |
| --- | --- | --- |
| `uploadRestrictions.maxFileSizeMB` | 20 (platform ceiling 120) | everyone (`/v2/user/preferences`) |
| `uploadRestrictions.blockExtensions` | `[]` | admin (`/v2/preference/read`) |
| `advancedSecurity.enabled` | `false` | admin |
| `advancedSecurity.allowedMimeTypes` | `[]` (any) | admin |
| `advancedSecurity.validateMagicNumbers` | `false` (checks JPEG, PNG, GIF, PDF, ZIP, WebP headers) | admin |
| `advancedSecurity.scanMaliciousContent` | `false` (text and PDF: `<script>`, `javascript:`, `on…=`, `<iframe>`, `eval(`…) | admin |
| `advancedSecurity.forceDownloadHeaders` | `false` | admin |

Also: the user's storage quota, and a record field's own `ext` / `maxBytes` when the file goes
into a record field. The limits apply to uploads through the API; the unzip action and files the
platform generates skip the size limit.

## Zip

`unzip` extracts a `.zip` from the drive into a folder named after it, next to it, with the zip's
visibility, as the zip's owner. Each entry still passes the blocked-extension list. Sites unzip
their own package into `public/<siteCode>/`: that is `prolibu-sites`' job. There is no "zip a
folder" action.

## Attaching files to records

Fields that point to `File` (a product's gallery, a contract's PDF, an e-mail's attachments, a
workspace logo…) take the file in the record's own create or update:

- multipart, with the file under the field name (`files.gallery`, `assets`…): the server stores
  it at `.api/<Model>/<recordId>/<field>/<name>`, with the field's own visibility (many are public
  on purpose: product images, covers, logos), checks the field's `ext` and `maxBytes`, and for a
  single-file field erases the previous file;
- or JSON with the `_id` of an existing drive file in the field.

So attachments are changed through the record (its own skill: `prolibu-catalog`,
`prolibu-contracts`, `prolibu-document-design`…), never by moving or deleting `.api/` files.

## Short links (`ShortUrl`)

| Field | Meaning |
| --- | --- |
| `shortUrlCode` | The code in `https://<domain>/r/<code>`; random 8 letters and digits unless chosen. Primary key. |
| `url` | Where it redirects. |

- `GET /r/<code>` answers 302 to `url` and adds the visitor's query parameters that the
  destination does not already set (live). Links to a deal's proposal or a virtual tour answer
  a preview page first (for link previews in chats), then redirect.
- No expiry, no click count, no owner check on opening. Revoke = `DELETE /v2/shorturl/<code>`
  (then 404) or point it elsewhere with `PATCH`.
- `POST /v2/shorturl/generate` `{url, code?}` is what the app uses: it returns the existing code
  if any link already has that exact URL, and the record it creates has **no owner**, so a
  non-admin cannot read, change or delete it afterwards (live: 403). This skill creates with
  `POST /v2/shorturl` instead: the user owns the link and can revoke it.
- The platform accepts any destination, any scheme and any domain (live). The script allows only
  `https://`, and another domain only after the user confirms it.
- Made by the app on its own (no owner): proposal links from the proposal wizard, links appended
  to WhatsApp and push notifications, shared project timelines and vCard links.
