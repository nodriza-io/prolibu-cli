# Scoring model and engine behavior

Verified against the platform's code and live calls on a test account. Read it when a case
falls outside the steps in `SKILL.md`.

## Records

### `scoring` (REST `/v2/scoring`, path key = `_id` or `scoringCode`)

| Field | Notes |
| --- | --- |
| `scoringName` | Required. |
| `scoringCode` | Defaults to `SCR-<number>`; can be set on create. |
| `entity` | `Contact` (default) or `Deal`. The server only accepts entities listed in the account setting `modules.system.scoring.entities`, and it may list other models, but only Contact and Deal have score fields: a profile for anything else never scores. |
| `type` | `rules` (default), `ai`, `hybrid`. The AI layer does not run today: every type scores by its rules. |
| `criteria[]` | `{key, label, category, when, points}`. `when` is json-logic; missing = always met. `category` only groups the breakdown. The breakdown shows `label`, else `key`, else `category`. |
| `bands[]` | `{key, label, min, max, color}`; inclusive range. The record stores `key`, else `label`. No bands = empty band. |
| `normalization` | `{mode: "sumCapped"}` (default: sum, rounded, capped to 0–100) or `{mode: "maxPoints", maxPoints: N}` (round(sum / N × 100), capped). Scores are always integers. |
| `active` | One active profile per entity and scope, enforced after each save. |
| `workspace` | Empty = whole account. On create, the server fills it with the creator's primary workspace when the body has none, and `null` is treated as none. |
| `ai.*` | Skill, credential, weight, combine strategy. Not used by this skill. |

### Score fields on Contact and Deal

None can be written through the API.

| Field | Content |
| --- | --- |
| `score` | Integer 0–100. Visible, sortable, filterable. |
| `scoreBand` | Band key or label, or empty. |
| `scoreDetail` (hidden: ask for it in `select`) | `source`, `breakdown[] {criterion, category, points}` (met criteria only), `rules {value, band}`, `scoring` (profile id used), `modelVersion` (its code), `computedAt`, `history[]` (last 20 changes). |
| `signals` (hidden) | Engagement counters: `emailsSent, emailOpens, emailClicks, emailReplies, presentationViews, callsConnected, meetingsCompleted, tasksOpen, lastActivityAt, refreshedAt`; Contact also `openDeals, openDealValue`; Deal also `interactions, calendarEvents`. Written only by a re-score. |

Anyone who can read the record can read its score fields. Profiles, `preview` and
`recompute` need the Scoring permission, which only admins have by default. Sellers get a 403
on them.

## What a criterion can read

The engine builds a context from the record:

- Every field of the record, with ids and dates turned into text, down to 4 levels deep.
  `score`, `scoreBand` and `scoreDetail` are removed.
- **Links are ids, never expanded.** `contact`, `company`, `assignee` hold an id;
  `company.name` is always empty.
- `stage` is replaced by `{stageCode, stageName, index, percentage, endFlowStage}`.
- `signals` as stored. Their dates stay date objects: comparing them with a text date is
  always false. Comparing with a number of days works through `daysSinceLastActivity`.
- Added values: `modelName`, `hasCompany`, `daysSinceCreated`, `daysSinceLastActivity`
  (empty when there is no activity). Deal: `quoteTotal` (converted total, else total),
  `hasQuote`, `proposalViews`, `interactions`. Contact: `hasOpenDeal`, `openDealValue`,
  `firstContactHeat`.

## json-logic cookbook

| Rule in words | `when` |
| --- | --- |
| Has a job title | `{"!!": [{"var": "jobTitle"}]}` |
| Source is one of… | `{"in": [{"var": "source"}, ["Referido", "Sitio Web"]]}` |
| Quote above 10 million | `{">": [{"var": "quoteTotal"}, 10000000]}` |
| Proposal seen 3+ times | `{">=": [{"var": "proposalViews"}, 3]}` |
| No activity in 30 days | `{">": [{"var": "daysSinceLastActivity"}, 30]}` |
| In stage X | `{"==": [{"var": "stage.stageCode"}, "<stage code>"]}` |
| Stage at 50%+ | `{">=": [{"var": "stage.percentage"}, 50]}` |
| Quotes product SKU-1 | `{"some": [{"var": "proposal.quote.lineItems"}, {"==": [{"var": "productCode"}, "SKU-1"]}]}` |
| A line with discount above 10% | `{"some": [{"var": "proposal.quote.lineItems"}, {">": [{"var": "discountRate"}, 0.1]}]}` |
| Both | `{"and": [<rule>, <rule>]}` |

Inside `some` / `all` / `none` the data is each list item: a record field there (say
`quoteTotal`) reads nothing. Combine with `and` outside the `some` instead.

Operators the engine knows: `== === != !== > >= < <= ! !! % in cat substr + - * / min max
merge var missing missing_some if ?: and or all none some filter map reduce log`. Any other
throws inside the engine, and the criterion silently counts as not met.

## When scores change

- **On every save of the record** (create or update, any field), with the profile that applies
  at that moment. Nothing else re-scores. A record with no save since a profile applied keeps
  no score or its old one.
- **Which profile applies:** the active one of the record's workspace; else the active one for
  the whole account. Among several actives (older accounts), the most recently updated wins.
  A profile change can take up to a minute to apply on every server.
- **A broken profile never blocks a save:** errors are swallowed and the record is not scored.
- **Turning scoring off, deactivating or deleting a profile** clears nothing: old scores stay.

## Activation

Saving a profile with `active: true` sets `active: false` on every other profile with the
same entity and the same scope (workspace, or whole account). No notice, no event. The app's
create form starts with `active: true`, so creating from the app switches off the current
profile at once. The script always creates inactive.

## Re-score (`POST /v2/scoring/recompute`)

The script sends `{entity, query: {_id: {$in: [ids]}}}` built from the user's ids only. For
each record, the server refreshes `signals` and saves it through the normal update. Each save
recomputes the score and also:

- fires `<Entity>.update` (and `<Entity>.*`) webhooks once per record;
- runs AI agent triggers on update;
- Deal: refreshes the proposal for anyone viewing it, and may create a proposal version;
- Contact: the change notifications any edit of the contact sends.

Deals in a closed stage refuse the save and are counted in `failed`. The call runs inside the
request: keep lists short. `GET /v2/scoring/preview?scoringId=&recordId=` computes the same
score with fresh counters and saves nothing. It works on inactive profiles, which is what `try`
and `explain` use.

## Account settings (read only for this skill)

`modules.system.scoring`: `enabled` (default off), `entities` (default `["Contact"]`),
`recompute.onActivity`, `recompute.periodicity` (cron text; empty = no scheduled re-score).
`defaultScoring` is deprecated. Changing these is an admin task in the account settings. A
new periodicity applies only after the platform restarts.
