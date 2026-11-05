# Calendar model and booking behavior

Verified against the platform's code and live calls on a test account. Read it when a case
falls outside the steps in `SKILL.md`.

## Records

| Object (REST) | What it is | Key fields |
| --- | --- | --- |
| `calendar` | The bookable agenda | `calendarName`, `type` (`oneOnOne` default, `roundRobin`, `overNight`), `bookingType` (`appointment`, `room`; `testDrive` is out of scope), `eventDuration`, `eventDurations`, `startTimeIncrements`, `timeZone`, `policies`, `calendarExceptions`, `userGroups`, `assignee`, `dateRange`, `minimumNotice`, `dailyLimit`, `weeklyLimit`, `inviteesLimit` (default 1), `slotCapacity` (default 1), `bufferBefore`/`bufferAfter` (0–720 min), `cancellationDeadline`, `holdDurationMinutes`, `requireConfirmation`, `externalSyncEnabled` (default true), `locations` |
| `calendarpolicy` | Working hours | `calendarPolicyName`, `rules`, `bookingCutoffs` |
| `calendarexception` | Closed dates | `calendarExceptionsName` (plural, as spelled), `dates` |
| `usergroup` with `userGroupType: "Calendar Load Balancer"` | Round-robin team | `userGroupName`, `users` (order = rotation), `timeZone` |
| `itemstock` | Bookable unit (room, vehicle) | `name`, `active`, `capacity`, `blocks` [`from`, `to`, `reason`], `attributes` |
| `calendarevent` | A booking | `calendar`, `status` (`Confirmed`, `Tentative` default, `Cancelled`), `startDate`/`endDate` (UTC), `timeZone`, `assignee`, `attendees`, `rescheduledFrom`, `cancelReason`, `deal`, `lineItemUuid`, `product`, `itemStock` |
| `attendee` | A guest | `email`, `fullName`, `status` |

- Allowed `eventDuration` values: 5–60 in steps of 5, then 120, 240, 480, 1440, 2880 and 7200
  minutes. From 1440 on, the slot only has to start within the hours.
- Allowed `startTimeIncrements` values: 5–60 in steps of 5, then 240, 480 and 1440.
- `calendarExceptions` has no reference type, so `populate` does nothing: read exceptions by id.
- The product side (`Product.calendar`, `Product.itemStock`, `Product.allocationMode` =
  `specific` | `pool`) belongs to prolibu-catalog. `Calendar.product` is a dead field.
- `isPublic`, `slug` and `active` do not close a calendar: remove its policies or add an exception range.
- `CalendarPolicy.user` is described as "intersection with the user's hours" but nothing reads it.

## Policy rules

```json
{"type": "wday", "wday": 1, "from": "08:00", "to": "12:00"}
{"type": "date", "date": "2026-12-20", "from": "09:00", "to": "13:00"}
{"type": "overNight", "from": "15:00", "to": "11:00"}
```

The engine filters `rule.wday === <day number>`, with 0 = Sunday. The server accepts any
`rules` without validating them, including text weekdays and an empty list. The app's editor
writes numbers. `bookingCutoffs` rows are `{weekday: "monday"…, daysBefore: 0–7, cutoffTime:
"HH:mm", appliesTo: "everyone" | "publicOnly"}`. Each row closes the day's bookings at that
time, counted in the calendar's time zone.

## What the availability call checks, and what it leaves out

`GET /v2/calendar/getavailability/<id>?startDate&endDate&timeZone[&userGroupId][&duration]`
is public and covers at most 90 days. Slot times are wall-clock times in the requested zone,
followed by a literal `Z`.

It **applies**: the policies, booking cut-offs, minimum notice, date range, buffers,
`slotCapacity`, and the responsible person's Google/Outlook busy time (when sync is on).

It **ignores** these, while the booking enforces them:

- exceptions;
- daily and weekly limits (both count Tentative bookings too);
- unit blocks and inactive units;
- in `oneOnOne` calendars, Confirmed bookings whose `assignee` is not the calendar's creator.
  It only counts the creator's events, while the booking counts every Confirmed event of the
  calendar.

Round-robin availability is an approximation, and only the booking decides who is free. The
script's `availability` and `checkSlot` re-apply the ignored rules. Exceptions are compared by
UTC day, as the server does, so an evening booking can hit the next day's exception.

`GET /v2/calendar/getavailabilityproduct/<productIds>` returns a bare list of days, with slots
per unit. For `overNight` slots, `dateTimeEnd` carries the start date (a platform bug), so the
script rebuilds the end from the duration.

`GET /v2/calendar/myavailability` creates a personal calendar and a policy the first time it is
called. `GET /v2/calendar/getCalendar/<id>` answers 400. Use `GET /v2/calendar/<id>` instead.

## Booking: `POST /v2/calendar/scheduleevent`

The route is public. It strips `createdBy`, `contact`, `contract`, `bookingType`, buffers and
other server-owned fields from the body. The fields it reads are `idCalendar`, `title`,
`description`, `location`, `timeZone`, `startDate` (`"YYYY-MM-DD HH:mm"`, wall clock),
`creator`, `creatorFullName`, `attendees` (e-mails, the booker included), `status`,
`idempotencyKey`, `userGroupId`, `product`, `itemStock`, `assignee`, `duration`, `deal` and
`seats`. Its OpenAPI says `dateTime` and `invitees`; those names are ignored.

It checks these in order:

1. the idempotency key;
2. the time zone;
3. the booking cut-off;
4. the duration;
5. an explicit assignee ("Agent not found");
6. slot conflicts among Confirmed bookings of the calendar or unit;
7. the responsible person's external busy time;
8. exceptions;
9. `inviteesLimit` (the booker counts);
10. daily and weekly limits;
11. date range and notice ("Event out of range");
12. the round-robin rotation;
13. units: the unit must belong to the product, be active and not blocked.

Calendars with `requireConfirmation` produce Tentative bookings, because the route never has
a `createdBy`. `holdDurationMinutes` then sets an expiry: a job cancels the booking silently
when it passes.

A repeated `idempotencyKey` in the same calendar returns the earlier booking, even a cancelled
one. The script derives the key from the preview, so retrying a `book` is safe.

**Effects.**

- An Attendee record per e-mail, then the CalendarEvent.
- When the booking is Confirmed and sync is on, it goes to the responsible person's
  Google/Outlook. If that push works, the provider invites the guests and the platform skips
  its own e-mails.
- Otherwise, each guest gets an invitation e-mail with an `.ics` file and accept/reject links,
  and the responsible person gets an accept/reject e-mail.
- The responsible person always gets an in-app notification.

## Reschedule, cancel, confirm

- `POST /v2/calendarevent/reschedule` `{id, startDate, timeZone?, endDate? (overNight), reason?}`
  requires a signed-in user. It refuses Cancelled bookings and a passed cancellation deadline,
  and keeps the original length when the calendar still allows it. It creates the replacement
  through the booking logic, which sends a new invitation and a new accept/reject e-mail. If
  the original was Confirmed, it confirms the replacement, then cancels the original (with
  cancellation e-mails).
- `PATCH /v2/calendarevent/changestatus` `{id, status, cancelReason?}`:
  - `Cancelled` checks the cancellation deadline, sends cancellation e-mails with `.ics` to the
    guests and the responsible person (unless the booking was synced; then the provider tells
    the guests), sends an in-app notice and removes the external copy.
  - `Confirmed` refuses a cancelled booking and an overlap with another Confirmed booking, then
    pushes the booking to the external calendar.
- `PATCH /v2/calendarevent/<id>` with `status`, and `DELETE`, skip the deadline, the notices
  and the external copy. Never use them.

## Bookings from a deal's quote

A quote line with `itemStock`, `startDate` and `endDate`, saved on a deal with the proposal on,
creates one Tentative booking per unit. These bookings have `lineItemUuid`, no responsible and
no guests, so no e-mails go out. They are matched to units **by position** in
`lineItem.calendarEvents`. A line saved without those ids creates new bookings on every save.

Every save of the deal sets these bookings again from its stage: approved = Confirmed (with an
overlap check), denied = Cancelled, any other stage = Tentative. Removing a line leaves its
bookings behind (orphans). Deleting the deal deletes them.

The deal save never checks that a unit belongs to the product, nor hours, limits or blocks.
A unit listed in two products with different calendars can be double-booked.

For prolibu-quotes, `checkSlot(client, {productId, itemStockId, start, timeZone, duration})` is
exported from `scripts/calendar.js`. Use it as a pre-check before adding a reserved line.

## Permissions

The "Calendar Manager" profile has every calendar object; "Pricing Manager" adds units.
The booking page, `scheduleEvent` and both availability calls are public by design: they
serve the customer-facing booking page. A 403 on setup means the key's user lacks the role:
say so and stop.
