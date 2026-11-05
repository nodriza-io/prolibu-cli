# Projects and work orders: the model

Verified against the backend code, the app's gantt and live calls on a test account
(November 2026). Server behavior first, then what the app does on top.

## Group (a project when `modelName` is `Task`)

| Field | Meaning |
| --- | --- |
| `groupName` (required), `groupCode` (`GRP-…`), `description`, `tags` | Identity |
| `modelName` (required, hidden) | What it groups: `Task` for projects. Groups of `Contact`, `Deal` or `WorkOrder` exist too and are lists, not projects |
| `collaborators` | Members. When the list is saved, the creator is added, and every task of the group gets the members merged into its own `collaborators` |
| `company` | Copied to every task saved into the group |
| `customStages` | Stages for this group only (rarely used) |
| `workingDays.excludeSaturday / excludeSunday / excludeHolidays / holidays[]` | The gantt calendar. A holiday is read as the first 10 characters of its ISO date; `holidays` only count with `excludeHolidays` |
| `shareTimeline.enabled / hideTaskAssignees / hideTaskStages / timelineUrl` | Public timeline (below) |
| `pinnedBy`, `index` | UI only |

Hooks: saving a task with `group` copies the group's members, tags and company onto the task.
There is no validation that `modelName` is a model that supports groups (the check reads a
misspelled field and never runs).

Routes: CRUD on `/v2/group`; `POST /v2/group/clone/{id}` (task groups only: copies the group
and its tasks with dependencies remapped, without the public link); `POST /v2/group/move`
(sets `group` on many records with a raw update: no hooks, no permission check on those
records, no work order progress recalculation; this skill never calls it).

**Delete** (`afterDelete`): if the group is some work order's `taskGroup`, every task in it is
deleted one by one (each fires the task's delete notification and recalculates progress);
any other group only unsets `group` on its records (contacts, deals and tasks are kept).
The app asks for confirmation and says nothing about tasks.

## Tasks inside a project

The gantt creates a task with exactly:
`{title, parent, group, assignee, timelineIndex, time: {duration}, dates: {startAt, dueAt}}`.

- `title` is plain text from the gantt (the timeline shows `titleText`).
- Day bars: `startAt` = local 00:00, `dueAt` = local 23:59 of the last day.
- `time.duration` is in **hours** of working time: 24 per working day (work hours are 0–24).
- `timelineIndex` orders the rows; new root tasks get the current maximum + 1 000 000.
- `parent` nests a task under another (summary rows).
- `dependencies` is saved on the **source** task and lists its successors. When a task's end
  passes a successor's start, the app pushes the successor to the next working time and keeps
  its working length; it also pulls a predecessor back. One PATCH per task.
- `blockers.finishToStart / startToStart / finishToFinish / startToFinish`: the server refuses
  starting or finishing a task while its blockers are not done/started.
- There is no `origin`: project tasks do not show on a deal's or contact's task list.
- Adding holidays in the app offers to push the due date of the tasks that contain them.

Notifications: a new task notifies its assignee (not yourself). Changing dates notifies
nobody; the server resets the due notice and keeps the reminder time unless `dueReminder`
or `dueReminderAt` changes.

## WorkOrder

| Field | Meaning |
| --- | --- |
| `workOrderName` (required), `workOrderCode` (`WO-…`) | Identity |
| `deal`, `contact` | Links. `company` is read-only, taken from the contact |
| `assignee`, `collaborators`, `tags`, `notes`, `attachments`, `observations`, `contracts` | Usual record fields |
| `stage`, `priority`, `pipelineStages`, `stageHistory` | Pipelines `WorkOrder.stage` / `WorkOrder.priority` |
| `taskGroup` | The project (a `Task` group) that is its task plan |
| `progressMethod` | `By Task Completion`, `By Task Duration` or `By Stage`; default from the account (`By Task Completion`) |
| `progress`, `tasksCount`, `doneTasksCount` | Read-only, computed |
| `time.expectedTime` | Set by the user (ms) |
| `time.startedAt / completedAt / cancelledAt / executionTime / suspendedTime / suspendedAt / suspendedCount` | Computed on stage moves |
| `cancelled.reason / details` | Cleared whenever the stage is not Cancelled |
| `isTemplate` | A template; `POST /v2/workorder/clone/{templateId}` copies it, its project and tasks, and its notes |

Factory stages: Acceptance sign-off, In execution, Suspended, Completed (closing), Cancelled
(closing). Work orders the app creates from an approved deal have **no stage**.

Timing (only on an update that changes the stage, never on create):
In execution → `startedAt` the first time, closes a suspension; Suspended → `suspendedAt`,
`suspendedCount + 1`; Cancelled → `cancelledAt`; any other closing stage → `completedAt` and
`executionTime = completedAt − startedAt − suspendedTime`; other stages clear completion.

Progress: recalculated when a task of its project is created, changed or deleted, when the
method or `taskGroup` changes, and (By Stage) on stage moves. By Task Duration weighs each
task by `time.estimate` (ms), else `time.duration` (hours), else the average.

Account rules (`operations.workOrders`; not readable through `/v2/user/preferences` on the
test account): `autoCreateOnDealApproval`, `namePostfix` (" - Work Order"),
`defaultProgressMethod`, `stageOnAllTasksCompleted`, `stageOnContractsSigned`,
`blockCompleteWithPendingTasks`, `blockCompleteWithUnsignedContracts`,
`requireCancellationReason`. A task's `workOrderStageOnDone` moves the work order when that
task is finished.

Webhooks: writing a work order publishes `WorkOrder.create/update` only. Creating one with a
`deal` does not write the deal. Approving the deal (a deal write) is what creates the work
order in the app.

Permissions: work orders need `WorkOrder.*` permissions that seller roles usually lack (403).
Groups are in every role's basic permissions; a user only sees groups where they are a member
or creator.

## Public timeline

`PATCH /v2/group/{id}` with `shareTimeline.enabled: true` creates a short link
(`shareTimeline.timelineUrl`) that opens without sign-in. It shows the group (members with names
and e-mails) and every task (without assignee or stage only when the hide options are on;
creators, descriptions and checklists included). Turning sharing off closes the link; turning it
on again opens the same link.
