# Polls, questions and votes: how the platform behaves

Read this when a case falls outside the steps in `SKILL.md`.

## The three objects

| Object | Fields | Used by |
| --- | --- | --- |
| `Vote` (`/v2/vote`) | `voteCode`, `rating` (1–5, required), `voter` `{modelName: User\|Contact, docId}`, `candidate` `{modelName: User\|Contact, docId}`, `evaluation` `{modelName: Deal\|Ticket, docId}`, `voterName`, `candidateName`, `title` (filled by the server), `note` (≤ 300), `annulled` (default false), `ip` (required, set by the server) | The closing e-mail, the proposal viewer widget, the app's Votes list |
| `Poll` (`/v2/poll`) | `pollCode`, `pollName`, `questions` (Question ids), `expirationDate` | Nothing |
| `Question` (`/v2/question`) | `questionCode`, `prompt`, `options` `[{name, value}]`, `allowMultipleChoices` | Nothing |

`Poll` and `Question` are plain CRUD objects with no custom routes, no hooks and no answer
object: a `Vote` does not point to a poll or a question. The `expirationDate` of a poll is not
read anywhere. The app (V2) has no screen for either; only admins can list them. A record made
through the API would exist and do nothing, so the skill never creates them.

For a questionnaire with several questions, conditional pages, NPS 0–10 or free text, use a
web form in survey mode (`prolibu-forms`): it has a public page, stores submissions and can
create or update records.

## Where votes come from

### The closing e-mail

Deal and ticket saves call the survey hook after validation:

- **Deal**: account setting `modules.sales.deals.customerSatisfaction.sendSurveyOnEndStage`
  (default off) **and** `proposal.enabled` **and** the stage changed in this save **and** the
  deal has a stage and a contact **and** the new stage has `endFlowStage: true`. Voter = the
  deal's contact; candidate = `assignee`, else `createdBy`; evaluation = the deal.
- **Ticket**: `modules.support.tickets.customerSatisfaction.sendSurveyOnEndStage` (default
  off) **and** an `assignee` **and** the stage changed to an `endFlowStage`. Voter =
  `requester.contact`, else `requester.user`; candidate = the assignee.
- If a vote already exists for that voter, candidate and record, nothing is sent.
- The e-mail ("Rate Your Experience.") goes to the voter's e-mail with five faces; each face
  opens the survey page with `&rating=<n>`, which submits that rating at once, then offers
  the note.
- Any closing stage counts: won, lost, denied, closed, resolved. It cannot be narrowed to one
  stage. Errors in the hook are logged and do not block the save.

### The proposal viewer

`modules.sales.deals.agentRating.enabled` (default **on**, public setting) shows a rating
widget on the public proposal page. It uses the same public `status`, `submit` and `addNote`
routes with voter = the contact in the link, candidate = the agent, evaluation = the deal.
On a link shared without a contact, the viewer falls back to the deal's contact: whoever has
any proposal link of that deal can rate the agent in that contact's name (once).

### A signed-in user

`POST /v2/vote` is allowed to every user (it is in the basic permissions). The server forces
`voter` to the calling user and sets `ip`. The record and the candidate only need to exist; the
user does not need access to that deal or ticket.

## Routes

| Route | Session | What it does |
| --- | --- | --- |
| `GET /v2/vote/survey?voterModelName&voterDocId&candidateModelName&candidateDocId&evaluationModelName&evaluationDocId[&rating]` | none | The HTML survey page |
| `GET /v2/vote/status?<same six>` | none | `{voteId, rating, note}` of that vote, or nulls |
| `POST /v2/vote/submit` | none | Creates a vote; `ip` from the request; refuses `voterModelName: User` at the top level only |
| `PUT /v2/vote/addNote` `{voteId, note}` | none | Adds the note once; a second note is refused |
| `GET /v2/vote/report?candidateModelName&candidateDocId&evaluationModelName&type` | none | `votesCount`, `average`, `median` (`type` `*` for all) of non-annulled votes |
| `GET/POST/DELETE /v2/vote…` (CRUD) | key with Vote permissions | List, create as yourself, delete |

Routes with no security declaration run without authentication; this is how the survey page
works for customers who are not signed in.

## Rules that surprise

- **Uniqueness lives in code.** `afterValidate` looks for a vote with the same voter,
  candidate and record and throws `Vote already submitted.` There is no unique index, so two
  submissions at the same instant can both pass.
- **Votes cannot be updated.** Every save re-runs `afterValidate`, which finds the vote itself.
  So `PATCH /v2/vote/:id` always fails, `annulled` cannot be switched later, and the V2 list
  opens votes read-only. Removal (`DELETE`) is the only way out, and it lets the same voter
  vote again.
- **`annulled: true` sent at creation** produces a vote that the figures ignore.
- **5 stars** with a user as candidate sends the "five-star rating" notification to that user,
  with the agent's current average.
- **Unknown voter, candidate or record** answers 400 `'voter' no encontrado.` (or
  `candidate`/`evaluation`) and writes nothing.

## Results

- The app's figure is the per-agent report (V1 "View report" on the Votes list): one agent,
  one object (Deal or Ticket), all time, annulled excluded.
- `results` reads the votes once with a cursor on `_id` (500 per call, one call at a time,
  capped by `--max`, 2,000 by default, 10,000 at most), re-applies the filters in memory (the
  server drops filter fields it does not recognize), and computes the count, average, median,
  distribution and per-agent figures. Dates filter on the `_id` creation time.
- The median follows the server: the middle value, or the mean of the two middle values.

## Who can see and do what

| Who | Can |
| --- | --- |
| Anyone, no session | Open a survey page, vote once per voter/agent/record, add the note once, read any vote's rating and note by its six ids, read any agent's count, average and median |
| Every signed-in user | Rate someone as themselves (`POST /v2/vote`) |
| Admins, "Profile - Vote Features" | List, read and delete votes; list polls and questions (admins) |
| Sales agents (default) | No vote list (403); the per-agent report still answers |

## Exposure of the public link, and revocation

- The link carries three internal `_id`s and no secret, no expiry, no signature. Forwarding
  it, or guessing ids, is enough to vote in the customer's name once and to read that vote.
- The page sends no `X-Robots-Tag` and no `Referrer-Policy` header.
- Nothing revokes a sent link: it stops accepting votes only once a vote exists, or when the
  contact, agent or record is gone. The account switch only stops new e-mails.
- After fraud: list the record's votes (`results --record`), remove the bad ones with a yes,
  and tell the platform team; removing reopens the link for one more vote.
