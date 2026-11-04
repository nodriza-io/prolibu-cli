---
name: prolibu-ai-agents
description: Set up Prolibu's native AI agents the way the app does it — the agent profile (instructions, model, LLM credential by id, who may use it), its skills and actions, and the triggers that run it on a schedule or when a record is created, changed or deleted — with a check of what the agent can change on its own, triggers created switched off, and a separate yes before an agent may change records. Also reads its runs, token use and failures. Use it whenever someone wants to create or change an AI agent, give it skills or actions, run it every morning or when a contact or deal changes, test it, see what it costs, or reports an agent that "does nothing", ignores a skill, says "agent user missing or inactive", or a trigger that never fires. Spanish triggers: "agente de IA", "crear un agente", "darle skills al agente", "habilidades del agente", "disparador", "que el agente corra cada mañana", "cuando se cree un contacto", "cuánto cuesta el agente".
---

# Prolibu AI agents

## Central idea

A native agent is three kinds of records, all under `/v2/`:

- **The agent** (`AiAgentProfile`): name, instructions, LLM credential and model, who may use
  it, its skills and global actions. **It runs as one user** (`assignee`, one agent per user):
  that user's roles, workspaces and record access are the agent's.
- **Skills** (`Skill`). An `agent` skill is a mode the agent's router enters when its
  `classification` matches. A `prompt` skill is a task prompt: the router ignores it, and it is
  what a trigger runs.
- **Triggers** (`EventTrigger`): a `routine` (cron + time zone) or a `lifecycle` event
  (`Contact.afterCreate`…) that runs the agent with a prompt skill as its task.

The rule that breaks things: **an agent with no usable skill and no action gets every platform
tool** (create, update, delete, send e-mail…) in the app's chat and in triggers, and a trigger
runs with nobody to confirm anything. So the script reports what the agent can change on its
own, and an agent or trigger that can do that needs its own yes.

`scripts/agent.js` does the fragile parts: it resolves skills and actions, keeps the stored
skill order, refuses what the router would ignore, checks the model against the credential,
creates triggers switched off, and reads back.

```
node .claude/skills/prolibu-ai-agents/scripts/agent.js <command> <domain> …
  agents   <domain> [text]                       show <domain> <agent _id | AGT-code>
  skills   <domain> [text] [--type prompt|agent] actions <domain> [text]
  triggers <domain> [<agent>]                    models <domain>
  runs     <domain> <agent> [--limit n]
  preview  <domain> '<plan json>'                writes nothing; returns a version
  apply    <domain> '<plan json>' --version <v> --confirmed [--allow-record-writes]
  test     <domain> <agent> '<message>' [--mode internal|channel] --confirmed [--allow-record-writes]
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written).

## Ask the user first

1. **What should the agent do, for whom?** In the chat for the team, or on its own on a
   schedule or a record event. Which records it may read and which it may change.
2. **Which user does it run as?** Their e-mail. That user's access is the agent's reach. A
   dedicated user with only the roles it needs is safer than a person's account or an admin.
3. **Which LLM credential?** Its id, from `models` or from an admin. This skill never creates,
   reads or changes credentials. Never offer one marked `personalBridge`: only its owner can use it.
4. **For a trigger:** the schedule and time zone, or the object and event; and the task, in
   plain words (it becomes a prompt skill).

If `accounts/` has several domains, ask which one.

## Steps

1. **Read.** `agents`, then `show <agent>`: note `reach` (what it can do), `ignoredSkills`,
   `triggers` and `version`. For choices: `models`, `skills --type agent`, `actions`.
2. **Plan.** One record per plan; without `"id"` it creates one.

   ```json
   {"kind":"agent","id":"AGT-…","set":{"instructions":"…","model":"…","providerCredential":"<id>"},
    "skills":{"add":["SKL-…"],"remove":[],"order":[]},"actions":{"add":["<actionCode>"],"remove":[]}}
   {"kind":"skill","set":{"skillName":"…","skillType":"prompt","systemPrompt":"…","content":"…"}}
   {"kind":"trigger","set":{"eventTriggerName":"…","type":"routine","skill":"SKL-…","agentProfile":"AGT-…",
    "routine":{"periodicity":"0 8 * * 1-5","timeZone":"America/Bogota"}}}
   ```

   - New agent: `set.agentName` and `set.assignee` (e-mail or `_id`). It is created **off**.
   - Agent `set`: `agentName`, `instructions` (≤ 12,500 chars), `providerCredential`, `model`
     (empty = the credential's cheapest), `messages`, `locale`, `allowEveryone`,
     `collaborators`, `escalateTo`, `limits`, `surfaces`, `active`.
   - Agent skill: `classification` (≤ 300, required), `scope` (≤ 2000), `content`, `actions`.
     Prompt skill: `systemPrompt`, `content`.
   - Trigger: `type` `routine` with `routine.{periodicity, timeZone}`, or `lifecycle` with
     `modelName` (exact, `Contact`) and `eventName` (`afterCreate|afterUpdate|afterDelete`).
3. **Preview.** `preview <domain> '<plan>'`. Tell the user, in plain words: the `changes`;
   for an agent the model and its list price (`llm`); what it can do on its own (`reach`); every
   `warning`; and `nextSteps`.
4. **Wait for an explicit yes.** When `needsRecordWriteApproval` is true, say clearly that the
   agent may create, change or delete records **other people own**, and send e-mail, within its
   user's access, without anyone confirming. That needs its own yes.
5. **Write.** `apply` with the same plan, `--version` from the preview and `--confirmed`; add
   `--allow-record-writes` only after the yes of step 4. It refuses when anything changed since
   the preview, or on blockers.
6. **Turn on, one step at a time.** Keep a new agent and every new trigger off until the user
   tested it. Turning a trigger on is its own plan (`"set":{"active":true}`), preview and yes.
7. **Report** the ids and codes, the `nextSteps` (for a new agent: an admin turns on "AI agent"
   for its user in Users) and what is still off.

## How the platform behaves

Details and evidence: `references/agents-model.md`.

- **The user must be enabled.** Runs need `assignee` active with "AI agent" turned on (a
  billable user setting), plus a credential. The app turns it on right after creating the
  agent; this skill cannot touch users, so an admin does it in Users.
- **Model is only checked against a credential.** Without `providerCredential` any text saves
  and the agent cannot run.
- **Only active `agent` skills route.** Prompt or inactive skills on an agent are skipped
  silently. If none is left and there are no actions, every platform tool is offered.
- **Confirmation.** Actions of type script and api writes ask first by default; builtin wrappers
  (create, update…) do not. In a trigger nobody can confirm: those actions are refused.
- **Triggers start on.** `active` defaults to `true`, and the app's own form seeds `true`. The
  script always creates them off.
- **Lifecycle triggers fire for every record of that object, by anyone**, on every save
  (afterUpdate fires even when nothing changed), whatever the account's lifecycle hooks setting.
  Each fire is a full agent turn with several model calls. `modelName` is case-sensitive and not
  checked by the server: `contact` saves and never fires.
- **A trigger's task** is its skill's `content` (plus the event's record) and `systemPrompt`;
  without `agentProfile` nothing runs.
- **Cron:** five fields. The server also accepts six (seconds), which runs every few seconds.
- **Runs are conversations** with `aiAgentProfile` set; tokens are in `aiUsage`. Failures are
  `AiAgent` logs, kept 7 days. The app shows tokens, never money; `runs` estimates it from list
  prices.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| "agent user missing or inactive" | Its user is inactive or "AI agent" is off | An admin turns it on in Users |
| "agent has no providerCredential" | No LLM credential | `set.providerCredential` with an id the user gives |
| "Invalid model … for provider" | Model not offered by that credential | Pick one from `models`, or leave it empty |
| The agent ignores a skill | Prompt or inactive skill, or a designer agent | `show` → `ignoredSkills`; use an active agent skill |
| The agent did something nobody asked | Empty catalog: every platform tool | Give it skills/actions; see `reach` |
| A trigger never fires | Off, wrong `modelName` case, no agent, inactive skill, or bad cron | `triggers`, then `runs` → `failures` |
| An action "needs a person to confirm" in a trigger | `needsConfirmation` with nobody watching | Change the task, or the action, with the user |

## Verify

- `apply` reads the record back and lists `problems`; a new trigger must read back off.
- `show` again: `reach`, `ignoredSkills` and `triggers` match what the user asked.
- After a test or a first run: `runs` shows the conversation, its tokens and any failure.

## Don't

- Create, read or change users, roles or credentials, or ask for an API key. The agent's user,
  its workspaces (`sharedWorkspaces`, `selectableWorkspaces`) and "AI agent" are set in Users.
- Turn on an agent or a trigger that can change records without the separate yes, or create a
  trigger on.
- Put a prompt skill on an agent, or an agent skill on a trigger.
- Run `test` without saying it costs tokens and that its tools really run.
- Read or print conversation messages: `runs` gives metadata only.

## Writing to an account

Follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads only, plain summary,
explicit yes, write, read back. `preview` is the summary and `apply` the write. For code that
runs on events without an LLM, see `prolibu-scripts`; to notify outside systems,
`prolibu-webhooks`; for objects and how they relate, `prolibu-platform-map`.
