# Starting from the repo's templates, and build-tool sites

`./prolibu site create` copies one of these, but it prompts (domain, prefix, type,
template, git repo, overwrite, git init) and creates both platform records at once. Copy the
files by hand instead, then apply the fixes below. They were checked by building and
publishing each template.

## Plain site (`templates/site/`)

Copy `config.json` and `public/` into `accounts/<domain>/sites/<prefix>/`. Then:

- Replace `public/script.js` with your code and `assets/prolibu-session.js` from this skill.
  The template's script reads `localStorage.apiKey` without unquoting it (it fails with the
  V2 app's session), removes the app's token when a call fails (signing the user out of the
  app), and shows its own email and password form when the page is not on `*.prolibu.com`.
- Remove `<script src="_prolibu_config.js"></script>` from `index.html`: a published plain
  site does not have that file.

## React (`templates/site-react/`)

Copy the folder, add `config.json` with `{ "siteType": "SPA" }`, keep `settings.json`
(`"outputDir": "dist"`). The CLI runs `npm install` and `npm run build` and zips `dist/`.
`vite.config.ts` (`base: './'`) and `main.tsx` (basename from `document.baseURI`) are
right. Fix the rest:

1. **Delete `src/pages/Login.tsx` and the `/login` route.** It posts email and password to
   `/v2/auth/login`, which does not exist (404), and it would bypass Google/Microsoft/Okta
   sign-in and MFA anyway.
2. **Delete `src/api/client.ts` and the token logic in `src/store/auth.ts`.** They read
   `window.__PROLIBU_CONFIG__.apiKey` (never written) or `localStorage.prolibu_apiKey` (never
   set by the platform), and on 401 they navigate to `/login` at the domain root.
3. **Create `public/` and copy `assets/prolibu-session.js` into it.** In `index.html`
   replace the `/icon.svg` link and the `/_prolibu_config.js` script (absolute paths: 404 at
   the domain root) with:

   ```html
   <script src="./prolibu-session.js"></script>
   ```

   Vite warns that it "can't be bundled without type=module": expected, it is copied as is.
4. **Type it** in `src/vite-env.d.ts`:

   ```ts
   interface ProlibuSessionApi {
     token(): string | null
     signIn(): void
     api<T = unknown>(path: string, init?: Omit<RequestInit, 'body'> & { body?: unknown }): Promise<T>
     me<T = Record<string, unknown>>(): Promise<T>
   }
   interface Window { ProlibuSession: ProlibuSessionApi }
   ```

5. **Load the user** where the app starts, and let the helper send the visitor to the
   sign-in page:

   ```ts
   try {
     const me = await window.ProlibuSession.me<{ profile?: { email?: string } }>()
   } catch (err) {
     if (!(err as { signingIn?: boolean }).signingIn) { /* show the error */ }
   }
   ```

## Vue

There is no Vue template: `--template vue` leaves a folder with only `config.json`, `.gitignore`,
`settings.json` and `README.md`, and `site dev` then fails with "Public folder not found".
Lay out a Vite + Vue project by hand with the same rules as React:

- `package.json` with a `build` script (the CLI only builds when there is one) and a `dev`
  script for `--watch`;
- `vite.config` with `base: './'`;
- `settings.json` with `"outputDir"` (default `dist`);
- `config.json` with `{ "siteType": "SPA" }` when the app has routes;
- the router: `createRouter({ history: createWebHistory(new URL(document.baseURI).pathname), routes })`,
  or `createWebHashHistory()`, which needs no base;
- `public/prolibu-session.js` and `<script src="./prolibu-session.js"></script>` as in React.

## Any build tool

`site dev|prod` build when `package.json` has a `build` script: `npm install` (if
`node_modules` is missing or older than `package.json`), `npm run build`, then zip the folder
named by `settings.json` `outputDir` (default `dist`). That folder must contain
`index.html` at its root. Assets must be referenced relatively (`./assets/…`).
