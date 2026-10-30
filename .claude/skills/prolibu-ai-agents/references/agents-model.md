# AI agents model: what the platform stores, runs and checks

Reference for `prolibu-ai-agents`. Read the section you need. Everything here was checked
against the server code, the app's code and a test account; claims checked only in code say so.

## The agent (`/v2/aiagentprofile`)

One agent is one `AiAgentProfile` record bound to one user. There is no separate "agent" object.

| Field | Notes |
| --- | --- |
| `agentCode` | Set by the server, `AGT-…`. A read accepts it in place of the `_id`. |
| `agentName` | Shown in the chat picker. The app requires it; the server does not. |
| `assignee` | **Required, unique, set only on create.** The user the agent runs as. Accepts the user's e-mail or `_id`. |
| `providerCredential` | LLM credential (`openai`, `anthropic`, `google`, `deepseek`, or a personal `localAgent` bridge). The agent's user must have access to it. |
| `model` | Model id. Checked against the credential's live model list **only when a credential is set**; empty = the cheapest priced model of that credential. |
| `instructions` | One system message after the platform's base prompt. Max 12,500 characters. |
| `messages` | `welcome`, `error` (sent when a run fails), `offTopic`, `escalation` (≤ 600 each). The app hides `escalation`: escalation goes by `escalateTo`. |
| `locale` | `strategy` `followUser` (default) or `fixed`; `fixed` needs `language` (400 otherwise). |
| `allowEveryone.view` | Default `false`. `true` lets every user pick and talk to the agent. |
| `collaborators` | Users who may also talk to it. |
| `active` | **Default `true`.** Inactive agents are not offered and do not run. |
| `skills` | Skill ids **in router order** (top to bottom). Replaced whole on `PATCH`. |
| `actions` | Global action ids, offered in every state. Replaced whole on `PATCH`. |
| `surfaces` | Screens the agent serves (`quoteBuilder`, `designStudio`). One active agent per surface; a clash answers 400. |
| `limits.maxTurnsPerHour` | Default 20: replies per channel conversation per hour before handing over to a person. |
| `escalateTo` | People who get escalations (a task to the first, all join the conversation). |
| `variables` | Typed variables (max 30). Edit them in the app. |

Unknown fields are dropped silently (the app's form still sends `persona`, `businessContext`,
merged into `instructions` long ago).

### Who may talk to it

Admins, its user, its creator, its collaborators, and everyone when `allowEveryone.view` is on.
The same check runs for the chat, scripts and when someone links a trigger to it. Whoever talks
to it, **the agent acts as its own user**, not as the person talking.

### Its user

- The user must be **active** and have **"AI agent" on** (`ai.enableAgenticProfile`, described
  by the platform as billable). The server refuses that switch until a profile names the user, so
  the order is: create the profile, then turn the switch on. The app does both from the agent
  form, or both from the Users screen.
- Its roles decide which tools work (a hard permission check per tool call, in code) and the
  account's record access mode decides which records it sees and changes (the same filter as the
  REST API). An admin user reaches everything.
- Its workspaces (`primaryWorkspace`, `sharedWorkspaces`, `selectableWorkspaces`) are user
  fields, set in Users. This skill never changes users.

### Credential and model

- `GET /v2/aichat/providers` (what the app's picker reads) lists the credentials the caller may
  use, with their models, tiers and list prices (USD per million tokens). Never a key.
  `agent.js models` shows it.
- Without `model`, each run uses the cheapest priced model of the credential that fits the
  agent's screens (the designer screen needs at least a medium model).
- A `localAgent` credential only works when its owner starts the turn: triggers, channels and
  other people get 400.

## Skills (`/v2/skill`)

| Field | `agent` skill | `prompt` skill |
| --- | --- | --- |
| `skillName` | required | required |
| `classification` | **required**, ≤ 300: when it applies (the router reads it) | — |
| `scope` | ≤ 2000: what it can and cannot do (system prompt while active) | — |
| `content` | instructions while the skill is active | the task or analysis prompt |
| `actions` | tools available inside the skill | — |
| `systemPrompt` | — | system message |
| `chatModel` | — | legacy OpenAI model for call analysis |

- `skillType` defaults to `prompt`. A skill does not change type safely: agents and triggers
  that use it would break.
- The router only uses **active `agent` skills** listed on the agent; others are skipped with
  no error. The designer screen agent uses its skills as brand context, never as modes.
- Prompt skills feed triggers, `prompt` actions, call analysis and scoring.
- The app's agent editor creates skills with `skillType: "agent"` and sends a `kind` field the
  server drops.

## Actions (`/v2/aiaction`)

`actionCode` is also the tool name the model calls (snake_case, derived from `actionName`).

| `type` | What it does | Asks first by default |
| --- | --- | --- |
| `builtin` | Wraps a platform tool (`builtin.tool`) with fixed `presets` | no |
| `script` | Runs a Script with its own key | **yes** |
| `api` | One HTTPS call through an `http` credential | **yes for writes**, no for GET |
| `prompt` | One extra model call with a prompt skill; `outputSchema` required | no |
| `placeholder` | Returns a fixed answer | no |
| `client` | A tool of a browser screen; never runs in triggers | the browser asks |

- `needsConfirmation`: in the app's chat a card asks; on WhatsApp the customer must answer a
  clear yes; **in triggers and scripts the action is refused**.
- `api` actions are offered on WhatsApp only with `api.allowInChannels`.

## What a run can do

| Agent has | In the app's chat and in triggers | On WhatsApp |
| --- | --- | --- |
| No usable skill and no global action | **Every platform tool** | Only escalation |
| Skills or actions | Global actions + one `enter_skill_…` per skill; inside a skill, its actions + `exit_skill` | Same, without api actions unless allowed |

Platform tools (the account's MCP tools): `find`, `findOne`, `search`, `describeModel`,
`getActivity`, `getMyProfile`, `listModels`, `calculateQuote`, `draftEmail` (read or draft only);
`create`, `update`, `delete`, `addNote`, `addTask`, `createProposal`, `updateProposal`,
`sendEmail`, `buildReport`, `editReport`, `planReport`, `buildDashboard`, `editDashboard`,
`captureSnapshot` (change data; `sendEmail` sends from the user's connected mailbox). Each call
checks the user's permission for that object and action; credentials, tokens and sessions are
out of reach.

## Triggers (`/v2/eventtrigger`)

| Field | Notes |
| --- | --- |
| `eventTriggerName` | Required. |
| `type` | `routine` (default) or `lifecycle`. |
| `skill` | **Required.** The task: its `content` is the input (plus the event's record) and its `systemPrompt` an extra system message. The app only offers active prompt skills. |
| `agentProfile` | The agent that runs. Without it each fire only logs a failure. Linking needs access to the agent. |
| `routine.periodicity` | Cron. Checked by the server, which also accepts a sixth (seconds) field. |
| `routine.timeZone` | Required when there is a periodicity. |
| `modelName` | Lifecycle: exact model name (`Contact`). Free text on the server: any other spelling saves and never fires. |
| `eventName` | `afterCreate`, `afterUpdate` or `afterDelete`. |
| `active` | **Default `true`; the app seeds `true` too.** On create or update the schedule is registered at once. |

- **Routine:** registered on the leader server; a tick is skipped while the previous run is
  still going. Changing or deleting the record re-registers it.
- **Lifecycle:** after every create, update or delete of that object, by anyone, the server
  looks up active triggers and starts each run without waiting. It does not depend on the
  lifecycle hooks preference (that one is for Scripts). An update fires even when nothing
  changed. Writes made during a trigger run, a playground test or a WhatsApp turn, or caused by a
  script, do not fire triggers again; writes an agent makes from the app's chat do (checked in
  code only).
- Each fire opens a conversation as the agent's user, runs a full turn (several model calls),
  saves the answer and closes the conversation.

## Runs, usage, cost, failures

- **Conversations** (`/v2/conversation`) with `aiAgentProfile` = the agent. `aiContext.origin`
  says what started it (`eventTrigger` with `triggerId`, a script…); app chats have none.
  `aiUsage` holds `calls`, `promptTokens`, `completionTokens`, `totalTokens`, `estimatedCalls`
  (when the provider sent no usage, the server estimates ~4 characters per token).
- `aiContext` and `Log.meta` are free-form: the server drops filters on their sub-fields, so the
  script filters those itself.
- **Failures:** `Log` records with `logType: "AiAgent"` (agent, origin, message), kept 7 days.
- **Cost:** the provider bills the account's credential for tokens. Prolibu shows tokens, not
  money. `runs` multiplies by the list prices of `models` (an estimate). The user setting "AI
  agent" is described as billable too.

## Testing

- **Agent playground:** `POST /v2/aiagentprofile/test` `{id, messages, instructions?, mode?}`
  runs one turn of the saved agent (even inactive) on a made-up conversation, without saving a
  conversation. **Tools run for real**, except those that need confirmation; it costs tokens.
  `mode` `channel` behaves like WhatsApp. The app's skill routing probe uses the same call.
- **Prompt skill test:** `POST /v2/skill/test` `{id, input}` makes one model call with the first
  credential the caller may use and writes nothing. Done from the app's Skills screen.

## Access to these objects

No built-in role grants agents, skills, actions or triggers: admins, or a custom role that
grants them. Reading `ServiceCredential`, `User` or `Role` is never done through a skill.
