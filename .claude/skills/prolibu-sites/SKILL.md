---
name: prolibu-sites
description: Build, check, publish, roll back and fix a hosted Site on a Prolibu account — a plain HTML page or a React/Vue app served at https://<domain>/site/<siteCode>/, on the same origin as the app. Covers the folder layout, Static vs SPA, checking a build before upload (index.html, relative paths, size, secrets), publishing the dev and prod copies with a preview and a read-back of what visitors get, putting the previous version back, the sign-in gate and turning a site off, the session in localStorage (never a password form), and calling the API or an Endpoint from the page. Use it whenever someone wants a landing page, portal, dashboard, internal tool or single-page app on a Prolibu domain, or wants a custom report page or a page with totals or a table over many records (it routes the figures to a Prolibu report and reads its rows in one streamed call), or reports a site answering 403 AccessDenied, a blank page or 404 assets, "Malicious content detected", "must contain an index.html", a login that does not work, or a page that does not see the signed-in user. Spanish triggers: "sitio", "publicar un sitio", "página en Prolibu", "SPA", "portal", "login del sitio", "site dev", "volver a la versión anterior del sitio", "despublicar", "sitio de reportes", "reporte a medida", "página con todos los negocios".
---

# Prolibu Sites

## Central idea

A Site is a zip of static files that the platform serves at
`https://<domain>/site/<siteCode>/`, on the **same origin as the app**. This CLI keeps each
site in `accounts/<domain>/sites/<prefix>/`. The test copy is the Site `<prefix>-dev`, the
real one is `<prefix>`.

**Each upload replaces every file, and the server deletes the live files before it checks
the new zip.** A zip without `index.html` at its root, or published by a user other than the
site's creator, leaves the site empty. The platform keeps no history: the previous version
exists only if someone saved it. `scripts/site.js` does all of that safely:

```
node .claude/skills/prolibu-sites/scripts/site.js <command> <domain> …
  list             <domain> [--search <text>]          sites: code, type, active, gate, mine
  show             <domain> <siteCode>                 record, live package, what visitors get
  check            <domain> <folder | zip>             local checks; writes nothing
  preview          <domain> <siteCode> <folder | zip> [--site-type Static|SPA]
  publish          <domain> <siteCode> <folder | zip> --version <v> --confirmed [--prod]
  settings-preview <domain> <siteCode> [--active on|off] [--gate on|off] [--site-type Static|SPA]
  settings         <domain> <siteCode> <same flags> --version <v> --confirmed [--prod]
```

`<folder>` is the site folder: the script publishes its `public/`, or, when `package.json`
has a `build` script, the build output (`settings.json` `outputDir`, default `dist/`), like
the CLI. Output is JSON. Exit codes: 0 ok, 1 request failed, 2 usage error (nothing sent),
3 blocked (nothing written). Every command takes `--profile <name>`.

A page that needs the user's data uses the session the app already has: the sign-in page
puts the token in `localStorage.apiKey`, and `assets/prolibu-session.js` reads it and calls
`/v2/…`. A published site never asks for a password.

## Ask the user first

1. **What is it for, and who opens it?** Signed-in users of the account, or anyone.
2. **What data does it show?** None; the visitor's own Prolibu data (session); or data or a
   third-party service the visitor must not reach directly (an Endpoint does that part).
   Totals, counts or a table over many records (a "custom report") follow
   [Pages that read many records](#pages-that-read-many-records) before any code.
3. **Plain pages, or an app with routes?** Routes mean `SPA`.
4. **Which account, and which prefix?** The prefix becomes the URL: lowercase, hyphens.

`site.js list <domain>` confirms the account is set up; never open `profile*.json` (the script
reads the key itself). Answer in the user's language, in plain words.

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
   - **Build anything visual with Cobalt**, the app's design system: `co-*` components and
     `--co-*` tokens loaded from the account's `/ui/static/cobalt/…`, no colors or plain
     buttons of your own. Read [`../_shared/COBALT.md`](../_shared/COBALT.md) first, and design
     to [`../_shared/UI-QUALITY.md`](../_shared/UI-QUALITY.md): one primary action, aligned
     cards, nothing cut at 1440, 1024 or 390 px.
   - For React or Vue, start from `templates/site-react/` or `templates/site-vue/` (read
     `references/templates.md`): they use `prolibu-session.js`, relative paths (`base: './'`)
     and Cobalt, with no login page.
   - A build-tool site: run `npm install` and `npm run build` in the site folder yourself;
     the script publishes the output and warns when the sources are newer than the build.
2. **Sign-in, when the page needs the user.** Load the helper, then call the API:

   ```html
   <script src="prolibu-session.js"></script>
   <script>
     ProlibuSession.me().then((me) => { /* me.profile.email */ })
       .catch((err) => { if (!err.signingIn) console.error(err) })
   </script>
   ```

   `ProlibuSession.api('/deal?limit=5')` sends `Authorization: Bearer <token>`. With no token,
   or on a 401, it sends the visitor to `/v2/auth/signin?redirect=<this page>`. For server
   work or secrets, call an Endpoint the same way:
   `ProlibuSession.api('/endpoint/post/<routeName>', { method: 'POST', body: {…} })`.
   For a page only the account's users should see, add
   `<meta name="robots" content="noindex, nofollow">` and
   `<meta name="referrer" content="no-referrer">`: the platform sends neither header.
3. **Look at it, then preview.** Run `node .claude/skills/_shared/ui-review.js <domain> <folder>`
   (headless Chrome, real data, nothing written), fix every finding, and open each screenshot
   before going on. Then `preview <domain> <prefix>-dev <folder>` runs every check and says
   what will be created or replaced (the live package's size and checksum). Fix every
   blocker (missing or nested `index.html`, absolute `/assets/…` paths, `.env`, keys or
   secrets in any file, an API key of this account, a zip over the account's upload limit,
   blocked extensions, the content scanner, a site created by another user). Read the
   warnings to the user (password fields, `/v2/auth/login`, source maps, a stale build, and
   the Cobalt ones: fix those before publishing).
   Show the plain summary and **stop**; wait for a yes. **One yes covers one write:** the
   publish, the gate and the prod publish each get their own preview, their own question and
   their own yes, even when the user asked for all of them at the start. Never run a
   `settings` or a second `publish` in the turn that ran a `publish`.
4. **Publish the test copy** after the yes: `publish … --version <v> --confirmed`. A new
   site is created first (type from `--site-type` or `config.json`). Before replacing, the
   script downloads the live package to a temp folder and prints its path (`backup.path`).
   Then it uploads, checks that the stored package matches, and fetches the public URL as
   an anonymous visitor: `live.servesNewVersion` and each asset's status. A brand-new code
   can answer 404 for up to 60 s (the server caches misses); the script waits.
5. **Open the `publicUrl`** in the browser where the user is signed in, and let them try it.
6. **Gate it, if only signed-in users may open it.** `settings-preview <domain> <code> --gate on`,
   yes, then `settings … --version <v> --confirmed`. It takes up to 60 s. Assets (JS, images)
   stay public either way. The gate is per site: set it on `-dev` and on prod.
7. **Publish for real** only when the user asks for it, after its own yes: preview and
   publish `<prefix>` with `--prod`. A yes to another question is not a yes to prod.

## Pages that read many records

A page many people open runs its calls on every visit. One heavy call per visit is enough to
take down every account on the server (a report site paging about 14,000 deals sorted
by `createdAt` did). Before writing code, read [`../_shared/HEAVY-READS.md`](../_shared/HEAVY-READS.md),
then build it this way:

1. **Figures come from a Prolibu report.** Totals, counts, sums by stage, advisor or month,
   funnels and goals: build the report with `prolibu-reports-dashboards` first. Often that report (or
   a dashboard) is the whole answer; offer it before a custom site.
2. **Rows come from that report, in one call.** The page calls
   `ProlibuSession.api('/report/generate/?reportId=<reportCode>&downloadFormat=json&xquery=' + encodeURIComponent(JSON.stringify(period)))`
   once per load, with no `sort` and no `page`, and groups, sums, filters and sorts the rows in
   memory. The answer is a JSON array of flat rows keyed by the report's columns
   (`stage.stageName`, `assignee.firstName`…), already limited to what the visitor may see. A date filter changes the period and reloads once; other filters work on the loaded
   rows. The report's columns decide what the page gets, so it never asks for more.
3. **A paged table** that cannot load all rows asks for 25–50 at a time, `select` only its
   columns, `sort=-_id` (newest first) or `_id`. Never `sort=-createdAt` or another field.
4. **No loops over pages, no call per group, nothing in parallel** to the same object, no
   timers that reload.

`preview` blocks a page that pages through an object sorted on another field, or that runs
those calls in parallel (`heavyListSort`, `parallelListCalls`), and warns on bulk list reads
(`bulkListRead`).

## Roll back, take down, change type

- **Put the previous version back:** `preview <domain> <code> <backup.path>`, yes, then
  `publish` with that zip. The script checks a zip like a folder. Keep the backup path in
  your answer; temp folders are cleaned eventually.
- **Take the site down:** `settings --active off` makes every URL answer 403 at once;
  `--active on` brings it back. Deleting a site is done in the app, not here.
- **Static ↔ SPA:** `settings --site-type SPA`, then publish again right away (the site
  answers 403 in between); update `config.json` too.

## How the platform behaves

Details and the full path table are in `references/serving-and-session.md`.

- **Paths.** `/site/<code>` redirects to `/site/<code>/`. A path with an extension other
  than `.html` is a 302 to public storage. On `Static`, `about` means `about/index.html` and
  a missing path is a 403 `AccessDenied` XML page. On `SPA`, every extension-less path gets
  `index.html`.
- **SPA mount point.** The platform adds `<base href="/site/<code>/">` to SPA HTML. Build
  with relative assets (`base: './'` in Vite) and give the router
  `new URL(document.baseURI).pathname` as basename, or use hash routing.
- **The gate guards pages, not files.** Assets, the long `url` and the uploaded zip itself
  are public to anyone with the link. Never ship a key or secret in a site.
- **The session.** `/v2` takes only `Authorization: Bearer <token>`. `localStorage.apiKey`
  is JSON-quoted when the V2 app wrote it, plain from V1 or the sign-in page; the helper
  reads both. `_prolibu_config.js` is not needed by published pages.
- **Upload limit.** The zip must fit the account's per-file upload limit (20 MB by default;
  an admin can raise it): above it the server answers 413.
- **Who may publish.** Reading or changing sites needs the `Site` permission; a seller
  without it gets 403 on every command (the script stops and says FORBIDDEN).

## Sign-in: which approach, when

| Situation | Do |
| --- | --- |
| Page for the account's users (the normal case) | Gate (`--gate on`) and/or the helper's redirect to `/v2/auth/signin`. That page does password, Google, Microsoft and Okta sign-in, MFA, lockout and reset. |
| Anonymous visitors (landing, public form) | No session. Server work goes through a public Endpoint (`prolibu-endpoints`). |
| Local `--watch` server | No session on localhost. Test on the published `-dev` URL instead. |
| Site hosted outside Prolibu | No session. Out of scope here; never embed an API key. |

Never build an email and password form in a published site: it skips SSO and MFA and
teaches users to type their password into pages.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| 403 `AccessDenied` XML on a deep link | `Static` site with client routes | `--site-type SPA`, then publish |
| 403 on every URL | Inactive, or type changed without a new publish | `--active on`; publish again |
| Blank page, assets 404 | Absolute asset paths (`/assets/…`) | `base: './'`; `check` lists them |
| Preview blocks with `notCreator` | Another user created the site; publishing would empty it, even as admin or from the app | Tell the user who the creator is (the blocker names them) and the two ways: the creator uploads it in the app, or their API key in `profile.<name>.json` and `--profile <name>` |
| 400 "…must contain an index.html file" | No `index.html` at the root, or another user published; the site is now empty | Fix the folder, publish with the creator's profile, or publish the backup |
| 400 "Malicious content detected in file" | The account's content scanner is on | An admin turns it off; never obfuscate the code |
| 413 "File exceeds the maximum upload size" | Zip over the account's limit | Smaller build, or an admin raises the limit |
| Signed-in visitor asked to sign in again | Token sent with its JSON quotes → 401 | Use `prolibu-session.js` |
| Users signed out of the app after the site | Page removed `localStorage.apiKey` | Never remove it; redirect to sign-in |
| Gate change has no effect | Cached for up to 60 s | Wait; `show` again |
| Page slow for everyone; the whole server slow or down while it is open | Paging or counting a large object sorted or filtered on fields without an index | [Pages that read many records](#pages-that-read-many-records); take the site down (`--active off`) first if it is live |

## Don't

- Run `site create`, `site sync`, `site import` or `--watch`: they prompt or wait for keys.
  Publish with `site.js`, not `./prolibu site dev|prod` (no checks, no backup, default
  profile only).
- Ask for a password, put a token in a URL, or remove `localStorage.apiKey`.
- Embed an API key or secret in any site file; use an Endpoint.
- Open `profile*.json` or copy the key into a shell variable or curl; read data through
  `node .claude/skills/_shared/prolibu-api.js <domain> GET '/v2/...'`.
- Style a page with your own palette, fonts or plain `<button>`/`<input>`; use Cobalt.
- Publish to a site another user created, or publish prod without its own yes (`--prod`).
- Retry a 403 with another profile.

## Writing to an account

Every publish and settings change follows [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md):
domain, reads only, plain summary, explicit yes, write, read back. A site inside the quote
editor is `prolibu-extended-quote-sites`; server logic behind a page is `prolibu-endpoints`;
how objects relate is `prolibu-platform-map`. Site packages live in the creator's drive under `public/<siteCode>/`; never edit them through the drive (`prolibu-files` refuses them).
