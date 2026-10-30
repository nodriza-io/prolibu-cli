# Stage model: how pipelines are stored and what a move does

Reference for `prolibu-stages`. Read the section you need.

## The Stage record

| Field | Meaning |
| --- | --- |
| `stageName` | Name shown on the board, stored in the account's language. `lang.<es\|pt\|fr>.stageName` holds the seeded translations. When the account language changes, factory stages are renamed to it unless the account renamed them. |
| `stageCode` | Unique key. Factory stages have readable codes (`deal-stage-approved`); others get `STG-<number>`. A PATCH may send the code instead of the id (see "Moving"). |
| `stageType` | `<Model>.<field>`: the pipeline it belongs to. Must be an existing stage field of that model. |
| `index` | Order on the board, ascending. The app leaves gaps of 100 and puts a moved stage halfway between its neighbours. |
| `active` | `false` hides it from the board and from stage pickers. `GET /v2/stage` still returns it. |
| `endFlowStage` | A closing stage (won, lost, done). Locks deals, triggers surveys, completes work orders. |
| `percentage` | 0–100. Work orders with progress "By Stage" take it as their progress; scoring rules and reports can read it. |
| `requiredFields` | Field paths the server requires when a record moves in. Validated on save: each path must exist on the model. |
| `suggestedFields` | Field paths the app asks for when a record moves in; may stay empty. Not enforced by the server. |
| `protected` | Set on factory stages (see below). |
| `allowEveryone.view` / `.edit` | Without `view`, only the creator sees the stage in the app's pickers. |
| `setAsDefault`, `color`, `emoji`, `description` | Display. |

Reading stages is open to any valid token. Creating, updating and deleting need the Stage
resource permissions.

## Pipelines and stage fields

- Every field of a model that references `Stage` is a stage field, and its pipeline is
  `<Model>.<field>`. Most models have `stage` and `priority` (priority stages are Low, Medium,
  High, Critical). A custom field of type Stage makes one more (`Company.customFields.<name>`).
- Not pipelines: Stage references inside arrays (payment plan installments on a deal) and
  configuration fields that point to another model's stages (`Task.workOrderStageOnDone`).
- To discover them: `GET /v2/service/getSchema?modelNames=<Model>&type=attrs` (refs with
  `ref: "Stage"`) and `type=arrays` (to skip array paths). The model name is exact
  (`WorkOrder`, not `workorder`).
- The board loads each pipeline with `GET /v2/stage` filtered by `stageType`, sorted by `index`,
  and drops inactive stages on screen. Cards per column: `xquery {"<field>": <stageId>}`, sorted
  `-pipelineStages.<field>.index`; deals add the column total of `proposal.quote.convertedTotal`.
- A group (folder) with `customStages` shows only those stages, in that order. Only the app uses
  this; the server ignores it.
- Stages whose `stageType` names a field that no longer exists are orphans: `pipelines` lists
  them under `orphanStageTypes`.

## Factory stages

Seeded in every account with fixed ids. The server reacts to these ids, never to names.

| Model | Stage | id | What the server does |
| --- | --- | --- | --- |
| Deal | Approved | `76a6f41079d81268f83fede4` | Creates a work order (unless `operations.workOrders.autoCreateOnDealApproval` is off; never twice); quote calendar events → Confirmed; closes the deal |
| Deal | Denied | `76a6f41079d81268f83fede5` | Applies the denial rule; calendar events → Cancelled; closes the deal; leaving it clears `denied.*` |
| Deal | Meeting Scheduled, In Process, Proposal Sent, Negotiation, Stand By | `…fede1`, `…fede2`, `16a6…fede2`, `…fede3`, `36a6…fede5` | Nothing special |
| Contact | Attempted Contact | `3396e41069c71267e72feda0` | Records `firstContact` the first time |
| Contact | Marketing Qualified | `3396e41069c71267e72feda2` | The app asks for an `fps` date when the contact has that field |
| Contact | Client | `3396e41069c71267e72feda4` | Sets `clientSince` if empty |
| Contact | Lost | `3396e41069c71267e72feda5` | Leaving it clears `lost.*` |
| WorkOrder | In Execution, Suspended, Completed, Cancelled | `88a8…fc409`, `…fc410`, `…fc405`, `…fc406` | Time tracking (`time.startedAt`, `suspendedTime`, `completedAt`, `cancelledAt`); leaving Cancelled clears `cancelled.*` |
| Ticket | Resolved, Closed | `64e6f53079d82378f83fc103`, `…fc106` | Resolved tickets can be auto-closed later; a comment can reopen a closed ticket |

Factory stages are `protected`. Their editable keys are `stageCode`, `stageName`,
`description`, `index`, `active`, `color`, `setAsDefault`, `endFlowStage`, `allowEveryone`,
`requiredFields`, `suggestedFields` and, on accounts with the newer list, `percentage`. Any other
key (`emoji`, `stageType`, `lang`) answers 403 "Document key '…' is protected". Deleting one
answers 403 "Document protected.", even for an admin.

## Moving: what the server does, in order

`PATCH /v2/<model>/<id>` with `{"<field>": "<stageId>", …other fields}`. A dotted stage field
(`customFields.x`) travels nested: `{"customFields": {"x": "<stageId>"}}`.

1. A stage value that is not an id is looked up by `stageCode`. A name fails with 400
   "Document not found by primaryKey '<name>' in 'stage'". A move by code also leaves
   `stageMovedAt` unchanged (only `pipelineStages` updates), so send ids.
2. `stageMovedAt` is set to now (main `stage` field only), whenever the body carries a stage.
3. `pipelineStages.<field>` becomes `{movedAt, movedBy, index}`. `index` is the one the body
   sends in `pipelineStages.<field>.index` (the app sends the drop position), else the current
   time in ms, which puts the card at the top of its column.
4. Required fields are checked, only when the stage changes: each `requiredFields` path must
   have a value in the body or on the record (`null`, missing and `""` fail; `[]` and `0` pass).
   400 "Cannot move to stage '<name>' - the field '<field>' is required."
5. When stage history is on for this pipeline (`system.stage.stageHistory.enabled` and
   `trackedStageFields` includes `<Model>.<field>`; off by default), a `StageHistory` row is
   written and its id appended to the record's `stageHistory`. The row is written before the
   model's own checks run, so a move that a later check refuses still leaves a row.
6. Model checks and effects run (next section). Then the save, the `<Model>.update` webhooks,
   the model's after-update work and the socket event. Writing the history row updates the
   record a second time, so with history on, one move produces two update events and the
   record's `updatedAt` changes again just after the response.

The server does **not** check that the stage's `stageType` matches the field, that the stage is
active, or that it differs from the current one. Sending the current stage again restarts
`movedAt` (and `stageMovedAt`) without writing history.

The response is the updated record. `stageMovedMethod` on deals is `By User`, `API` (API-type
tokens) or `By Client` (the customer approved or denied from the proposal page).

## Per-model rules and effects

**Deal**
- Denied: account preference `sales.deals.stageRules.onDenialMoveToStage` —
  `reasonIsRequired` → 400 "Denial reason is required when moving to denied stage.",
  `detailsAreRequired` → 400 "Denial details are required…". The app always asks for
  `denied.reason`; `denied.reason` may be limited to a list of options configured on the account.
- Every save recomputes the score. With `proposal.enabled`, a stage change recalculates the
  whole quote (prices, taxes, `convertedTotal`), sets calendar events to Tentative, Confirmed or
  Cancelled, and finalizes time-sensitive discounts on a closing stage.
- End-of-flow lock: while the current stage has `endFlowStage`, the body may only carry
  `stage`, `pipelineStages`, `denied`, `tracking`, `notes`, `tasks`, `contracts`,
  `stageHistory`, `stageMovedAt`, `stageMovedMethod`, unless
  `sales.deals.stageRules.allowEditInEndFlowStages` is on. 400 "This deal is in the "<stage>"
  stage. The following fields cannot be modified: [fields]." Leaving the stage is allowed.
- Satisfaction survey: with `sales.deals.customerSatisfaction.sendSurveyOnEndStage`, a deal with
  an active proposal and a contact that reaches a closing stage emails the contact a survey.
- Stage-change notifications go to subscribed users; Approved and Denied send their own.
- `/v2/deal/approve` is what the customer's proposal page calls. The app moves deals with PATCH.
- Preferences `requirePermissionForApprovedStage`, `requirePermissionForViewableStages` and
  `restrictProposalViewToStages` are not enforced by the server or the app today.

**Contact**: score recomputed; Client sets `clientSince`; Attempted Contact sets `firstContact`;
leaving Lost clears `lost.*`; a contact from a Meta ad reports the move to Meta. Lost does not
lock the contact, and the server does not require a reason (the app does).

**WorkOrder**: `operations.workOrders.requireCancellationReason` → 400 "A cancellation reason
is required…"; `blockCompleteWithPendingTasks` / `blockCompleteWithUnsignedContracts` refuse a
closing stage other than Cancelled while tasks are pending or contracts unsigned. Progress "By
Stage" takes the stage `percentage`.

**Ticket**: a closing stage can send a survey to the contact; Resolved tickets can auto-close.

## Stage history and time in stage

- Time in stage: `now − pipelineStages.<field>.movedAt` (what the app's cards use).
  `stageMovedAt` exists only for the main `stage` field and on some models.
- History: `GET /v2/stagehistory?xquery={"origin.modelName":"Deal","origin.docId":"<id>"}&sort=-movedAt`
  (`fromStage`, `toStage`, `stageField`, `movedAt`, `movedBy`). Rows cannot be created or
  edited through the API. A row whose `_id` is not in the record's `stageHistory` comes from a
  refused move.

## The app's required-fields dialog

When a move lands on Lost (contact), Denied (deal), Cancelled (work order) or Marketing
Qualified with `fps` (contact), or on any stage with `requiredFields`/`suggestedFields`, the
app holds the PATCH and opens a dialog. It asks for the missing values only, requires the
reason (and the stage's `requiredFields`), and sends one PATCH with the stage and the values
nested: `{stage, pipelineStages: {stage: {index}}, lost: {reason, details}}`. A multi-card drag
sends one PATCH per card and shows one dialog for the batch (one per card for stages with their
own field lists). The app's bulk edit goes through the import service instead and asks for the
same fields first.

## Configuring stages

| Action | Call | Notes |
| --- | --- | --- |
| Create | `POST /v2/stage` | `stageName`, `stageType`, `index` (last + 100), `color`, `active: true`, `allowEveryone: {view: true}` |
| Rename, recolor, set percentage or field lists | `PATCH /v2/stage/<id>` | Factory stages: only the editable keys above |
| Reorder | `PATCH /v2/stage/<id>` `{"index": n}` | Halfway between the new neighbours |
| Hide | `PATCH /v2/stage/<id>` `{"active": false}` | Records keep the stage |
| Delete | `DELETE /v2/stage/<id>` | Not for factory stages. Every record in it gets the field set to `null` and loses `pipelineStages.<field>` |

Changing `requiredFields` does not touch records already in the stage: the rule applies to the
next move in.
