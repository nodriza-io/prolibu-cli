---
name: prolibu-account-setup
description: Connect this CLI to a Prolibu account the safe way — bring the account's folder from its git repository (import, pull, push), put the API key in its git-ignored profile file without it ever passing through the chat or a command line, check that the key works (who it acts as, admin or not, what it may do, which account switches are off, which skills will work), tell production from test accounts, and connect the account's MCP server to Claude Code. Use it first when someone starts with the CLI or a new account, wants to see which accounts are set up, gets 401 or 403 on everything, asks "is my key admin?", wants to import or update an account from its repository, or wants Prolibu's tools inside Claude. Spanish triggers: "conectar el CLI a una cuenta", "configurar la llave", "configurar la API key", "importar la cuenta", "traer la cuenta del repositorio", "qué cuentas tengo", "revisar la llave", "qué permisos tiene", "conectar el MCP", "Prolibu en Claude".
---

# Prolibu Account Setup

## Central idea

The CLI reaches an account with an **API key** kept in `accounts/<domain>/profile.json`:
`{"apiKey": "…"}`. The repo git-ignores `accounts/`. A key **acts as the user who created
it**: same roles, same records. An admin's key without scopes may do everything; any other
key carries the permissions its user had **when the key was created**.

The key must never pass through the chat, a command line (shell history) or a committed file.
So the user pastes it into the file in their own editor, and everything else reads it from
there. This skill writes nothing to the account.

`scripts/account-setup.js` does the fragile parts in code: it never prints a key, keeps
profile files out of the account's own repository, reads who the key is and what it may do,
and builds the MCP command so the key stays in its file.

```
node .claude/skills/prolibu-account-setup/scripts/account-setup.js <command> …
  list                                    accounts, key files (set or empty), git safety
  init  <domain> [--profile <name>]       empty profile file (0600), git-ignored; never overwrites
  check <domain> [--profile <name>]       key works? user, admin, switches, skills ready
  mcp   <domain> [--profile <name>]       the `claude mcp add` command; the key is not in it
```

Output is JSON. Exit codes: 0 ok, 1 API error or key refused, 2 usage error (nothing sent),
3 blocked (nothing written).

## Ask the user first

In plain terms:

1. **Which account?** Its domain (`name.prolibu.com` or a custom domain). Judge production
   yourself: if the first label is `dev` (with or without digits), `stg`, `staging`, `qa` or
   `test`, it is a test account; anything else is production, and say so.
2. **Does the account have a git repository** with its scripts and sites? If yes, its URL.
3. **Do they have a key?** If not, they create one in the app (step 4). On production, a key
   of a user with only the roles needed; an admin key only when the work needs admin.
4. **Do they want Prolibu's tools inside Claude** (the MCP server)?

## Steps

1. **See what is there.** Run `list`. For each account it gives the profile files and whether
   each has a key, never the key itself. Fix every `warning` before using that account.
2. **Bring the account folder** (only with a repository):
   - New here: `./prolibu account import --domain <domain> --repo <url>`. Only when
     `accounts/<domain>` does not exist or is empty: otherwise it asks, and one answer deletes
     the folder. If it exists, use pull.
   - Already here: `./prolibu account pull --domain <domain>`.
   - Both run git with the user's own git access. Then run `list` again: a repository with
     its own `.gitignore` may not ignore `profile.json`.
3. **Prepare the key file.** `init <domain>`. It creates `{"apiKey": ""}` readable only by
   the user and adds `profile*.json` to the account repository's `.gitignore` when missing.
   `--profile <name>` makes `profile.<name>.json`, a second key (for example a non-admin
   user's). Only the skills' scripts and the API helper read named profiles; `./prolibu`
   commands always read `profile.json`.
4. **The user creates the key** if they have none, in the app: avatar menu › **Security › API
   Keys** (Spanish: **Seguridad › Claves API**) › New. `App name` is required; `Roles` or
   `Scopes` (not both) narrow it; `Expires at` empty means it never expires. The app shows the
   key **once**: copy it then.
5. **The user pastes it into the file** shown by `init`, between the quotes, in their editor,
   and saves. Never ask for it in the chat. If they paste it in the chat anyway, do not repeat
   it or write it anywhere; say it is now in this conversation's history, and on production
   suggest replacing it with a new key.
6. **Check it.** `check <domain>`. Tell the user, in plain words:
   - who the key acts as (`user`), whether it is an admin, and `access`: `admin` (everything),
     `admin-scoped` (an admin's key limited to its scopes: admin-only actions are refused),
     `roles` (a non-admin);
   - the account switches that are off, and that only an admin turns them on in the app;
   - each skill's status (`ready`, `missing permissions` with what is missing, `switch off`);
   - every `note`.
   On `keyWorks: false`, the account refused the key: back to step 4.
7. **Connect the MCP server** (only if they want it). Run `mcp <domain>`. It checks the key
   and the account's MCP switch and returns `command`. Give the user that command exactly; it
   looks like this and holds no key:

   ```
   cd '<repo>' && k=$(node -p 'require("./accounts/<domain>/profile.json").apiKey') && claude mcp add --transport http --scope local prolibu-<label> https://<domain>/v2/mcpsession/ses --header "Authorization: Bearer $k"; unset k
   ```

   **Do not run it yourself**, even when the request is "connect it": it writes a key into
   the user's own Claude Code settings, so the user runs it (in Claude Code: type `!` and
   paste it). Then `claude mcp list` should show the server connected, and in a new session
   `/mcp` lists its tools as `mcp__prolibu-<label>__<tool>`.
8. **Send changes back** (only when the user asks): run `list` and stop if any warning says a
   profile would be published. Then `./prolibu account push --domain <domain> -m "<message>"`.
   It commits everything in the folder except the key files (`profile*.json`) and pushes; it
   refuses to push while a key file is already committed.

## How the platform behaves

Details and evidence notes are in `references/account-model.md`. Read it when a case falls
outside the steps.

- **The key is its user.** `GET /v2/user/me` answers `profile` (`isAdmin`, `roles`,
  `locale`, `status`) and `permissions`: the key's scopes. `check` reads it for you.
- **After changing a user's roles, replace their keys.** A non-admin key keeps the permissions
  it was created with, so create a new key and revoke the old one.
- **401 means the key itself was refused:** unknown, expired, revoked, or its user is not
  active. **403** means a valid key without permission for that action.
- **Keys cannot be read back.** The account stores them hashed. A lost key is replaced, never
  recovered.
- **The MCP switch is off by default.** Every user can read it (`check` shows it); only an
  admin turns it on (Preferences › Integrations › MCP). The dashboards skill needs it too.
- **The MCP server is the same key.** It checks the key like the REST API, acts as its user,
  and refuses tool calls outside a scoped key's permissions. It answers only `POST`.
- **Claude Code cannot sign in by OAuth on its own.** The account advertises OAuth, but has
  no self-registration for clients, so use the key header, as `mcp` does.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| `check`: `keyWorks: false`, 401 | Wrong, expired or revoked key, or inactive user | New key (step 4), paste it, `check` |
| 403 on actions the user's role now allows | The key froze the old permissions | New key |
| A `./prolibu` command asks for an API key | No `profile.json` (named profiles do not count) | `init`, paste, `check` |
| `account import` asks "already exists…" | The folder exists | `account pull` instead |
| `list` warns a profile is not git-ignored | The account repository's `.gitignore` | `init <domain>` |
| `list` warns a profile is committed | The key is in the repository history | Revoke it in the app, new key |
| MCP: "MCP server is disabled by the administrator." | Account switch off | An admin turns it on |
| MCP tool: "missing scope: Resource@…" | Scoped key | A key with that permission |
| `/mcp` shows the server failed or asking to sign in | Key refused, or switch off | `check`, then `mcp` again |
| Tools still missing after `claude mcp add` | The session started before it | Start a new session |

## Verify

- `check` answers `keyWorks: true` with the user the person expected, and they know which
  skills will refuse work and why.
- After the MCP command: `claude mcp list` shows `prolibu-<label>` connected. After replacing
  a key, remove the server (`claude mcp remove prolibu-<label> -s local`) and add it again: it
  keeps a copy of the old key.

## Don't

- Ask for the key in the chat, read or print a profile file (`cat`, `Read`, `echo`), or put a
  key on a command line (`./prolibu … --apikey`, `curl -H`, `claude mcp add --header` with
  the key typed in).
- Hand the person a command that prints the key either (`node -p '…apiKey'`, `cat`, `jq`), not
  even "to run yourself": run with `!` in Claude Code, its output lands in this conversation.
  When someone asks to see their key, say it stays out of the chat, name the file
  (`accounts/<domain>/profile.json`) to open in their editor, and offer `check` to confirm it works.
- Run `claude mcp add` or `claude mcp get <name>` yourself: the first is the user's to run,
  the second prints the key. Use `claude mcp list`.
- Use `--scope project` or write `.mcp.json`: it lands in the repo.
- Create, list, change or delete keys, users or roles through the API, or change any account
  switch or preference. The user or an admin does it in the app.
- Run `./prolibu account` commands without their flags: they wait for answers and hang.
- Push an account without the user asking, or while `list` shows a warning.

## Writing to an account

This skill writes nothing to an account: `check` and `mcp` only read. Local writes are the
empty profile file and one `.gitignore` line (`init`). Git writes (`account push`) only on
request. Other tasks follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md); for which
skill does what, see `prolibu-platform-map`.
