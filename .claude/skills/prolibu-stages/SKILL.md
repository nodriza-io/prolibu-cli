---
name: prolibu-stages
description: Work with Prolibu pipelines and stages the way the app's boards do — list a model's pipelines and stages in order, move deals, contacts, tickets, work orders or custom-object records to another stage (one or many), fill the fields a stage requires (denial or loss reason, assignee…), explain what a move triggers (quote recalculation, score, work order on approval, closed-deal lock, surveys), read time in stage and stage history, and explain how stages are created, renamed, reordered, deactivated or deleted. Use it whenever someone asks to move, advance, win, lose, deny or close a record, asks which stage something is in or for how long, or reports "Stage required field is missing", a deal that cannot be edited after closing, a record that vanished from its board, or a time in stage that reset. Spanish triggers: "etapa", "pipeline", "embudo", "mover el negocio", "pasar a ganado/perdido", "negar el negocio", "campos requeridos de la etapa", "tiempo en la etapa".
---

# Prolibu Stages

## Central idea

A **pipeline** is the set of `Stage` records that share a `stageType`, written
`<Model>.<field>` (`Deal.stage`, `Deal.priority`, `Ticket.stage`…). A record sits in a stage
through a field that points to a Stage `_id`. Moving it is one `PATCH /v2/<model>/<id>` with the
new stage id, plus any fields the stage asks for, in the same body.

The server trusts that call: it accepts a stage from another pipeline, an inactive stage, or the
stage the record is already in (and then restarts its time in stage). The app never sends those,
and neither does this skill. `scripts/stages.js` checks all of it before writing:

```
node .claude/skills/prolibu-stages/scripts/stages.js <command> <domain> …
  pipelines <domain> <Model>                  stage fields and their stages, in board order
  find      <domain> <Model> <part of the name>
  show      <domain> <Model> <id>             current stage, time in stage, what each move needs, history
  move      <domain> <Model> <id>[,<id>…] --to <stage> [--field <f>] [--set '<json>']        preview
  move      … --versions '<versions from the preview>' --confirmed [--end-flow]              write
```

`<stage>` is the stage `_id`, its `stageCode`, or its name in any language (accents and case do
not matter). Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent),
3 blocked (nothing written). Use the exact model name: `Deal`, `Contact`, `Ticket`, `WorkOrder`,
`Task`, or the custom object's name.

## Ask the user first

1. **Which record?** A name is enough; `find` gets the id. Several matches: list them and ask.
2. **Which stage?** If the name fits several stages, show the pipeline and ask.
3. **The fields the stage asks for**, in the user's words: the reason a deal was denied or a
   contact was lost, the assignee, the cancellation reason. Never invent them.
4. **For a closing stage** (Approved, Denied, Lost, Client, Completed…): confirm the effects the
   preview lists, separately. Approving a deal creates a work order.

If the account has several domains under `accounts/`, ask which one.

## Steps

**See the pipelines.** Run `pipelines <domain> <Model>`. Each stage field is one pipeline; stages
come by `index`, the board's left-to-right order. Flags: `active`, `endFlowStage` (closing stage),
`percentage` (probability or progress), `requiredFields`, `suggestedFields`, `factory` (seeded,
cannot be deleted) and `private` (only its creator sees it in the app). Most models have two
pipelines, `stage` and `priority`; "the pipeline" means `stage` unless the user says otherwise.

**Move one record.**

1. `find <domain> <Model> "<name>"`, then `show <domain> <Model> <id>`. `show` lists every stage it
   can go to, what each one `needs`, and the `options` when the account limits a field to a list
   (the denial reason often is). Offer those options to the user; others are refused.
2. Preview: `move <domain> <Model> <id> --to "<stage>"`. Add `--set '<json>'` with the values the
   user gave, nested or dotted: `--set '{"denied":{"reason":"Price","details":"Chose a cheaper offer"}}'`.
   Use `--field priority` (or another stage field) for a pipeline other than `stage`.
3. Tell the user, in plain words: from → to, the fields that will be saved, every `effect` and
   `warning`. If there are `blockers`, explain them and stop; for a missing field, ask for the value
   and preview again.
4. After an explicit yes, run the same command plus `--versions '<versions json from the preview>'
   --confirmed`, and `--end-flow` when the target is a closing stage and the user accepted its
   effects. It refuses if the record changed since the preview.
5. Report from the read-back: `"moved": true`, the new stage, `movedAt`, and for an approved deal
   the work order created.

**Move several records.** Pass the ids comma-separated (up to 50). The preview checks each one; a
single blocker stops the whole batch before anything is written. The write sends one PATCH per
record, like the app's multi-card drag, and reports each result; on a partial failure, tell the
user which ones moved and which did not.

**Time in stage and history.** `show` gives `movedAt`, `movedBy` and `timeInStage` per stage field
(from `pipelineStages.<field>.movedAt`, what the cards use) and the stage history when the
account keeps it. A history row marked `notApplied` is a move the server refused: ignore it.

**Configure stages.** There is no script: use the shared helper (`../_shared/WRITE-FLOW.md`),
with the summary and the yes it requires. Creating, editing and deleting stages needs the Stage
create/update/delete permissions (admins).

- Create: `POST /v2/stage` with `{"stageName":"…","stageType":"Deal.stage","index":<last index + 100>,
  "color":"#2B3299","active":true,"allowEveryone":{"view":true}}`. Optional: `endFlowStage`,
  `percentage` (0–100), `requiredFields` and `suggestedFields` (field paths of that model, such
  as `"assignee"` or `"denied.reason"`; an unknown path is refused), `emoji`, `description`.
  Without `allowEveryone.view` only the creator sees the stage.
- Rename or change color, percentage, required fields: `PATCH /v2/stage/<id>` with those keys.
- Reorder: `PATCH /v2/stage/<id>` with `{"index": <halfway between its new neighbours>}`.
- Hide: `PATCH /v2/stage/<id>` with `{"active": false}`. Records keep it; the board and pickers
  stop offering it. This is the safe way to retire a stage.
- Delete: `DELETE /v2/stage/<id>`, only for stages the account created. Every record in it loses
  its stage and drops off the board. Count them first
  (`GET /v2/<model>?xquery={"<field>":"<id>"}&limit=1`, read `pagination.count`) and say the
  number in the summary.

## How the platform behaves

Details, factory ids and per-model effects are in `references/stage-model.md`.

- **The server checks required fields only when the stage changes.** Empty means `null`, missing
  or `""`; `[]` and `0` pass. Answer: 400 "Cannot move to stage '…' - the field '…' is required."
- **The app asks for more than the server enforces.** Deal → Denied: `denied.reason` (and
  `denied.details` when the account requires it, which the server enforces). Contact → Lost:
  `lost.reason`. Work order → Cancelled: `cancelled.reason`. The script requires the same. The
  values travel in the same PATCH as the stage; leaving that stage clears them.
- **Factory stages carry the behavior.** Approved and Denied (deals), Client and Lost (contacts),
  Cancelled (work orders) are fixed ids. A stage the account made called "Won" closes nothing and
  creates no work order.
- **A move does more than change a field.** It restarts the time in stage, may write a history
  row, fires `<Model>.update` webhooks (twice when history is on) and change notifications to
  subscribed users. On deals it recomputes the score, recalculates an active proposal's quote,
  and on Approved creates a work order.
- **Closed deals are locked.** In an end-of-flow stage a deal only accepts the stage, the denial
  reason, notes, tasks and contracts, unless the account allows edits in end-flow stages. To
  change anything else, move it out first (that clears the denial reason).
- **Surveys go to real people.** With satisfaction surveys on, a deal with an active proposal
  that reaches a closing stage emails its contact; a ticket reaching a closing stage does the same.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| 400 "Cannot move to stage '…' - the field '…' is required" | The stage's `requiredFields` | Ask for the value, `--set` it in the same move |
| 400 "Denial details are required…" / "Denial reason is required…" | The account's denial rule | `--set '{"denied":{"reason":"…","details":"…"}}'` |
| 400 "'…' is not a valid option for 'denied.reason'…" | The account limits the reason to a list | Pick one of the `options` `show` lists |
| 400 'This deal is in the "…" stage. The following fields cannot be modified: […]' | The deal is closed | Move it out first, or an admin allows end-flow edits |
| A record vanished from its board | Its stage belongs to another pipeline, or the stage was deleted | `show` it; move it to a stage of its own pipeline |
| Time in stage went back to zero without a move | The same stage was sent again | Never resend the current stage (the script refuses) |
| 400 "Document not found by primaryKey '<name>'" | A stage name was sent instead of the id | Use `--to`: the script resolves the id |
| 403 "Document key '…' is protected, cannot be modified." on a stage | A factory stage field outside its editable list | Only name, color, index, active, end-flow, percentage and field lists change |
| 403 "Document protected." when deleting a stage | It is a factory stage | Deactivate it instead |
| The history shows a move that did not happen | A refused move still writes its history row | Trust the record; `show` marks it `notApplied` |
| A work order or its task plan must be created | Work orders are built from projects | `prolibu-projects` |

## Verify

- The write's read-back says `"moved": true`, with the new stage and a fresh `movedAt`.
- Every `--set` field reads back as sent.
- After approving a deal, `workOrders` lists the work order.

## Don't

- Copy this configuration to another account by hand: use `prolibu-config-promotion`.
- Change a record's stage with a hand-made PATCH or the generic helper. Use `move`.
- Move a record to a stage of another pipeline, an inactive stage, or the stage it is in.
- Move a lead to Converted: it creates a contact. `move` refuses it; use `prolibu-leads`.
- Invent a denial or loss reason, or move to a closing stage without the user's separate yes.
- Approve a deal to "test" anything: it creates a work order and may email the customer.
- Use `/v2/deal/approve`: it is the customer's approval from the proposal page.
- Delete a stage that has records, or make a "Won" stage and expect the factory behavior.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `move` without `--confirmed` is the summary
step. For a deal's quote see `prolibu-quotes`; for which object holds what, `prolibu-platform-map`;
for reacting to stage changes from outside, `prolibu-webhooks`.
