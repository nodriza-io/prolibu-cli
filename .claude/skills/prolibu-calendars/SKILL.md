---
name: prolibu-calendars
description: Set up and run Prolibu bookable calendars the way the booking page does — create a calendar with its working hours (policies), closed dates (exceptions), round-robin team and bookable units; check free slots and say where the platform's availability is wrong; book, reschedule, cancel or confirm an appointment through the booking routes, after showing exactly who gets e-mails; and diagnose bookings made from a deal's quote (duplicates, orphans, shared rooms). Use it whenever someone asks to create or change a booking calendar, asks for free times, wants to book, move, cancel or confirm an appointment or reservation, or reports a calendar with no free slots, a slot shown free that cannot be booked, double bookings or a room booked twice. Spanish triggers: "calendario de reservas", "agenda", "horarios disponibles", "agendar una cita", "reprogramar", "cancelar la reserva", "confirmar la cita", "reserva duplicada", "habitación reservada dos veces".
---

# Prolibu Calendars

## Central idea

A **Calendar** is a bookable agenda. Its free slots come from its **policies** (working hours
per weekday), minus **exceptions** (closed dates), limits and existing **Confirmed** bookings.
A booking is a **CalendarEvent**. The booking page creates it through
`POST /v2/calendar/scheduleevent`, the only path that applies every rule. That route e-mails
the guests and the responsible person, and may push the booking to their Google/Outlook
calendar. A REST create or a status PATCH skips the rules and the notices, so this skill never
uses them.

Three traps break calendars without any error:

- **Text weekdays.** The server stores `wday: "monday"`, but the engine only matches numbers
  (0 = Sunday … 6 = Saturday). That day then shows no slots.
- **Availability is incomplete.** The free-slots call ignores exceptions, daily and weekly
  limits, unit blocks, and (in one-on-one calendars) bookings whose responsible is not the
  calendar's creator. The booking then rejects a slot that was shown as free.
- **To close a calendar, remove its policies or add an exception range.** Switching it to
  inactive does not stop bookings.

`scripts/calendar.js` handles all three in code. It writes integer weekdays only, cross-checks
every free slot against the booking rules, and makes each write that reaches people a preview
plus its own `--reaches-people` flag.

```
node .claude/skills/prolibu-calendars/scripts/calendar.js <command> <domain> …
  calendars | show <calendarId> | events <calendarId> [--from D --to D --email guest]
  availability <calendarId> [--from YYYY-MM-DD --to … --tz <zone> --group <id> --duration <min> --product <id> --unit <id>]
  deal-bookings <dealId | deal name>                       read-only diagnosis
  setup-preview '<plan>'      → setup-apply '<plan>' --version <v> --confirmed
  book-preview '<plan>'       → book '<plan>' --version <v> --confirmed --reaches-people
  reschedule-preview '<plan>' → reschedule …   cancel-preview '<plan>' → cancel …
  confirm-preview '<plan>'    → confirm …      (each: --version <v> --confirmed --reaches-people)
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written). Plans go inline in single quotes, or as a path to a temp file.

## Ask the user first

1. **Which account.** If `accounts/` has several domains, ask.
2. **To set up a calendar:** one person or a rotating team; length of each appointment; the
   step between start times; time zone; hours per weekday; closed dates; how far ahead and how
   much notice; daily or weekly caps; how many guests; preparation minutes; the cancellation
   deadline; whether bookings wait for confirmation; and who is responsible.
3. **Google/Outlook sync, every time a calendar is created.** By default, confirmed bookings
   go to the responsible person's calendar, and the provider e-mails the guests. The script
   refuses a new calendar until `externalSyncEnabled` is set.
4. **To book, move or cancel:** the exact recipients. The preview lists them. Get a yes to
   that list before using `--reaches-people`.

## Steps

**Set up a calendar.**

1. Run `calendars <domain> "<name>"` and `show <domain> <id>` to reuse existing policies.
   `show` also lists `lints` (text weekdays, no policies, sync on, responsible ≠ creator).
2. Write the plan. Items are created in this order: policy, exception, roundRobinGroup, unit,
   calendar. `"@ref"` points to an item of the same plan; `"id"` updates an existing record.

   ```json
   {"items": [
     {"kind": "policy", "ref": "hours", "set": {"calendarPolicyName": "Weekdays",
       "rules": [{"wday": 1, "from": "08:00", "to": "12:00"}, {"wday": 1, "from": "14:00", "to": "18:00"}]}},
     {"kind": "exception", "ref": "off", "set": {"calendarExceptionsName": "Holidays", "dates": ["2026-12-24"]}},
     {"kind": "calendar", "set": {"calendarName": "Advice", "type": "oneOnOne", "eventDuration": 30,
       "startTimeIncrements": 30, "timeZone": "America/Bogota", "policies": ["@hours"],
       "calendarExceptions": ["@off"], "assignee": "<userId>", "externalSyncEnabled": false}}
   ]}
   ```

   - One rule per weekday and range. `wday` is an integer 0–6. Two ranges on the same day
     must not overlap. `{"type": "date", "date": "YYYY-MM-DD", "from", "to"}` opens one date.
   - `roundRobinGroup`: `userGroupName` and `users` (user ids). Then set the calendar to
     `"type": "roundRobin"` with `"userGroups": ["@team"]`.
   - `unit` (a room or vehicle): `name`, `capacity`, `active`, `blocks` (`from`, `to`, `reason`).
     Linking units or the calendar to a product is done with **prolibu-catalog**.
3. Run `setup-preview`. Tell the user what is created or changed, who is responsible, every
   warning, and any blocker. Then stop and wait for a yes.
4. Run `setup-apply` with `--version` from the preview. It reads every record back and
   probes the next 7 days. Report the ids, the free hours per day, and the booking page
   `https://<domain>/v2/calendar/view/<calendarId>`. That page is public: anyone with the
   link can book.

**Check free times.** Run `availability <domain> <calendarId> --from … --to …`. Report
`freeStarts`. Also report `rejectedByBooking`: slots the platform shows as free that a booking
would refuse, each with its reason. Tell the user about the `caveats`. Never call
`/v2/calendar/myavailability`: it creates a calendar and a policy for the user.

**Book.**

```json
{"calendarId": "<id>", "start": "2026-11-05 09:00", "timeZone": "America/Bogota",
 "name": "Ana Ruiz", "email": "ana@example.com", "attendees": ["guest@example.com"]}
```

`start` is the wall-clock time in `timeZone`. Optional fields: `duration` (one of the
calendar's durations), `userGroupId` (round robin), `productId` and `itemStockId` (units),
`assigneeId`, `dealId`, `title`, `description`. Never add `contact`, `reminders` or `status`.
Run `book-preview`, then tell the user four things: whether the slot is free, the `outcome`
(Tentative when the calendar requires confirmation), `recipients`, and the `lints`. Stop
there. After a yes to those recipients, run `book` with `--version … --confirmed
--reaches-people`. Report the event id and its status.

**Reschedule, cancel or confirm.** Find the booking with
`events <domain> <calendarId> --from … --email <guest>`. Then pick the plan:

- Reschedule: `{"eventId", "start", "reason"}`.
- Cancel: `{"eventId", "reason"}`.
- Confirm: `{"eventId"}`.

Run the matching preview, show the recipients and blockers, and wait for a yes. Then run the
command with `--version … --confirmed --reaches-people`. Rescheduling creates a new booking
and cancels the old one.

**Diagnose a deal's bookings.** Run `deal-bookings <domain> "<deal name or id>"` and explain each
finding in plain words. Changing the quote's reserved lines is done with **prolibu-quotes** or
in the app. This skill writes nothing here.

## How the platform behaves

Details, evidence and edge cases are in `references/calendar-model.md`.

- **The booking route is public.** It ignores who calls it. With an API key, it still counts as
  a web booking: it is born Tentative when the calendar requires confirmation.
- **Who gets e-mails.** On a booking, each guest gets an invitation with an `.ics` file and
  the responsible person gets an accept/reject e-mail and an in-app notice. With sync on and
  Google/Outlook connected, the provider invites the guests instead. Rescheduling sends both a
  new invitation and a cancellation. Cancelling e-mails guests and the responsible person.
- **Only Confirmed bookings block a slot.** Tentative ones block nothing. They expire after
  `holdDurationMinutes` without any e-mail.
- **The cancellation deadline** applies to cancel and reschedule, through these routes only.
- **Quote bookings follow the deal.** Each save of the deal sets them again from its stage:
  approved = Confirmed, denied = Cancelled, any other stage = Tentative. The script refuses to
  change a booking that a quote line still lists. Orphans (their line was removed) can be
  cancelled; nobody is e-mailed, because they have no guests.
- **Units are not checked across calendars.** A unit shared by two products with different
  calendars can be booked twice. The cross-check flags it.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| A weekday shows no slots | Policy stores `wday` as text, or has no rules | Rewrite the policy through `setup` with integers |
| No slots at all | No policies, or every rule is text | `show` lints; add a policy |
| Free slot → "Event is in exception date" / "Daily limit exceeded" | Availability ignores them | Use `availability`; its `rejectedByBooking` lists them |
| Free slot → "Event already exists in this time range" | Booking by a responsible other than the creator | Same; pick another time |
| Booking stays Tentative | `requireConfirmation` | `confirm-preview` → `confirm` |
| Calendar "inactive" still gets bookings | Inactive does not close it | Remove its policies or add an exception range |
| Room booked twice on a deal | Orphan or duplicate quote bookings, shared units | `deal-bookings`, then fix the quote |

## Verify

- `setup-apply` reads each record back and reports fields that did not save. The 7-day probe
  must show the hours the user asked for.
- `book` reads the event back and checks its start time and status. `repeated: true` means
  the route returned an earlier booking with the same plan.
- `reschedule` checks that the new booking points to the old one and that the old one is
  Cancelled.

## Don't

- Create a booking with `POST /v2/calendarevent`, or change its status with
  `PATCH /v2/calendarevent/<id>` or `DELETE`. Those skip the rules, the notices and the
  Google/Outlook copy.
- Send `contact` on a booking: with an agreement template it e-mails a contract to sign.
- Use `--reaches-people` before the user approved the exact recipients.
- Call `myavailability` or `getCalendar` (the first writes, the second is broken).
- Use test-drive routes or branches, or set calendars on products (use prolibu-catalog).
- Delete calendars, policies, exceptions or bookings.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. Each `*-preview` is the summary step.
A `403` means the profile's user may not see or change that calendar or booking: stop and
say so, never retry it another way or with another profile. For a CRM meeting on a contact
(not a bookable calendar), use `prolibu-activities`. For objects and how they relate, see
`prolibu-platform-map`.
