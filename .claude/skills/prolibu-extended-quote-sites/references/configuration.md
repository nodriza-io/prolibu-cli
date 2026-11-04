# Which site the quote editor opens

Reference for `prolibu-extended-quote-sites`. `scripts/extended-quote.js config` computes all of
this for an account.

## Where the URL lives

- **Account:** preference `modules.sales.deals.quote.extendedQuote = { enabled, url }`
  (`enabled` defaults to `false`). Only admins write it, in the app. This skill never writes it.
- **Workspace:** `Workspace.extendedQuote = { enabled, url }`, no defaults (empty = inherit).
  Applies to users whose `primaryWorkspace` is that workspace. Only admins can change a
  workspace; the script's `preview`/`apply` do it.

## How it is resolved (three readers, two rules)

1. **Backend** (`GET /v2/user/preferences`, per user): merges per field. The workspace's
   `enabled` wins only when it is a boolean; its `url` wins only when non-empty.
2. **Browser** (V1 and V2): the workspace override wins only when it has **both**
   `enabled: true` and a `url`. Otherwise it uses the preference tree it loaded.
3. Which tree the browser loaded:
   - V1, everyone: `user/preferences` (already merged by rule 1).
   - V2 sellers: the same `user/preferences`.
   - V2 admins: the raw account preference (`preference/read`), NOT merged.

Result:

| Workspace override | V1 (all) and V2 sellers | V2 admins |
|---|---|---|
| none | account | account |
| `{enabled: true, url}` | workspace | workspace |
| `{enabled: false}` | **no button** | account (button) |
| `{url}` only | account `enabled` + workspace url | account |
| `{enabled: true}` only | account url | account |

Only "none" and "complete" behave the same for everyone. That is why the script offers just
`attach` (complete) and `inherit` (clear both), and refuses "turn it off for one workspace".

- The button shows only when the effective config has `enabled` and `url`, and only on a deal's
  quote (`hostModel` deal), never on a standalone quote. A new, unsaved deal shows it too.
- Changes reach users after they reload the app.

## What a usable URL looks like

`https://<domain>/site/<siteCode>/` — a published Prolibu Site on the account's own domain.

- **Same origin as the app:** the site reads the seller's session from `localStorage` and calls
  `/v2/...` as that seller. On another domain there is no session.
- **Trailing slash:** without it the server answers `302` to the slashed URL.
- **Published:** a Site without a package answers `403` (AccessDenied XML); an unknown code `404`.
- **Framable:** Prolibu domains send `Content-Security-Policy: frame-ancestors 'self' …`, so a
  Site on the same domain can be framed. A page on another domain must list the app's origin
  in its own `frame-ancestors`, or the iframe stays blank.
- **No redirect** to another origin (short links, CDNs): V2 drops every message.
- **No token in the URL.** The host never sends the token either.

A page on another domain can still work when it needs no Prolibu session (a pure calculator),
does not redirect and allows framing. `check-url` reports it as a warning and does not load it.
