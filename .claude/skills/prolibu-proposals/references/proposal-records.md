# Proposals as records (the "records" model)

Only some accounts run this model. `scripts/proposal.js model <domain>` tells which: an account
without the Proposal model answers 404 to `GET /v2/proposal` (checked on a deal-model account
with the admin and the seller keys, 3 nov 2026).

## The objects

- **Deal** — `proposals` (ids, in order), `principalProposal` (whose amount is the deal's).
  `deal.proposal` is only a summary of the principal that the server writes; never write it.
- **Proposal** (`/v2/proposal`) — `title` (required), `deal` (set on create, never changes),
  `status`, `visibleToClient`, `quote`, `template.layout`, `attachments`, `expirationDate`,
  `unpublishedDate`. Access is the deal's: whoever can edit the deal can create and edit its
  proposals; the server checks it, not this script.
- **ProposalVersion** (`/v2/proposalversion`) — read-only snapshot of one proposal's content
  (`proposalData`, `sha256`, `proposal`, `dealSource`). Content = title, quote, template,
  attachments, dates. Status, visibility and access are not content.

## Status

`Draft` and `Ready` are the advisor's, while the deal is open. A new proposal takes the
status of the create, or the account's `stageRules.defaultProposalStatus` (Draft by default).
`Approved` and `Denied` follow the deal's stage: deal approved → its principal Approved, the
others Denied; deal denied → all Denied; deal reopened → all Ready. Writing `Approved` or
`Denied` through the API answers 400 "Document key protected".

## Approving and denying (never from this skill)

The app approves through the deal (`PUT /v2/deal/approveProposal` for a signed-in user,
`PUT /v2/deal/approve` for the client's viewer, a public route). `approved:false` **denies the
whole deal**: there is no rejection of one proposal. A deal in an end-of-flow stage can be
neither approved nor denied.

## Versions

- Created only when `proposalVersioning.autoGenerate` is on (off by default): one at birth,
  then one after every edit whose content changed. Restores and system writes create none.
- There is no manual "save version": the old `createRestorationPoint` now answers 400.
- Restore = `PATCH /v2/proposal/{id}` with `restorationPoint: <versionId>`. Only a version of
  the same proposal. It copies the whole content (missing fields go empty), does not recalculate
  the quote, brings expired dates back expired, and keeps status, visibility and the deal.
- Deleting a proposal deletes its versions (and reservations and exceptions).

## Conflicts

- **409 `staleQuote`** (accounts with commercial exceptions): an edit carrying a quote whose
  exception pointer is stale. This skill never sends the quote; if `prolibu-quotes` gets it,
  read the proposal again, re-apply the line changes on the fresh quote and retry.
- An internal version conflict is retried by the server; if it ever reaches the client, read
  again and retry once.

## Links

`previewUrl` = `/ui/spa/view/deal/<deal>/<contact|none>?proposal=<id>&source=versionHistory`:
the user's own preview, also of a hidden proposal. Never send it to a client; the client link
comes from the app's Share button.

## Not covered yet

Cloning a proposal, choosing the principal, reordering, publishing, deleting, and editing
quote lines on a proposal record. `prolibu-quotes` still writes the deal-model quote.
