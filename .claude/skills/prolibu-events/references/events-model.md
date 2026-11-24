# Event Manager: model and behavior

Read this when a case falls outside the steps of `SKILL.md`. Everything here was checked in
the platform's code; the private verification report keeps the evidence.

## Objects and fields

### BusinessEvent (`/v2/businessevent`, code `BEV-…`)

| Field | Notes |
| --- | --- |
| `eventName` | Required. Searchable. |
| `description`, `eventType`, `venue`, `website` | Text. `eventType` is free text ("trade-show"). |
| `format` | `In-Person`, `Virtual` or `Hybrid`. |
| `dates.startAt`, `dates.endAt` | Dates with time. No due date or reminder. |
| `address` | `street`, `city`, `state`, `country` (ISO-2), `postalCode`, `neighborhood`. |
| `currency` | Defaults to the account currency. Only describes the budget. |
| `budget` | Number ≥ 0, planned spend. |
| `adCampaign` | Set by the server on create (one campaign per event). Do not set it. |
| `stage` | Planned (default), Confirmed, Completed, Cancelled. Moving it has no side effect. |
| `assignee`, `attendees`, `collaborators`, `tags`, `notes`, `tasks`, `attachments` | Usual platform fields. `attendees` are users and are copied into `collaborators`. |
| `metrics.*` | Read-only, computed by the server (below). A write to them is dropped. |

### EventExpense (`/v2/eventexpense`, code `EXP-…`)

| Field | Notes |
| --- | --- |
| `businessEvent` | Required. The event. |
| `concept` | Required. |
| `amount` | Required, ≥ 0, in `currency`. |
| `currency` | Defaults to the account currency. |
| `exchangeRate`, `convertedAmount` | Read-only. Rate to the account currency at save time; `convertedAmount` is what the totals sum. When the conversion fails the rate is 1 and nothing is reported. |
| `expenseDate` | Defaults to the creation date. |
| `paymentMethod` | `Bank Transfer`, `Credit Card`, `Cash`, `Check`, `Other`. |
| `receipts`, `notes`, `tags` | Receipt files, notes; tags work as categories (Travel, Venue…). |
| `collaborators` | On create, the event's creator, assignee and collaborators are added, so whoever sees the event sees the expense. Not updated later. |

### EventProspect (`/v2/eventprospect`, code `EVP-…`)

A candidate event, not a person. Fields like the event's (name, description, format, dates,
venue, address, website, eventType) plus `industries`, `price.admission` and `price.airfare`
(cost to attend), `score` (0–100), `source` (for example `EventCrawler:<site>`), and
`businessEvent` + `promotedAt` (set on promotion, read-only). It is created with **no
stage**; people move it to Reviewing, Promoted or Dismissed. Integrations load candidates
by find-or-create on `prospectCode` (unique).

## How the totals are computed

On every expense create, update or delete, and every contact or deal create or update that
carries a campaign, the server recalculates the events that own that campaign, in the
background:

- `totalExpense` = sum of the event's expenses' `convertedAmount`.
- Deals with the event's campaign (same workspace as the event) are grouped by stage: the
  standard **Approved** stage → won, the standard **Denied** stage → lost, anything else →
  open. Values are each deal's `proposal.quote.convertedTotal`.
  `pipelineValue` = won + lost + open; `wonDealsCount`; `deals` = their ids.
- `contacts` = ids of contacts with the event's campaign (same workspace).
- `netResult` = won − totalExpense; `roi` = netResult / totalExpense × 100 (empty when
  nothing was spent); `costPerContact`, `costPerDeal` (empty when there are none).
- `metricsCurrency` = the account currency; `computedAt` = when.

A contact moved from one campaign to another recalculates only the **new** event; a deal
moved recalculates both. Managers can force a recalculation with
`POST /v2/businessevent/recomputeMetrics {"eventId": "<id>"}` (the script's
`recomputeMetrics` plan).

The ids lists include records the reader may not be allowed to open; `results` reads them
with the reader's permissions and says how many it could not see.

## Attribution

- A contact counts for the event when its `adCampaign` is the event's campaign. It can come
  from the staff capture page, a contact form or import that sets that campaign, or a manual
  change (the script's `attributeContacts`).
- A deal created **for** such a contact inherits the campaign on create. Deals that already
  existed keep theirs.
- The contact's campaign is first-touch: later form submissions from other campaigns do not
  change it.
- Changing only a contact's campaign notifies nobody. Creating a new contact (capture page,
  forms) follows the account's contact notification settings.

## Who may do what (system profiles)

| Profile | Can |
| --- | --- |
| Event Business Assistant | Create, read, edit, delete their own events, prospects and expenses (creator, assignee, attendee or collaborator); create and find contacts; notes; campaigns; pick users. |
| Event Business Manager | All of the above on **every** record of the module, plus `recomputeMetrics`, the promote action, contacts in full, and reading deals for the ROI drill-down. |
| Admin | Everything. |
| Anyone else | `403` on the module. |

## Entry points

- The app: *Ventas y Marketing › Gestor de Eventos* (tables, kanban boards, the event
  dashboard with KPIs, attributed deals and contacts, expenses ledger and "Register expense").
- The staff capture page `https://<domain>/event?event=<id>`: sign-in required; logs
  contacts (with the event's campaign, the capturer as owner, Outbound, a note) and expenses
  (with a receipt photo). It also accepts `?apiKey=` in the URL and stores it in the browser:
  never build or share such a link. There is no public registration page for attendees.
- The API, with the calls above, and `POST /v2/eventprospect/promote {"prospectId"}`
  (managers) — the script promotes by the stage move instead, which every profile with edit
  access can do and which the app uses.

## Undo

| Change | Undo |
| --- | --- |
| Event created by mistake | Delete it in the app: its expenses go with it; its campaign, contacts and deals stay. |
| Expense wrong | Edit or delete it in the app; totals recalculate. |
| Contact attributed by mistake | Set its campaign back in the app (the preview listed the previous one). |
| Prospect promoted by mistake | The event exists; delete it in the app. Deleting the prospect does not delete the event. |
