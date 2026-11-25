---
name: prolibu-files
description: Manage a Prolibu account's Cloud Drive (files and folders) and its short links the way the app does it — list, find and audit files (who can open each one, which are public, what a public link exposes), upload with the account's size and type limits, make a file public or private and check the link from outside, share inside the app, move, rename, send to the trash and restore (never delete for good without its own yes), tell record attachments and site packages apart, and create, repoint or revoke short links (/r/<code>). Use it whenever someone wants to upload a file and get a link, see which files are public, move or rename files, recover something from the trash, take a public link down, shorten a link, or reports a link that "does not open", a file that "comes back public", a short link that goes to the wrong place or a 403 when moving or restoring. Spanish triggers: "sube este PDF", "dame un enlace público", "qué archivos públicos hay", "mueve estos archivos a la carpeta", "renombra el archivo", "papelera", "recupera el archivo", "quita el enlace público", "acorta este enlace", "enlace corto", "Cloud Drive", "mis archivos".
---

# Prolibu Files

## Central idea

The Cloud Drive is one `File` record per file or folder (`type` `File` or `Directory`). A file's
place is its `filePath` (`Contratos/2026/acuerdo.pdf`, folders end in `/`), and **every user has
their own drive**: the same path can exist once per owner. Its bytes live in a file store at a URL
built from the account, the **owner's id and the path**. `isPublic` decides who opens that URL:

- **Public**: anyone with the URL, without signing in. The URL is guessable (owner id + names),
  the store sends no `noindex`, and the metadata is readable at `/v2/file/info/<id>` without a key.
  A public folder makes everything inside it public and also gets an anonymous listing page.
- **Private**: only signed-in users with access, through a link signed for 15 minutes.

Three places in a drive are not the user's to edit here: `.api/<Model>/<id>/<field>/…` are
**record attachments** (change them on the record), `public/<siteCode>/…` are **site packages**
(managed with `prolibu-sites`, never through the drive), and `Trash/…` is **the trash**.

`scripts/files.js` does the fragile parts in code: it checks the role permission before writing,
refuses attachments, site packages and key files, blocks the moves the platform gets wrong, keeps
a public file from leaving a public copy behind when it moves, and checks every link from outside
after the write. Your job is the conversation: agree on what goes where and who may open it, show
the preview, and write only after a clear yes.

```
node .claude/skills/prolibu-files/scripts/files.js <command> <domain> …
  limits  <domain>                                  size limit, blocked types, trash, storage
  list    <domain> [--folder <path/>] [--owner me|any|<userId>] [--public] [--trash]
                   [--all-levels] [--include-attachments] [--max <n>]
  public  <domain> [--owner me|any|<userId>] [--max <n>]     every public file, grouped
  find    <domain> <text>                           search by name
  show    <domain> <fileId>                         one file and what it exposes
  signed-link <domain> <fileId>                     15-minute link to a private file
  links   <domain> [--contains <text>]              short links this user can see
  link    <domain> <code>                           one short link and where it goes
  preview <domain> '<plan json>'                    writes nothing; returns a version
  apply   <domain> '<plan json>' --version <v> --confirmed [--confirmed-permanent]
```

Plans: `folder`, `upload`, `visibility`, `move`, `rename`, `share`, `trash`, `restore`, `purge`,
`shorten`, `link-update`, `link-delete` (shapes at the top of the script and in
`references/files-model.md`). Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error
(nothing sent), 3 blocked (nothing written). Add `--profile <name>` only when the user picks it.

## Ask the user first

1. **Public or private?** Default to **private**; the app's drive uploads public by default, this
   skill does not. Before anything public, say plainly: anyone with the link opens it, the link
   can be guessed and indexed, and it stays public until someone makes it private or trashes it.
   For a contact who needs one file once, offer a private file plus a `signed-link` instead.
2. **Which folder and name?** Paths are per user: "Contratos" means the user's own folder.
3. **Which domain?** If `accounts/` has several, ask.

## Steps

1. **Read.** `limits` for uploads; `list`/`find`/`show` to locate files (ids, owner, public or
   not, why). For "what is public", run `public` and group the answer: drive files and folders
   (with their anonymous listing), site packages and record attachments (public by design).
2. **Plan** one action. Examples:
   `{"action":"upload","file":"/tmp/catalogo.pdf","to":"Catálogos/","public":true}` ·
   `{"action":"move","ids":["<id>","<id>"],"to":"Contratos/"}` ·
   `{"action":"visibility","ids":["<id>"],"public":false}` ·
   `{"action":"shorten","url":"https://<domain>/…"}`.
3. **Preview.** Tell the user the `steps` and every `warning` in plain words. If there are
   `blockers`, explain them and stop.
4. **Wait for an explicit yes.** Making something public, trashing, revoking a short link and
   sharing each need their own yes. `purge` (delete for good) needs a yes to exactly that and
   `--confirmed-permanent`; never offer it as the way to "delete" — the trash is the default.
5. **Apply** with the preview's `version`. It refuses if anything changed since the preview.
6. **Report** what `done` says: ids, paths, the URL or short link, and the outside check
   (`anonymousCheck.opensWithoutSignIn`). Give links only from the read-back.

## How the platform behaves

Details and routes are in `references/files-model.md`.

- **Who may do what.** Roles gate each action: `create` (upload, folder), `update` (public or
  private, move, rename), `delete` (trash), `actions` (restore), `share`. A sales profile can
  usually upload and trash but **not** restore, rename or change visibility: the preview says so.
  Only the **owner** can change sharing, not even an admin.
- **Public folders win.** A file inside a public folder is forced public; making it private alone
  is undone by the server. Make the folder private or move the file out.
- **Previews of private images are public.** JPEG, PNG and video files get a small preview image,
  its own record `.thumb-<name>.jpg` next to the file, created public even for a private file.
  `show` gives its id and checks it from outside. For a sensitive image, offer to close it with a
  `visibility` plan on that id (the app then shows no preview for the file).
- **Moving or renaming copies.** The stored bytes are copied to the new name and the old copy is
  kept with its old access, with no record left to manage it; making the file private later does
  not reach it. The script moves a public file as private → move → public so no public copy stays
  behind, and checks the old URL from outside; inside a public folder that is impossible, and the
  preview warns. The preview image is not moved: it keeps the old name and its access.
- **A public copy at an older name** (moved or renamed by the app while public) has no record. To
  close it, upload a small private placeholder at exactly the old folder and name: the stored copy
  is replaced and becomes private (then trash the placeholder if wanted). Check the old URL after.
- **A folder with files cannot be moved or renamed safely**: only the names change, the bytes
  stay at the old place and private files stop opening. The script blocks it; create the new
  folder and move the files.
- **Trash.** Deleting copies the file to `Trash/<path>` with a **new id**, private, and erases
  the original: its public link dies at once, and records pointing at the old id lose it. A
  folder is removed and its files go to the trash one by one. The trash empties itself after the
  account's retention (5 days by default). Restoring puts the file back at its path (" (1)" if
  taken) with the visibility it had.
- **Uploads.** One file per call, up to the account's limit (`limits`, 20 MB by default, 120 MB
  ceiling) and storage quota. An admin may block extensions, allow only some types, or turn on a
  content scan that rejects text and PDF files containing script-like text ("Malicious content
  detected in file"). An existing name is refused ("File already exists"); the script never
  overwrites.
- **Attaching a file to a record** is done on the record, not in the drive: a multipart
  create or update of that record with the file under the field name, or the id of an existing
  file in a file field. See `references/files-model.md`.
- **Short links** (`https://<domain>/r/<code>`) redirect to a stored URL and pass the visitor's
  `?query` along. They never expire and have no click counter. The app makes many by itself
  (proposal and wizard links, notifications, shared timelines) without an owner: only an admin
  sees or changes those. This skill creates owned links (so the user can revoke them), only to
  `https://` addresses, and refuses other domains unless the user confirms (`"external": true`).

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| A file turned private "comes back public" | Its folder is public | `show` names the folder; change the folder or move the file |
| The public link still opens after "quitar el enlace" | A copy left at an older name, the folder is public, or it is the preview image | `show` the file. Preview: `visibility` on its id. Copy at an older name: upload a private placeholder at that exact path |
| 403 on restore, rename or make public | The role lacks `actions` / `update` | Say so; an admin does it |
| 403 "modify sharing settings" | Not the owner | Only the owner shares |
| "File already exists" | Same path for this owner | Another name, or trash the old file first |
| "Storage limit exceeded" | User quota | Free space or ask an admin for more |
| "Malicious content detected in file" | The account's content scan | Clean the file, or an admin relaxes the scan |
| Files inside a renamed folder do not open | Folder renamed with files inside (platform bug) | Move the files back by hand in the app; report it |
| A short link goes to an old address | It was repointed or deduplicated | `link <code>`; `link-update` if the user owns it |
| A signed link lasted longer than asked | The server ignores the requested expiry: 15 minutes always | Treat every signed link as valid 15 minutes |

## Verify

- `apply` reads every record back and checks public URLs and short links from outside, without
  a key. A link that should be closed must answer 403/404; one that should open, 200 or 302.
- After "quitar el enlace", give the user the outside check, and say a copy shared earlier (a
  download, an attachment in an e-mail) cannot be pulled back.

## Don't

- Upload public by default, or publish without saying how it is exposed and how to undo it.
- Touch `.api/…` attachments, `public/<siteCode>/…` site files or `Trash/` paths except to restore.
- Delete for good, or overwrite a file, as a shortcut for "replace" or "delete".
- Move or rename a folder that has files.
- Upload keys, profiles, `.env` files or anything from `accounts/` (the script refuses).
- Create a short link to another domain without the user confirming that site.
- Retry a 403 with another profile or route.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. Listing many files follows
[`../_shared/HEAVY-READS.md`](../_shared/HEAVY-READS.md) (the script pages on `_id`, one call at
a time). Sites: `prolibu-sites`. Proposal wizard links and QR codes: `prolibu-proposal-wizard`.
