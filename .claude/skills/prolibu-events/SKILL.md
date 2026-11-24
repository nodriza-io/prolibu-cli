---
name: prolibu-events
description: Run Prolibu's Event Manager the way the app does it — create business events (trade shows, fairs, congresses the company attends or hosts) with dates, venue and budget, register their expenses, count the contacts and deals that came out of each event through its campaign, read spend, won value and ROI, and promote candidate events ("event prospects") into real ones. Explains what each step triggers and what the totals really mean. Use it whenever someone wants to create or change a business event, log an event expense, attribute contacts to an event, asks how many contacts or deals an event brought, how much it cost or its ROI, or reports event totals that look wrong, an expense in dollars counted as pesos, or a deal that does not show under its event. Not for calendar events or meetings, nor hotel event fields on deals. Spanish triggers: "crea el evento", "evento de negocio", "gestor de eventos", "feria", "registra un gasto del evento", "cuánto gastamos en el evento", "ROI del evento", "contactos del evento", "qué negocios salieron del evento", "prospectos de eventos".
---

# Prolibu Events (Event Manager)

## Central idea

The Event Manager (menu *Ventas y Marketing › Gestor de Eventos*) has three objects:

| App name | Object | What it is |
| --- | --- | --- |
| Eventos de negocio | `BusinessEvent` | An event the company committed to: dates, venue, budget, stage (Planned, Confirmed, Completed, Cancelled) and server-computed totals. |
| Gastos de eventos | `EventExpense` | One expense of one event: concept, amount, currency, date, receipt. |
| Prospectos de eventos | `EventProspect` | A **candidate event** the company may attend (often loaded by a crawler), reviewed and then promoted. **Not a person.** |

Creating an event also creates **its own campaign** (an `AdCampaign` with the event name). That
campaign is the only link to people and sales: a **contact or deal counts for the event when
it carries the event's campaign**. Deals created from such a contact inherit it. The server
then keeps the event's totals: expenses, contacts, deals, won / lost / open value, net result
(won − spent), ROI and cost per contact or deal. Nobody is e-mailed by any of this.

So when a user says "prospectos del evento" or "asistentes", ask what they mean: **customers
met at the event** are contacts attributed to it; **team members going** are the event's
`attendees` (users, who get access to the event); **candidate events** are event prospects.

`scripts/events.js` does the fragile parts in code: duplicate checks, the attendees list that a
PATCH would replace, currency conversion checks, first-touch attribution, totals that lag, and
the read-back. Your job is the conversation: which event, what to write, show the preview, and
write only after a clear yes.

```
node .claude/skills/prolibu-events/scripts/events.js <command> <domain> …
  find      <domain> [text]               events by name, newest first
  show      <domain> <event id | BEV-code> budget, totals, expenses, staff capture link, checks
  results   <domain> <event id | BEV-code> attributed contacts and deals (won / lost / open)
  prospects <domain> [text]               candidate events
  stages    <domain>                      event and candidate-event stages
  preview   <domain> '<plan json>'        writes nothing; returns a version
  apply     <domain> '<plan json>' --version <v> --confirmed
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written).

## Ask the user first

1. **Which event?** A name is enough; `find` gives the code. Several matches: list and ask.
2. **For a new event:** name, start (and end) date **with the time zone**, venue/city, format
   (In-Person, Virtual, Hybrid), budget and its currency, who is responsible, which team
   members attend.
3. **For an expense:** concept, amount as a number (2 millones = `2000000`), currency, date,
   payment method if known. A receipt photo is added in the app or on the capture page.
4. **For "add these contacts":** their e-mails. Say that their **existing** deals stay out;
   only deals created from now on count.

If `accounts/` has several domains, ask which one.

## Steps

1. **Read.** `find <domain> "<name>"`, then `show <domain> <code>` (totals, expenses,
   `warnings`) or `results <domain> <code>` (which contacts and deals count, by bucket).
2. **Plan** (inline JSON in single quotes, or a temp file). One kind per plan:

   | `kind` | Fields |
   | --- | --- |
   | `createEvent` | `event: {eventName, dates:{startAt,endAt}, venue, address:{city,country(ISO-2)…}, format, eventType, description, website, currency, budget}`, `assignee` (`"me"` or e-mail), `attendees` (e-mails), `stage`, `allowDuplicate` |
   | `updateEvent` | `eventId`, `set: {…same fields…}`, `assignee`, `addAttendees`, `stage` (name or code) |
   | `addExpense` | `eventId`, `concept`, `amount`, `currency`, `expenseDate`, `paymentMethod` (Bank Transfer, Credit Card, Cash, Check, Other), `allowDuplicate` |
   | `attributeContacts` | `eventId`, `contacts` (e-mails or ids, up to 50), `moveFromOtherCampaigns` |
   | `promoteProspect` | `prospectId` (id or `EVP-…`) |
   | `recomputeMetrics` | `eventId` (managers only) |

   Dates: `2027-03-15T09:00:00-05:00` (always with the offset) or `2027-03-15`.
3. **Preview.** `preview <domain> '<plan>'`. Tell the user in plain words what will be
   written, every `warning`, and on `blockers` explain and stop. Never set `allowDuplicate` or
   `moveFromOtherCampaigns` on your own: only after the user says so to that exact warning.
4. **Wait for an explicit yes**, in a later message.
5. **Write.** `apply <domain> '<same plan>' --version <version> --confirmed`. It refuses when
   anything changed since the preview.
6. **Report.** The event code, what changed, the totals after (`totalExpenseAfter`,
   `eventContactsNow`) and every `problem`.

## How the platform behaves

Details and evidence are in `references/events-model.md`.

- **Totals are the server's.** Expenses are converted to the **account currency** when saved
  (rate of that moment) and summed; deal value is each quote's converted total. Totals are
  recalculated in the background after an expense, contact or deal changes, so a read right
  after a write may lag a second; `show` warns when the stored total differs from the sum.
- **Won and lost mean two stages only**: the standard *Approved* (won) and *Denied* (lost).
  A deal in any other stage, even a custom closing one ("Cancelado", "Firmado"), counts as
  **open**. `results` names those stages.
- **ROI** = (won value − total expense) / total expense × 100; empty when nothing was spent.
- **Attribution is first-touch.** A contact keeps the first campaign it came with. Moving it
  to this event takes it out of the other campaign's numbers, and the other event's totals are
  not recalculated (`staleEvents`; a manager can run `recomputeMetrics`).
- **Existing deals do not follow** a contact attributed later; only new deals inherit it.
- **Currency conversion can fail silently**: the server then counts the amount 1:1. The script
  catches it and says so.
- **Budget vs. currency.** The budget is a plain number in the event currency; totals are in
  the account currency. Different currencies make "% of budget" meaningless; the script warns.
- **Attendees are users, and get access.** Adding one also makes them a collaborator of the
  event and of its future expenses. Removing an attendee in the app keeps that access.
- **Promoting a candidate event** = moving it to *Promoted*, like dragging the card. The
  server creates the business event once (name, dates, venue, address, website, type, tags and
  attendees copied; budget not). A second promotion returns the same event.
- **Deleting an event deletes all its expenses** (receipts too) and keeps the campaign,
  contacts and deals. The script never deletes; send the user to the app, with their own yes.

## Who may do what

- **Event Business Assistant** profile: only events, prospects and expenses they created, are
  assigned or attend; may capture contacts. **Event Business Manager**: every event, prospect
  and expense, plus `recomputeMetrics` and the promote action. Admins: everything. Others
  (a Sales Agent) get `403` on the whole module: say so and stop.
- Expenses inherit who can see them from the event **when created**; later team changes do
  not reach older expenses.
- The key acts as its user: the script never widens access, and never takes ids for users.

## The staff capture page

`show` returns `https://<domain>/event?event=<id>`: a page for the team to log contacts and
expenses (with a receipt photo) from a phone during the event. It **asks for sign-in**; it is
not a public registration page, and the module has none. Contacts captured there get the
event's campaign, the capturer as owner and the *Outbound* direction. Never put an `apiKey`
in that link: the page accepts one in the URL and anyone with the link would act as that user.
If such a link leaked, revoke that key (avatar menu › Security › API Keys).

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| A won deal does not add to "valor ganado" | Its stage is not the standard *Approved* | `results`; move it with `prolibu-stages` if it is really won |
| A deal of an event contact is missing | It existed before the contact was attributed, or has another campaign | `results`; set its campaign in the app if it belongs |
| An expense in USD counted as pesos | Currency conversion failed (rate 1) | `show` lists it; fix the amount in the app |
| Totals did not move after a change | Background recalculation lags | `show` again; a manager can `recomputeMetrics` |
| An event shows no contacts at all | No campaign (account preference off) | Admin sets one in the app |
| `403` on every event call | The user lacks an Event Manager profile | Ask an admin for the profile |

## Not this skill

Meetings, calendar events and room or resource bookings: `prolibu-activities` and
`prolibu-calendars`. Hotel or venue "event" deals (event types and days on a deal's quote):
`prolibu-quotes` and `prolibu-custom-fields`. Creating new contacts: `prolibu-leads`.
Stage moves in general: `prolibu-stages`.

## Don't

- Write with hand-made calls: use the script.
- Treat "prospectos del evento" as event prospects without asking: usually they are contacts.
- Report `attendees` as customers who attended, or "contacts attributed" as people who came:
  the platform does not record physical attendance.
- Set `adCampaign` on an event, or reuse another campaign: every contact and deal already on
  it would count for the event.
- Put an `apiKey` in a link, delete events or expenses, or retry a `403` another way.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step and `apply`
the write. For how objects relate, see `prolibu-platform-map`.
