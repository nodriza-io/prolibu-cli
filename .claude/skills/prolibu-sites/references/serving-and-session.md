# How a Site is served, gated and signed into

Read this when a case falls outside the steps in `SKILL.md`. Everything here was checked
against the server code and with live requests.

## The Site record

| Field | Notes |
| --- | --- |
| `siteCode` | The URL slug. The CLI sets it: `<prefix>-dev` for `site dev`, `<prefix>` for `site prod`. Keep it to lowercase letters, digits and `-`. |
| `siteName` | The CLI sets `<prefix> - Dev` / `<prefix> - Prod`. |
| `siteType` | `Static` (default) or `SPA`. Decides the storage folder and how paths are answered. |
| `package` | The uploaded zip. Each upload replaces the whole folder. |
| `active` | Default `true`. `false` makes every URL answer 403 at once; `true` brings it back. |
| `authenticationRequired` | Default `false`. The sign-in gate, below. |
| `publicUrl` | Read-only. `https://<domain>/site/<siteCode>/`. Share this one. |
| `url` | Read-only. The long form `https://<domain>/sites/<ownerId>/public/<siteCode>/[spa/]`. It leaks the owner's id and is never gated. |
| `readme`, `git.repositoryUrl` | Informational. The CLI syncs `README.md` into `readme`. |

`GET /v2/site/<siteCode>` reads one. `variables` and `lifecycleHooks` (which the CLI sends
from the template's `config.json`) are not Site fields; the server drops them.

## How a request is answered

| Request under `/site/<siteCode>` | Static | SPA |
| --- | --- | --- |
| no trailing slash | 302 to `/site/<siteCode>/` | same |
| `/` | `index.html` | `index.html` |
| any extension but `.html` (`app.js`, `logo.png`) | 302 to public storage | same |
| `page.html` | that file | that file |
| `about` (no extension) | `about/index.html` | `index.html` (client route) |
| a path that does not exist | 403, an XML `AccessDenied` page from storage | `index.html` for extension-less paths; 403 for a missing `.html` |
| a verb other than GET or HEAD | 404 | 404 |

- **SPA shells get a `<base href="/site/<siteCode>/">`** right after `<head>`, in every HTML
  file served, unless the file already has a `<base>`. Relative assets then resolve at any
  depth, and `new URL(document.baseURI).pathname` is the router's basename.
- **HTML is answered with `cache-control: no-store`**, so a new publish shows at once.
  Assets are served by storage, not by this proxy, so that header does not cover them: give
  them hashed names (Vite does) or rename a file when its content changes.
- A Static page opened without its trailing slash (`/about`) resolves its relative links
  against the parent folder. Link to `about/`.

## Changing the site type

The CLI sends `siteType` from `config.json` only when it creates the site. To change it:

1. Change `siteType` in `config.json` (for `--watch` and future copies).
2. `PATCH /v2/site/<siteCode>` with `{ "siteType": "SPA" }` through the helper, after a yes.
   From now until step 3 the site answers 403: the record points to a folder that is empty.
3. Publish again with `./prolibu site dev|prod`. The package unzips into the new folder.

Do it for `-dev` and for the prod site separately.

## Publishing rules

- `index.html` must be at the root of the zip. The CLI zips the **contents** of `public/` or
  of the build's output folder, so keep `index.html` there. Otherwise: 400 "The site package
  must contain an index.html file".
- The files count against the storage quota of the user who publishes: "Storage limit
  exceeded!…" means that user is full.
- **Publish with the same user (profile) that created the site.** The server unzips into
  the publishing user's drive but looks for `index.html` in the creator's: with another
  user's key the upload fails with the index.html error after the old files were removed,
  and the site answers 403 until the creator publishes again.
- **Content scanner.** When an admin turned on the cloud drive's advanced security with
  "scan malicious content", every text file in the zip is rejected with 400 "Malicious
  content detected in file" if it contains any of: a `<script>…</script>` pair (even with
  `src`), `javascript:`, `vbscript:`, `onload=`, `onerror=`, `onclick=`, `<iframe`,
  `<object`, `<embed`, `eval(`, `document.write`. No site with JavaScript can be published
  while it is on. It is off by default; only an admin can change it. Tell the user; do not
  try to obfuscate around it.

## The sign-in gate (`authenticationRequired`)

- It guards **HTML pages** under `/site/<siteCode>/` only. Assets are redirected to public
  storage before the check, and the long `url` is never gated. Anyone with an asset's URL can
  download it: never put a secret in a bundle.
- It reads the `apiKey` session cookie (httpOnly, set by the sign-in page). Without a valid
  one: 302 to `/v2/auth/signin?redirect=<the path asked for>`.
- After a change, it can take up to 60 s to apply (the server caches the site lookup).
- The sign-in page handles everything: password, Google, Microsoft and Okta sign-in, MFA,
  lockout after failed attempts and password reset. When it already
  has a valid token in `localStorage`, it restores the cookie and returns to `redirect` at
  once, without asking.

## The session a page can use

- The `/v2` API accepts only `Authorization: Bearer <token>` (or `?apiKey=` in the URL,
  which leaks into logs: do not use it). The cookie is not accepted.
- The token is in `localStorage.apiKey` on the account's origin, which is the site's origin:
  - the V2 app stores it JSON-quoted (`"abc…"`), V1 and the sign-in page store it plain;
  - parse it with `JSON.parse` and fall back to the raw value (`assets/prolibu-session.js`);
  - sending it with the quotes gives 401.
- On a 401, send the visitor to `/v2/auth/signin?redirect=<path>`. Do not remove
  `localStorage.apiKey` yourself: it is the app's session too, and the sign-in page cleans it
  up when it is really invalid.
- Calls are same-origin (`/v2/…`): no CORS. Requests from `localhost` to
  `https://<domain>/v2/…` are allowed by CORS too, but there is no session there.

## `_prolibu_config.js`

The CLI writes `window.__PROLIBU_CONFIG__ = { domain, apiBaseUrl, isDev }` into
`_prolibu_config.js`:

| Command | Plain site (`public/`) | Build-tool site |
| --- | --- | --- |
| `site dev` / `site prod` (publish) | not written | written to `public/` if that folder exists (shipped, `isDev: false`); otherwise to the site folder, where it is **not** shipped |
| `--watch` (local server) | written to `public/`, removed on exit | written to `public/` |

A published page does not need it: use same-origin `/v2`. Do not reference it with an
absolute path (`/_prolibu_config.js` resolves to the domain root and is a 404).
