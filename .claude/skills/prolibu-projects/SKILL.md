---
name: prolibu-projects
description: Run Prolibu projects and work orders the way the app does — create a project (a group of tasks with its own members, working days, holidays and gantt timeline) with its tasks in order, add tasks, see how a project or work order is going (overdue tasks, who has what, progress, time in execution), create a work order for a deal and give it a task plan, and reschedule a project's tasks by working days when its start moves. Stage moves (put a work order in execution, suspend, complete or cancel it, mark a task done) go through prolibu-stages. Use it whenever someone asks to create or plan a project, an implementation or onboarding plan, a work order, asks how a project or order is going or which tasks are late, or reports a work order stuck at 0 %, tasks that do not show on the timeline, or a public timeline link. Spanish triggers: "crea un proyecto", "plan de implementación", "cronograma", "diagrama de gantt", "orden de trabajo", "¿cómo va el proyecto?", "tareas vencidas", "pasa la orden a ejecución", "reprograma las tareas", "días hábiles", "festivos".
---

# Prolibu Projects

## Central idea

A **project** is a `Group` with `modelName: "Task"`: a name, members (`collaborators`), a
working calendar (`workingDays`: Saturdays, Sundays, holidays) and a gantt timeline. Its tasks
are ordinary `Task` records that point at it with `group` (not `origin`). A **work order** is a
`WorkOrder` linked to a deal and contact, with its own pipeline (In execution, Suspended,
Completed, Cancelled) and, optionally, a project as its task plan (`taskGroup`): its progress
and task counts come from that project's tasks.

The server checks almost nothing here: it accepts a start after the due date, a work order in
"In execution" that never recorded its start, a second work order for the same deal, and moving
any record into a group. `scripts/projects.js` builds every body the way the app's gantt does,
checks first, writes after a yes and reads back:

```
node .claude/skills/prolibu-projects/scripts/projects.js <command> <domain> …
  find    <domain> <project|workorder> "<text>"
  status  <domain> <project|workorder> <id> [--offset -05:00] [--at <ISO date>]
  options <domain>                                   your user, task and work order stages
  preview <domain> '<plan json>'                     writes nothing; returns a version
  apply   <domain> '<plan json>' --version <v> --confirmed
```

Output is JSON. Exit codes: 0 ok, 1 request failed, 2 usage error (nothing sent), 3 blocked
(nothing written). Every command takes `--profile <name>`. A `FORBIDDEN` (403) means this user
may not do it: say so and stop; never retry another way or with another profile.

## Ask the user first

Answer in the user's language (Spanish with "tú" when they write in Spanish), in plain business words.

1. **Which project or work order?** A name is enough; `find` gets the id.
2. **For a new project:** its name, who works on it (e-mails; they see every task), the
   working days (Monday–Friday by default) and the holidays to skip, and the **time zone**
   (as an offset like `-05:00`). Never guess the time zone.
3. **The tasks:** title, who does each one, start day and length in working days (or a due
   day), and which task each one follows.
4. **For a work order:** the deal (it is read, never changed), who is responsible, and
   whether it gets a task plan (a new or existing project).
5. **For a reschedule:** the new start day, or how many working days to move.

## Steps

1. **Read.** `find`, then `status`. For a project: totals, `overdue` (open tasks past due,
   with days late), `dueSoon`, `byAssignee`, `byStage`, and `tasks` (each one's stage and local
   start and due days; pass `--offset`). For a work order: stage, time in
   stage, progress and its method, start/completion/suspension times, the deal and contact,
   and its project's status.
2. **Write the plan** (inline JSON, or a JSON file in a temp folder):

   | kind | Required | Optional |
   | --- | --- | --- |
   | `project` | `name`; `offset` when there are tasks | `description`, `members` (e-mails), `workingDays`, `tasks`, `workOrder` (gives that work order this plan) |
   | `tasks` | `project`, `offset`, `tasks` | — |
   | `workorder` | `name` or `deal` | `contact` (default: the deal's), `assignee`, `observations`, `progressMethod`, `project` |
   | `link` | `workOrder`, `project` | — |
   | `reschedule` | `project`, `offset`, `shiftWorkingDays` (±n) or `newStart` (day) | `includeDone` |
   | `unshare` | `project` | — |

   - `workingDays`: `{"excludeSaturday": true, "excludeSunday": true, "holidays": ["2026-12-25"]}`.
   - A task: `{"title", "assignee": "me" | e-mail, "startAt": "2026-11-10", "workingDays": 3}`,
     or `"dueAt"` instead of `workingDays`, or `"after": <number of an earlier task>` instead
     of `startAt`. A day starts at 00:00 and a due day ends at 23:59, like the gantt bars.
     Titles are plain text.
   - `progressMethod`: `By Task Completion`, `By Task Duration` or `By Stage`.
   - Example: `{"kind":"project","name":"Implementación Acme","offset":"-05:00","members":["ana@example.com"],
     "workingDays":{"excludeSaturday":true,"excludeSunday":true,"holidays":["2026-11-16"]},
     "tasks":[{"title":"Kickoff","assignee":"me","startAt":"2026-11-10","workingDays":1},
     {"title":"Configurar cuenta","assignee":"ana@example.com","after":1,"workingDays":3}]}`
3. **Preview.** `preview <domain> '<plan>'`. Tell the user in plain words: what is created or
   moved, the dates in their time zone, the calendar, who is notified (`notifies`), every
   `warning`. On `blockers`, explain and stop.
4. **Wait for an explicit yes**, in a later message.
5. **Apply** with the same plan, `--version` and `--confirmed`. It refuses when anything
   changed since the preview, which also stops a repeated apply.
6. **Report** from the read-back: ids and codes (`GRP-…`, `TSK-…`, `WO-…`), tasks created or
   moved, the work order's progress. On `problems`, say exactly what was and was not saved.

**Stage moves** use `prolibu-stages` (its preview lists the effects):
`stages.js move <domain> WorkOrder <id> --to "En Ejecución"` (or Suspendido, Completado,
Cancelado with `--set '{"cancelled":{"reason":"…"}}'`), and `stages.js move <domain> Task <id>
--to "Terminado"` to finish a task. Never set a work order's stage in a create.

## How the platform behaves

Evidence and details are in `references/projects-model.md`.

- **Work order timing lives in its stage moves.** Entering In execution records `startedAt`
  (first time only); Suspended counts paused time; Completed sets `completedAt` and net
  execution time; Cancelled sets `cancelledAt`. A work order created already in a stage
  records none of that, so this skill creates it without a stage, like the app does from an
  approved deal.
- **Progress** (`progress`, `tasksCount`, `doneTasksCount`) is computed by the server from the
  project's tasks when a task is saved: by tasks done, by duration (`time.estimate`, else the
  gantt length), or by the stage's percentage.
- **Automations** an admin may have on: block completing with pending tasks or unsigned
  contracts, require a cancellation reason, move the work order when all tasks are done
  (and back to In execution when a task reopens), or when its contracts are signed; and a
  task's `workOrderStageOnDone`. `options` says whether these are readable.
- **Approving a deal** creates its work order (once per deal); this skill never creates a
  second one, and never writes the deal.
- **Members.** Project members are added to every task of the project; a task's assignee is
  notified when assigned. Date changes notify nobody.
- **Dependencies are stored backwards:** a task's `dependencies` lists the tasks that come
  **after** it. The script writes them that way when you use `after`.
- **Reschedule** moves each open task's start and due date by the same number of working
  days of the project's calendar (and its reminder with it), one save per task. Done tasks
  and tasks without dates stay. The app has no "move the whole project" button: it only pushes
  successors when a task overlaps them.
- **Public timeline.** A project can share its timeline by link, without sign-in. The link is
  the project's id, never changes, and shows the tasks (descriptions, checklists) and members'
  names and e-mails. This skill only turns sharing **off** (`unshare`); turning it on is the
  user's decision in the app, after you tell them this.
- **Deleting** is not done here. Deleting a project leaves its tasks without a project, except
  a work order's project, whose tasks are deleted with it.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| Work order stuck at 0 % | No project linked, method "By Stage" with a 0 % stage, or no task done | `status`; `link` a project or move tasks to Done |
| "In execution" but no start time | It was created or saved directly in that stage | Move it out and back in with prolibu-stages |
| A task does not show on the timeline | It has `origin` but no `group`, or no dates | `tasks` plan into the project; give it dates |
| Dates in 1970 | Broken import data | `status` counts them as `brokenDates`; fix them in the app |
| "Cannot complete work order - task(s) still pending." | The account blocks completing with open tasks | Finish or remove the open tasks first |
| A reminder came at the old time after a move | The server only recomputes it when the reminder choice changes | `reschedule` moves it with the due date |
| FORBIDDEN on work orders | The user's role has no WorkOrder permission (common for sellers) | An admin grants it |

## Don't

- Create projects, tasks or work orders with hand-made calls, or the generic helper.
- Write the deal, use `/v2/workorder/createFromDeal` or `/v2/group/move` (they skip the
  checks), or delete a project or work order.
- Turn a timeline's public sharing on, or paste its link anywhere public.
- Assign tasks to people the user did not name, or guess a time zone or holiday.
- Retry after a FORBIDDEN or with another profile.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. Single tasks on a contact or deal are
`prolibu-activities`; stage moves `prolibu-stages`; objects and how they relate,
`prolibu-platform-map`.
