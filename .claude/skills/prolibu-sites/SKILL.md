---
name: prolibu-sites
description: Build, publish and fix a hosted Site on a Prolibu account with this CLI — a plain HTML page or a React/Vue app served at https://<domain>/site/<siteCode>/, on the same origin as the app. Covers the folder layout, Static vs SPA, publishing the dev and prod copies without prompts, sign-in (the platform's gate and the session in localStorage, never a password form), calling the API or an Endpoint from the page, and fixing the repo's templates. Use it whenever someone wants a landing page, portal, dashboard, internal tool or single-page app on a Prolibu domain, or reports a site answering 403 AccessDenied, a blank page or 404 assets on a deep link, "Malicious content detected", "must contain an index.html", a login that does not work, or a page that does not see the signed-in user. Spanish triggers: "sitio", "publicar un sitio", "página en Prolibu", "SPA", "portal", "login del sitio", "site dev".
---

# Prolibu Sites

## Central idea

A Site is a zip of static files that the platform serves at
`https://<domain>/site/<siteCode>/`, on the **same origin as the app**. This CLI keeps each
site in `accounts/<domain>/sites/<prefix>/`, builds it when there is a `package.json`, zips
it and uploads it:

- `./prolibu site dev …` publishes the test copy, Site `<prefix>-dev`;
- `./prolibu site prod …` publishes the real one, Site `<prefix>`.

A page that needs the user's data uses the session the app already has: the platform's
sign-in page puts the token in `localStorage.apiKey`, and `assets/prolibu-session.js` reads
it and calls `/v2/…`. A published site never asks for a password.

## Ask the user first

1. **What is it for, and who opens it?** Signed-in users of the account, or anyone.
2. **What data does it show?** None; the visitor's own Prolibu data (session); or data or a
   third-party service the visitor must not reach directly (an Endpoint does that part).
3. **Plain pages, or an app with routes?** Routes mean `SPA`.
4. **Which account, and which prefix?** The prefix becomes the URL: lowercase, hyphens.

## Steps

1. **Lay out the folder by hand.** `./prolibu site create` prompts and cannot be answered
   by an agent.

   ```
   accounts/<domain>/sites/<prefix>/
     config.json        {"siteType": "Static"}   or "SPA" for an app with routes
     public/index.html  plain site: everything in public/ is published
     public/prolibu-session.js   copied from assets/, when the page needs the user
   ```

   - Start a plain page from `assets/example/index.html`.
   - For React or Vue, read `references/templates.md` first: the repo's React template must
     be fixed before use, and there is no Vue template.
   - A `package.json` with a `build` script switches the CLI to build mode: it runs
     `npm install` and `npm run build` and publishes `dist/` (or `settings.json` `outputDir`).
2. **Sign-in, when the page needs the user.** Load the helper, then call the API:

   ```html
   <script src="prolibu-session.js"></script>
   <script>
     ProlibuSession.me().then((me) => { /* me.profile.email */ })
       .catch((err) => { if (!err.signingIn) console.error(err) })
   </script>
   ```

   `ProlibuSession.api('/deal?limit=5')` sends `Authorization: Bearer <token>`. With no token,
   or on a 401, it sends the visitor to `/v2/auth/signin?redirect=<this page>` and the
   sign-in page brings them back. For server work or secrets, call an Endpoint the same way:
   `ProlibuSession.api('/endpoint/post/<routeName>', { method: 'POST', body: {…} })`.
3. **Publish the test copy.** Show the user what will be published and where, wait for a
   yes, then:

   ```
   ./prolibu site dev --domain <domain> --prefix <prefix> --no-git
   ```

   It creates `<prefix>-dev` if needed (with `siteType` from `config.json`), uploads, and
   prints the `publicUrl`. Never add `--watch`: it starts a local server that waits for key
   presses, has no session and publishes nothing by itself.
4. **Check it** (see Verify), and open the `publicUrl` in the browser where the user is
   signed in.
5. **Gate it, if only signed-in users may open it.** After a yes:

   ```
   node .claude/skills/_shared/prolibu-api.js <domain> PATCH /v2/site/<siteCode> \
     --data '{"authenticationRequired": true}' --confirmed
   ```

   Allow up to 60 s. The gate is per site: set it on `-dev` and on prod.
6. **Publish for real** after its own yes:
   `./prolibu site prod --domain <domain> --prefix <prefix> --no-git` (Site `<prefix>`).
   Each publish replaces every file of that site.

## How the platform behaves

Details, the full path table and the publishing rules are in
`references/serving-and-session.md`.

- **Paths.** `/site/<code>` without the slash redirects to `/site/<code>/`. A path with an
  extension other than `.html` is a 302 to public storage. On `Static`, `about` means
  `about/index.html` and a missing path is a 403 `AccessDenied` XML page. On `SPA`, every
  path without an extension gets `index.html`.
- **SPA mount point.** The platform adds `<base href="/site/<code>/">` to SPA HTML. Build
  with relative assets (`base: './'` in Vite) and give the router
  `new URL(document.baseURI).pathname` as basename, or use hash routing.
- **Site type is set when the site is created.** Changing it needs a PATCH and a new publish;
  in between the site answers 403 (`references/serving-and-session.md`).
- **The gate guards pages, not files.** It checks the session cookie on HTML requests under
  `/site/<code>/` and sends anonymous visitors to the sign-in page. Assets and the long
  `url` stay public. Never ship a key or secret in a site.
- **The session.** `/v2` takes only `Authorization: Bearer <token>`, never the cookie.
  `localStorage.apiKey` holds the token: JSON-quoted when the V2 app wrote it, plain from V1
  or the sign-in page. The helper reads both.
- **`_prolibu_config.js`** exists only in build-tool sites (when `public/` exists) and on the
  `--watch` server. Published pages use same-origin `/v2` and do not need it.
- **`active: false`** takes every URL of the site down (403) at once.

## Sign-in: which approach, when

| Situation | Do |
| --- | --- |
| Page on the account's domain for its users (the normal case) | Gate (`authenticationRequired`) and/or the helper's redirect to `/v2/auth/signin`. The sign-in page does password, Google, Microsoft and Okta sign-in, MFA, lockout and password reset, and sets the cookie the gate reads. |
| Anonymous visitors (landing, public form) | No session. Server work goes through a public Endpoint (`prolibu-endpoints`). |
| Local `--watch` server | No session exists on localhost. Test on the published `-dev` URL instead. |
| Site hosted outside Prolibu | No session. Out of scope here; never embed an API key. |

Never build an email and password form in a published site: it skips SSO and MFA (the
server answers `mfaRequired` instead of a token) and teaches users to type their password
into pages. The repo's templates still contain one; `references/templates.md` says how to
remove it.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| 403 `AccessDenied` XML on a deep link | `Static` site with client routes | Switch to `SPA` (PATCH + publish) |
| 403 on every URL | Site inactive, or type changed without a new publish | `active: true`; publish again |
| Blank page, assets 404 | Absolute asset paths (`/assets/…`) | `base: './'`; no leading `/` |
| 400 "…must contain an index.html file" | `index.html` not at the root of `public/` or `dist/`, or another user published | Move it; publish with the creator's profile |
| 400 "Malicious content detected in file" | The account's content scanner is on | An admin turns it off; nothing to fix in the zip |
| Visitor asked to sign in again though signed in to the app | Token sent with its JSON quotes (V2) → 401 | Use `prolibu-session.js` |
| Users signed out of the app after opening the site | Page removed `localStorage.apiKey` | Never remove it; redirect to sign-in |
| "Public folder not found" | No `public/` and no `package.json` with `build` (e.g. `--template vue`) | Lay out the folder (step 1) |
| Gate change has no effect | Cached for up to 60 s | Wait and retry |

## Verify

- `curl -s -o /dev/null -w '%{http_code}' https://<domain>/site/<siteCode>/` answers 200
  (302 to `/v2/auth/signin…` when gated). For an SPA, a deep link answers 200 too.
- `node .claude/skills/_shared/prolibu-api.js <domain> GET /v2/site/<siteCode>` shows the
  `siteType`, `active` and `authenticationRequired` you agreed.
- In the user's signed-in browser, the page shows their data.

## Don't

- Run `site create`, `site sync`, `site import` or `--watch`: they prompt or wait for keys.
- Ask for a password, put a token in a URL, or remove `localStorage.apiKey`.
- Embed an API key or secret in any site file; use an Endpoint.
- Publish with a different profile than the one that created the site.
- Publish prod without its own yes.

## Writing to an account

Every publish and every PATCH follows [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md):
domain, reads only, plain summary, explicit yes, write, read back. The CLI's `site` commands
read the profile themselves. A site inside the quote editor is `prolibu-extended-quote-sites`;
server logic behind a page is `prolibu-endpoints`; how objects relate is
`prolibu-platform-map`.
