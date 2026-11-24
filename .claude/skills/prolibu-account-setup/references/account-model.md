# Accounts, keys and the MCP server: how they behave

Verified against the CLI code in this repo, the platform's server and app code, a test
account, and Claude Code 2.1. Claims that could not be verified say so.

## Local files

| File | Holds | Read by |
| --- | --- | --- |
| `accounts/<domain>/profile.json` | `{"apiKey": "…"}` | Every `./prolibu` command, the API helper, every skill script |
| `accounts/<domain>/profile.<name>.json` | A second key (for example a non-admin user's) | Only the API helper and skill scripts, with `--profile <name>` |
| `accounts/<domain>/scripts/`, `sites/`, `plugins/`, `vt/`, `objects/` | The account's code | `./prolibu` commands |

- The CLI repo's `.gitignore` ignores `accounts/` entirely.
- `./prolibu` commands only know `profile.json`. Several of them (`script create`,
  `site create`, `site run`, the object and custom-field commands) ask for the key when the
  file is missing, as plain visible text, and save it. Some accept `--apikey <key>`: never use
  it, the key would land in the shell history.
- `init` creates the file with mode `0600`. `list` warns when a profile file can be read by
  other users of the computer.

## `./prolibu account`

All four work on `accounts/<domain>` under the current folder, so run them from the repo
root. None calls the Prolibu API: they only run git, with the user's own git access.

| Command | Non-interactive form | Asks when | Does |
| --- | --- | --- | --- |
| `import` | `--domain <d> --repo <url>` | The flags are missing; or the folder already has files: with a repo it offers *pull*, *delete and re-clone* or *cancel*; without one, *delete it and import?* | `git clone <url> accounts/<d>`, then writes a `.gitignore` (`profile*.json`, `dist.zip`, `node_modules/`, `.DS_Store`, `*.log`) **only if the repository has none**, then lists the scripts, sites, plugins and tours found |
| `pull` | `--domain <d>` | No `--domain` (a list of accounts) | If the branch has no upstream, sets it to `origin/<branch>`; then `git pull` |
| `push` | `--domain <d> -m "<message>"` | No `--domain`, or no message when there are changes | Refuses if a `profile*.json` is committed. `git status` without the key files; if clean, stops. Else stages everything except `profile*.json` (whatever the `.gitignore` says), `git commit` (no shell), `git push` |
| `list` | always | never | Folders under `accounts/` with their git remote and items. It does not say whether a key is there: use the skill's `list` |

Without a terminal, a question aborts the command (exit 130) or leaves it waiting: always
pass the flags.

Traps, reproduced on throwaway local repositories:

- **A key committed by hand stays in the history.** `push` never stages `profile*.json`, but
  one committed with plain git blocks `push` until it is untracked, and its key must be
  rotated. `init` adds `profile*.json` to the `.gitignore`; `list` reports every profile a
  plain `git add .` would publish.
- **`import` into an existing folder can delete it** (*delete and re-clone*). The domain is
  not validated: a value with `/` or `..` would clone outside `accounts/`.

## API keys

- A key is a `Token` of type `API`, created in the app: avatar menu › **Security › API Keys**
  (Spanish: **Seguridad › Claves API**). In the classic app the item shows to admins and to
  users with the `token` permission; in the new app to every signed-in user. In the new app,
  the list of every user's tokens is an admin screen.
- The form: **App name** (required for API keys), **Description**, **Roles** or **Scopes**
  (not both: the server refuses), **Expires at** (empty = never expires).
- The key belongs to the user who creates it. A non-admin may only give it roles and scopes
  they have. With neither, the key gets that user's permissions **as they are at that moment**,
  plus the routes every signed-in user may call. Later role changes update sign-in sessions
  but not API keys.
- An admin's key with no scopes may do everything. An admin's key with scopes is **locked to
  them**: admin-only routes answer `403`, and so does `GET /v2/user/me` unless the scopes
  include `Resource@User.me`.
- The app shows the key once; the account keeps only a hash. Lost means replaced.
- `401` (the message is translated: "token does not exist", "Token expired", "User is not
  active", "Missing API Key") means the key was refused. `403` means the key is valid and the
  action is not allowed.
- Keys, users, roles, OAuth apps and MCP sessions are on the platform map's never list: a
  skill never creates, lists, changes or deletes them. Reading `GET /v2/user/me` for the key's
  own user is the exception every skill already relies on.

## What `check` reads

- `GET /v2/user/me` → `{profile, modelSchemas, uiSchemas, permissions, oauth}`.
  `profile.isAdmin`, `profile.status` (`Active`), `profile.roles` (populated, `roleName`),
  `profile.locale` (`language`, `currency`, `timeZone` when set). `permissions` is the key's
  scope list (`Resource@<Model>.<action>`, `ProtectedField@…`); for a non-admin it also
  includes the routes every signed-in user may call. For an admin key without scopes it is
  empty.
- `GET /v2/user/preferences` → the account settings every signed-in user may read. Among them
  the switches skills depend on:

  | Setting | Default | In the app | Needed by |
  | --- | --- | --- | --- |
  | `integrations.mcp.enabled` | off | Preferences › Integrations › MCP | The MCP server, `prolibu-dashboards` |
  | `integrations.webhooks.enabled` | off | Preferences › Integrations › Webhooks | `prolibu-webhooks` |
  | `integrations.lifecycleHooks.enabled` + objects | — | Preferences › Integrations | Scripts on record events |
  | `security.oauthServer.enabled` | off | Preferences › Security › OAuth server | OAuth clients only |

  Preferences is an admin screen in the app. A skill never changes them.
- The per-skill table in the script (`SKILL_NEEDS`) lists the main permissions each skill's
  writes need. A `ready` skill can still be refused on single records by the account's
  record-level rules. Skills added later are not in it: compare their object with
  `writePermissions`.

## Production or not

The CLI has one rule, from the domain: a first label `dev` (with or without digits), `stg`,
`staging`, `qa` or `test` is a test account; anything else, including custom domains, is
production. The helper prints a warning on every write to a production-looking domain.

## The MCP server

- One endpoint per account: `https://<domain>/v2/mcpsession/ses`, Streamable HTTP, protocol
  `2025-03-26`, tools only. It is **stateless**: only `POST` works; `GET` and `DELETE` answer
  `405`, and an `Mcp-Session-Id` is ignored. Each `initialize` stores an `McpSession` record
  as an audit trail.
- Order of checks on every call: the account switch (`403 MCP server is disabled by the
  administrator.`), then the key (`401` with a `WWW-Authenticate` header), then the key's
  scopes per tool call (a tool result with `missing scope: Resource@…`). The key is checked
  exactly like on the REST API, and the tools act as its user.
- `GET /v2/mcpsession/metadata` is public (no key) and answers even with the switch off: the
  endpoint, the OAuth endpoints, and the tool catalog (`find`, `findOne`, `search`, `create`,
  `update`, `delete`, `addNote`, `addTask`, `getActivity`, `listModels`, `describeModel`,
  `getMyProfile`, `calculateQuote`, `createProposal`, `updateProposal`, `draftEmail`,
  `sendEmail`, and the report and dashboard tools). It answering does not mean the switch is
  on.
- OAuth: with the OAuth server and MCP switches on, the account serves
  `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, but
  no client self-registration. An OAuth client needs an OAuth app an admin creates. For
  Claude Code, the key header is the way.
- The developer guide chapter `docs/integrations-for-ai-agents/08-ai-and-mcp.md` still
  describes the older stateful server (SSE on `GET`, `DELETE` to close, `Mcp-Session-Id`, a
  30-minute expiry) and lists fewer tools. The server no longer works that way.

## Claude Code

- `claude mcp add --transport http --scope local <name> <url> --header "…"` stores the server
  in the user's Claude Code config (`~/.claude.json`, under this repo's folder), with the
  header **in clear**. That file is outside the repo.
- `claude mcp add` prints the header as `[REDACTED]`. `claude mcp list` checks each server
  and prints no headers. **`claude mcp get <name>` prints the header with the key.**
- Scopes: `local` (default) = this folder only; `user` = every folder; `project` = a
  `.mcp.json` file in the repo, which this public repo must never get.
- The command from `mcp` reads the key into a shell variable from the profile file and stops
  if that fails, so a missing file never registers a broken server. The command text, and so
  the shell history, never contains the key.
- Not verified in the Claude Code interface (no live session was connected while writing
  this): the exact wording `/mcp` shows for a refused key, and whether a running session picks
  up a server added meanwhile. Starting a new session always does.
- When the account's key changes, the stored copy does not: remove the server and add it
  again.
