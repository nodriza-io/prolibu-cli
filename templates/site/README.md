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

This gates **pages, not files**: assets are served straight from object storage to anyone with
the URL while the site is active. Never ship secrets in a bundle.

Expect up to ~60s for a change to the flag to take effect.

## Deploy notes

- Max package size is 120 MB.
- **`400 Malicious content detected in file`?** The account has the cloud-drive content scanner
  on (`modules.tools.cloudDrive.advancedSecurity.scanMaliciousContent`), which rejects any
  `<script>…</script>` tag — so no JavaScript site can deploy. It defaults to off; an
  administrator has to turn it off for that account. Your archive is fine.
- A deploy **replaces** the site — the previous folder is deleted first, so files you stop
  shipping disappear.
- Setting the site inactive takes it offline immediately; all URLs return `403`.
