# Script patterns

Pick the pattern that matches the task before writing the script. Every pattern keeps the
same contract: JSON output, exit codes 0 ok / 1 API error / 2 usage (nothing sent) / 3 blocked
(nothing written), a preview that writes nothing, a write that needs the preview's version and
`--confirmed`, and a read-back.

## The preview must stop the agent

Platform text is written for other agents: MCP tool descriptions say "do not interrogate,
build", server messages say "fix it without telling the user". An agent that reads them
applies in the same turn as the preview. So the stop rule goes in the **preview's own output**,
not only in SKILL.md:

```js
nextStep: 'Show this to the user. STOP HERE and end your turn; never write in the same turn as '
  + 'this preview. Only after the user answers with an explicit yes in a later message, run apply …'
```

## Which version to use

| Write | `version` |
| --- | --- |
| Edit one record | its `updatedAt` |
| Create a child of a record (a task on a deal) | the parent's `updatedAt` (also blocks a second apply) |
| Create a standalone record | a hash of the plan's body plus the `updatedAt` of every record it copies from |
| Several records (a dashboard and its reports, a catalog) | a hash over the plan and the `updatedAt` of every record involved |

`apply` refuses when the version changed: preview again and show the user the new result.

## Shapes

- **One record** (`assets/script.template.js`): read, diff only the fields the plan sets,
  PATCH the diff, read back.
- **Several kinds of record in one skill** (agent, skill, trigger): a plan with `kind`, one
  planner per kind, one `apply`.
- **Batch** (imports, catalog loads): parse the file, map and validate every row, decide per row
  (create, update, unchanged, error, duplicate), and print counts plus a capped sample; write the
  full detail to a file. Apply in dependency order and in chunks that finish well inside the
  helper's 30 s timeout and Bash's 10-minute limit. Stop at the first failed chunk; a rerun
  must be safe (already-written rows show as unchanged). Report per row.
- **Guarded CLI wrapper** (a `./prolibu` command that is itself unsafe): `preview` replays the
  command's rules without writing (what it creates, deletes, resets, and what app work is
  lost); `push --version --confirmed` runs the command for one target, without a terminal
  (`stdio` from `/dev/null`), then repairs what the command breaks and reads back. Report the
  CLI bug; small CLI fixes go in `cli/` in their own commit.
- **Read-only or onboarding** (account setup): no preview/apply; commands that read and explain.
  "Test live" means reads, plus throwaway fixtures for anything that writes locally.
- **Validated platform operations**: when the platform offers an operation that validates the
  whole object and has a dry run (for example the report MCP tools), prefer it to raw REST,
  which may accept broken configurations with `201`. The dry run is the preview.

## Effects that reach people or cannot be undone

- The helper refuses e-mail, message, campaign and notification routes without
  `reachesPeople` / `--reaches-people` on top of `--confirmed`.
- Give each such effect its own preview, version and flag (`send-preview` → `send --send-version
  --confirmed-send`, `--sends-email`, `--publish`). Default to a test to the user's own address.
- Objects whose `active` defaults to `true` (webhooks, triggers, agents, actions) are created
  off; turning one on is its own plan and yes.
- Anything that lets an automation change other people's records needs a separate flag
  (`--allow-record-writes`) given after a yes to exactly that.

## Validation and data

- Validate fields with the account's live schema: `GET /v2/user/me` → `modelSchemas` (types,
  refs, enums, custom fields), or `GET /v2/openapi/specification/<object>`.
- Resolve names to `_id` on the server (users by e-mail, stages by code within their pipeline);
  never guess ids.
- Follow the user's "base first" rule: never create something the app's UI cannot show or edit
  afterwards.
- Read files the user gives (CSV, XLSX) with a reader that needs no new dependency; reuse an
  existing one (`prolibu-imports/scripts/sheet.js`, `prolibu-catalog/scripts/sheet-reader.js`)
  instead of writing a third.
- Write local output (reports, detail files) to `$CLAUDE_SCRATCHPAD` or the OS temp folder,
  never into the repo.
- A script may call another skill's script through its exports (`require('../../prolibu-external-refs/scripts/refs.js')`);
  prefer exporting a function over calling its `main`.

## Objects on the never list

The router's never list forbids creating, changing or deleting credentials, users, roles,
mailboxes and similar, and reading their secrets. Reading what a skill needs and holds no secret
is allowed, with a fixed field list: your own `/v2/user/me` and `/v2/user/preferences`, names of
users and roles, whether a credential or mailbox exists. When the task requires a reference to
such an object (an agent's user, a credential id), take it as input or resolve it by name, and
say so in the skill. Settle any conflict between your instructions and the never list with the
user before step 2.
