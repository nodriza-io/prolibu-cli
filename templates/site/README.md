# Site

A Prolibu site: a static bundle or SPA that the platform hosts on your account's own domain.

## Where it gets published

```
https://<domain>/site/<siteCode>/
```

That is the `publicUrl` the API returns and the only URL you should share. The platform also
keeps a long canonical form (`/sites/<ownerId>/public/<siteCode>/…`) that the short one
reverse-proxies, but it leaks the owner record id — do not hand it out.

> Sites no longer reserve a `/r/<siteCode>` short link, and the `shortUrl` field is gone. If
> your code reads `site.shortUrl` it now reads `undefined` — use `site.publicUrl`.

## Development

```bash
./prolibu site dev --domain <domain> --sitePrefix <prefix> --watch --port 3000
```

Serves `public/` locally with live reload and writes `_prolibu_config.js` (domain + API base
URL) next to your files. Press `p` to publish, `x` to exit. The generated config file is
removed on exit — do not commit it.

## Production

```bash
./prolibu site prod --domain <domain> --sitePrefix <prefix>
```

## Structure

- `public/` — what gets zipped and shipped (HTML, CSS, JS, images). Its **root must hold
  `index.html`**; an upload without one is rejected.
- `config.json` — model data pushed to the platform (`siteType`, `readme`, `git.repositoryUrl`).
- `settings.json` — local-only settings (dev server port).
- `README.md` — this file; its contents are synced into the site's `readme` field.

## Static vs SPA

`siteType` in `config.json` decides how the platform answers a path that matches no file:

| Request | `Static` | `SPA` |
|---|---|---|
| `/site/<code>/` | `index.html` | `index.html` |
| `/site/<code>/about` | `about/index.html` | `index.html` (history-API fallback) |
| `/site/<code>/a/b/c` | `a/b/c/index.html` | `index.html` (history-API fallback) |
| `/site/<code>/app.js` | the file, served from storage | the file, served from storage |

**If your site has client-side routes, it must be `SPA`.** Registered as `Static`, every route
below the root answers with a raw storage `AccessDenied` error page. Switching the type means
re-uploading the package — the archive is unzipped to a different path per type.

## Building an SPA that survives the mount path

Your bundle is served from `/site/<siteCode>/`, never from `/`. A default build assumes the
domain root and breaks. Two requirements:

**1. Relative asset paths.** Vite's default `base: '/'` emits absolute `/assets/…` URLs that
resolve against the domain root and 404:

```ts
// vite.config.ts
export default defineConfig({
  base: './',
  build: { outDir: 'dist' },
})
```

**2. A router that knows its mount point.** For SPA sites the platform injects a `<base>` tag
into the shell it serves:

```html
<head><base href="/site/my-site/">
```

That is what makes relative assets resolve from the site root at any depth, and it hands your
code the mount point through `document.baseURI`. Read it rather than hardcoding:

```js
const basename = new URL(document.baseURI).pathname

// React Router
createBrowserRouter(routes, { basename })

// Vue Router
createRouter({ history: createWebHistory(basename), routes })
```

The same bundle then works at the published URL, at the long canonical URL, and on localhost.

**Hash routing (`#/route`) needs none of this** — it ignores the path entirely. Use it when you
do not need clean URLs.

If your `index.html` already declares its own `<base>`, the platform leaves it untouched.

## Requiring a signed-in visitor

Set `authenticationRequired: true` on the site (via the API or the platform UI) and an anonymous
visitor is redirected to `/v2/auth/signin` and returned to the page after signing in.

**Do not build a login form.** No email/password fields, no `POST /v2/auth/signin`, no MFA, no
password reset — the platform's sign-in page already does all of it, branded for the account, and
the flag routes visitors there for you. Write your bundle as if the visitor is already signed in.

### Getting a token for API calls

The gate and your JavaScript use two different copies of the same session:

- **Page access** is checked server-side against the `apiKey` cookie, which is `httpOnly` — your
  code can never read it.
- **API calls** must send `Authorization: Bearer <apiKey>`. The `/v2/` API **does not accept the
  cookie**: `GET /v2/user/me` with only the cookie returns `401 Unauthorized. Missing apiKey.`

The bridge is `localStorage`: the platform's sign-in page stores the key as
`localStorage['apiKey']` on your account's origin — the same origin your site is served from.

```js
const SIGNIN = () => '/v2/auth/signin?redirect=' +
  encodeURIComponent(location.pathname + location.search + location.hash)

async function api(path, options = {}) {
  const apiKey = localStorage.getItem('apiKey')
  if (!apiKey) { location.href = SIGNIN(); return }   // gate passed, no token on this browser

  const res = await fetch(`/v2${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers, Authorization: `Bearer ${apiKey}` },
  })
  if (res.status === 401) {                            // expired or revoked
    localStorage.removeItem('apiKey')
    location.href = SIGNIN()
    return
  }
  return res.status === 204 ? null : res.json()
}

const me = await api('/user/me')
```

Keep both redirect branches. The cookie and the `localStorage` copy can fall out of step — a
visitor who cleared site data passes the page gate with no token — and bouncing through
`/v2/auth/signin?redirect=…` re-seeds both and returns them where they were. Requests are
same-origin, so there is no CORS to configure.

### What it does not do

This gates **pages, not files**: assets are served straight from object storage to anyone with
the URL while the site is active. **Never ship secrets or API keys in a bundle** — if a page needs
privileged data, put it behind a custom Endpoint whose script holds the credential.

Expect up to ~60s for a change to the flag to take effect. Full walkthrough:
[Recipe 6](https://github.com/nodriza-io/prolibu-cli/blob/main/docs/integrations-for-ai-agents/12-integration-recipes.md#recipe-6--internal-site-behind-the-platforms-login).

## Deploy notes

- Max package size is 120 MB.
- **`400 Malicious content detected in file`?** The account has the cloud-drive content scanner
  on (`modules.tools.cloudDrive.advancedSecurity.scanMaliciousContent`), which rejects any
  `<script>…</script>` tag — so no JavaScript site can deploy. It defaults to off; an
  administrator has to turn it off for that account. Your archive is fine.
- A deploy **replaces** the site — the previous folder is deleted first, so files you stop
  shipping disappear.
- Setting the site inactive takes it offline immediately; all URLs return `403`.
