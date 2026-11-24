# Starting from the repo's templates, and build-tool sites

`./prolibu site create --template vanilla|react|vue` copies one of these, but it prompts (domain,
prefix, type, template, git repo, overwrite, git init), runs `npm install` and creates both
platform records at once. An agent copies the files by hand instead, the way `create.js` does:

1. Copy `templates/site/` `config.json`, `settings.json`, `README.md` and `.gitignore` into
   `accounts/<domain>/sites/<prefix>/`.
2. Copy the chosen template over them (`templates/site/` for vanilla, `templates/site-react/`,
   `templates/site-vue/`), except its `config.json`.
3. Set `config.json` `siteType`: `Static` for vanilla, `SPA` for React and Vue (they have routes).

The three templates were fixed and checked on 2026-11-24: built, and `scripts/site.js check` on
each gives no blockers and no warnings. `test/prolibu-site-templates.test.js` keeps them that way.

## What every template does

- **Session, not a login form.** `prolibu-session.js` (a copy of this skill's
  `assets/prolibu-session.js`, kept identical by the test) reads the app's session from
  `localStorage.apiKey` on the same origin and calls `/v2`. With no session or on a 401 it sends
  the visitor to `/v2/auth/signin?redirect=<this page>` (password, Google, Microsoft, Okta, MFA).
  No password field, no `/v2/auth/login`, and nothing removes `localStorage.apiKey`.
- **Sign out** is the platform's: `DELETE /v2/auth/signout`, then the sign-in page. It ends the
  app's session too, since the site shares it.
- **Relative paths only.** The only absolute paths are Cobalt (`/ui/static/cobalt/…`), which the
  account serves. No `_prolibu_config.js`: a published page calls `/v2` on its own origin.
- **Internal by default.** `index.html` has `<meta name="robots" content="noindex, nofollow">`
  and `<meta name="referrer" content="no-referrer">`.
- **Cobalt** components and `--co-*` tokens; the CSS is layout only.
- **One light read per visit** as the example: `/deal?limit=5&sort=-_id&select=dealName`.
  Replace it following [`../../_shared/HEAVY-READS.md`](../../_shared/HEAVY-READS.md).
- Loading, empty and error states; off the platform (`localhost`) it says there is no session
  instead of redirecting.

## Plain site (`templates/site/`)

`public/` is published as is: `index.html`, `styles.css`, `script.js`, `prolibu-session.js`.
Write the page in `script.js`; use `ProlibuSession.api(path)` and `ProlibuSession.me()`.

## React (`templates/site-react/`) and Vue (`templates/site-vue/`)

Vite + TypeScript. `npm run build` writes `dist/` (`settings.json` `"outputDir": "dist"`), and
that folder is what is published. `site.js` does not build: run `npm install` and
`npm run build` in the site folder first (`check` warns when the sources are newer than the
build). Nothing else to fix:

- `vite.config.ts` has `base: './'`.
- The router takes its base from `new URL(document.baseURI).pathname` (the platform injects
  `<base href="/site/<code>/">` into SPA pages): `BrowserRouter basename` in React,
  `createWebHistory(base)` in Vue.
- `public/prolibu-session.js` is loaded by `<script src="./prolibu-session.js" vite-ignore>`;
  the Cobalt tags carry `vite-ignore` too, so Vite keeps them as they are (they exist only on
  the account's domain). `vite-ignore` needs Vite 6.1 or later.
- `src/session.ts` wraps the helper with types (`session.api`, `session.me`, `session.signOut`,
  `errorText`). React types the `co-*` tags in `src/cobalt.d.ts`; Vue marks them as custom
  elements in `vite.config.ts` (`isCustomElement`).
- No login page or `/login` route. Add pages under `src/pages/` and routes in `src/App.tsx`
  (React) or `src/router.ts` (Vue).

## Any build tool

`site dev|prod` build when `package.json` has a `build` script: `npm install` (if
`node_modules` is missing or older than `package.json`), `npm run build`, then zip the folder
named by `settings.json` `outputDir` (default `dist`). `site.js` publishes the same folder but
does not build. That folder must contain `index.html` at its root. Assets must be referenced
relatively (`./assets/…`). For a build `site dev|prod` also writes `_prolibu_config.js` into
`public/`, so it ships in `dist/`; it holds only the domain and is not used by the templates.
