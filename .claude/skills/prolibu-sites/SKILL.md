---
name: prolibu-sites
description: Build, deploy and troubleshoot a hosted Site (static bundle or SPA) on a Prolibu account — package and upload the archive, pick Static vs SPA, get client-side routing working under the mount path, share the right URL, and gate the site behind a signed-in visitor. Use it whenever the task involves publishing or fixing a web page, landing page, microsite, portal, dashboard or single-page app on a Prolibu domain, or when someone reports a deployed site returning AccessDenied / 403 / a blank page / broken assets on a deep link, or asks how to require login on a site.
---

# Prolibu Sites

## Read the reference first

**Before writing or deploying anything, read
`docs/integrations-for-ai-agents/07-sites-forms-and-endpoints.md` §3.** It is the complete,
verified source: the `Site` resource, the two URLs, upload rules, how every request shape is
served, SPA mount-path requirements, the authentication gate, and activation. For the
end-to-end gated-site walkthrough read Recipe 6 in
`docs/integrations-for-ai-agents/12-integration-recipes.md`.

Do not work from memory and do not duplicate that content here.

## The traps that cost the most time

These are the failures that look like something else. Recognize them fast, then go read the
section.

**A route below the root returns storage `AccessDenied`.** The site is registered as
`siteType: 'Static'`, which treats `/site/<code>/about` as the folder `about/index.html`. Only
`SPA` gets the history-API fallback. Switching the type requires re-uploading the package.

**Assets 404 or the page renders unstyled.** The bundle was built for the domain root. A site is
always served from `/site/<siteCode>/`, so assets must be referenced relatively (`base: './'` in
Vite) and the client router must take its basename from `document.baseURI` — the platform injects
`<base href="/site/<siteCode>/">` into SPA shells precisely so that value exists. Hash routing
needs none of this.

**`400 Malicious content detected in file` on upload.** Not a corrupt archive. The account has
the cloud-drive content scanner enabled, which rejects any `<script>…</script>` tag — so no
JavaScript site can deploy until an administrator turns it off.

**A `400` on upload with no other detail.** `index.html` must be at the **root of the zip**. Zip
the contents of the build directory, not the directory itself.

**Reading `site.shortUrl` gets `undefined`.** That field was removed. Share `site.publicUrl`
(`https://<domain>/site/<siteCode>/`); the long `url` works but leaks the owner's record id.

**A gated site with a hand-written login form.** Never build one. `authenticationRequired: true`
routes anonymous visitors to the platform's own sign-in page and returns them to the page they
asked for. The page's JavaScript then reads `localStorage['apiKey']` for its API calls — the
session cookie is `httpOnly` and the `/v2/` API rejects cookies outright.

**Assuming the gate protects the files.** It gates pages only. Assets stay readable from object
storage while the site is active, so a key shipped in a bundle is a published credential. If a
page needs a secret, put the call behind a custom Endpoint — see the `prolibu-endpoints` skill.

## Deploying

Either the CLI (`./prolibu site dev|prod --domain <d> --prefix <p>`, see the repo README and
`templates/site/README.md`) or the API directly:

```bash
curl -s -X POST "https://<domain>/v2/site/" \
  -H "Authorization: Bearer <API_KEY>" \
  -F "siteName=..." -F "siteCode=..." -F "siteType=SPA" -F "package=@dist.zip"
```

Re-deploy by `PATCH`ing a new `package` to `/v2/site/<siteCode>`. It **replaces** the whole
folder — files you stop shipping disappear.
