---
name: prolibu-proposals
description: Prepare a Prolibu deal's proposal and its contract the way the app does it — turn the proposal on with a title and a layout template, give the preview of the document, save and restore proposal versions, create contract templates, generate the deal's contract from a template with its participants and roles, and leave it as a Draft ready for e-signature, without ever sending it. Use it whenever someone wants to set up or change a deal's proposal or its template, save or go back to a version, write a contract template, generate a contract from a deal, or add signers or reviewers; or reports a contract with empty or raw variables, a missing template, versions that vanished, or "the deal already has a contract". It adapts to both proposal models: the proposal inside the deal, and accounts where a deal has several proposals with status (Draft, Ready, Approved, Denied) and automatic versions. Spanish triggers: "propuesta del negocio", "varias propuestas", "estado de la propuesta", "marcar lista", "borrador", "plantilla de la propuesta", "guardar versión", "restaurar versión", "plantilla de contrato", "generar contrato", "firmantes", "firma electrónica".
---

# Prolibu Proposals

## Central idea

A deal's proposal lives inside the deal (`proposal`): on or off, a `title`, a layout template
(a ContentTemplate of type `layout`) and the quote. The proposal viewer renders the document
from that data; the PDF is printed from the viewer. Versions are saved copies of `proposal`.
A contract is a Contract record: a **template** (`isContractTemplate`) or a contract generated
from a deal, with participants (`signers`) and their roles. The rule that hurts when ignored:
**a contract in `Ready` e-mails its participants on every save.** This skill only prepares
contracts as `Draft`; a person sends them from the app.

## Two proposal models: detect first

Accounts run one of two models. **Always start with**
`node .claude/skills/prolibu-proposals/scripts/proposal.js model <domain>`:

- `"deal"`: the proposal lives inside the deal (one per deal). Everything below applies.
- `"records"`: proposals are their own records, several per deal, each with a status and
  automatic read-only versions. Use `scripts/proposal-records.js` and follow
  [Proposals as records](#proposals-as-records); contracts still use `proposal.js`.

Each script stops (exit 3, nothing written) on the wrong model, so a wrong guess costs nothing.

`scripts/proposal.js` does the fragile parts in code: it never resends `enabled` (that moves
the deal's stage), never sends the template's HTML, versions the stored proposal, backs up
before a restore, forces `Draft` on every contract, refuses to touch a contract that is not a
`Draft`, and reads every write back. Your job is the conversation: agree what to change with
the user, show the preview, and write only after a clear yes.

```
node .claude/skills/prolibu-proposals/scripts/proposal.js <command> <domain> …
  deals              <domain> <part of the deal name>
  show               <domain> <dealId>          proposal, template, versions, contracts, preview link
  layouts            <domain> [term]            layout templates and the user's default
  contract-templates <domain> [term]            contract templates with their variables
  contract           <domain> <contractId>      participants, roles, options, empty fields
  preview            <domain> '<plan json>'     writes nothing; returns a version
  apply              <domain> '<plan json>' --version <v> --confirmed
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written). Quote lines (products, prices, discounts) belong to `prolibu-quotes`.

## Ask the user first

In plain business terms:

1. **Which deal?** A name is enough.
2. **Proposal:** title (default: the deal name) and which template (default: the account's
   default layout; `layouts` lists them).
3. **Version:** a name for it, or which saved version to go back to.
4. **Contract:** which contract template (or only the proposal as the document), which proposal
   pages to attach (default: all), and who takes part: each person is a contact with an e-mail,
   in order, as `signer` or `reviewer`. Options: one at a time (`sendEmailsInOrder`), a code by
   e-mail before signing (`emailCode`), a deadline (`deadlineDate`), whether they may reject
   (`allowReject`), skip asking for location (`skipLocation`).

If `accounts/` has several domains, ask which one.

## Steps

1. **Find the deal.** `deals <domain> "<name>"`, then `show <domain> <dealId>`. Note the
   proposal, the versions (`id`, `name`), the contracts and any `blockers`. A blocker means stop
   and explain it.
2. **Plan.** One action per plan, inline in single quotes (a JSON file in a temp folder works):

   | Action | Plan |
   | --- | --- |
   | Turn on, title, template, expiry | `{"action":"proposal","dealId":"…","enabled":true,"title":"…","layoutId":"…","expirationDate":"2026-12-31"}` |
   | Turn off | `{"action":"proposal","dealId":"…","enabled":false}` |
   | Save a version | `{"action":"saveVersion","dealId":"…","name":"Before the discount"}` |
   | Go back to a version | `{"action":"restoreVersion","dealId":"…","versionId":"…"}` (`"backup":false` skips the safety copy) |
   | New contract template | `{"action":"contractTemplate","name":"…","html":"<p>…[[full_name]]…⟦sig:1⟧</p>"}` |
   | Generate the contract | `{"action":"generateContract","dealId":"…","templateId":"…","signers":[{"contactId":"…","role":"signer"}],"pages":[0,1],"name":"…","options":{"sendEmailsInOrder":true}}` |
   | Change a Draft contract | `{"action":"updateContract","contractId":"…","name":"…","signers":[…],"options":{…}}` |

   - Every field is optional except the ids and the names shown. `signers` defaults to the
     deal's contact; `attachProposal` defaults to true (without it a template is required);
     `pages` counts from 0.
   - For template bodies and variables, read `references/proposal-model.md` first.
3. **Preview.** Run `preview`. Tell the user in plain words what changes, every `warning`, and
   for a contract: the document it will contain, each participant and role, and the template's
   fields.
4. **Stop and wait for an explicit yes.** End your turn with the preview and the question, even
   when the request already names every change: the yes must come after the user has seen the
   preview. With several plans, preview them all, then ask once. A restore and a change to an
   existing contract need their own yes.
5. **Write.** `apply <domain> '<same plan>' --version <version> --confirmed`. It refuses when
   the deal or contract changed since the preview (preview again) or a blocker appeared.
6. **Report.**
   - Proposal: what was saved, and the `previewUrl`: the user opens it while signed in to check
     the document and prints or downloads the PDF from there.
   - Version: its name, hidden from the client.
   - Contract: its name, `Draft`, the participants and roles, and the `variables` report:
     `empty` fields had no data on the deal or contact, `unknown` names do not exist and were
     dropped from the document. Then say how to send it (below).

**Sending is not done here.** To send the Draft for signature, remind signers or follow who
signed, use `prolibu-contracts` (its own preview and yes). Never give the user a signing link
to forward, and never share the proposal link with a client: the app's Share button makes the
tracked link.

## Proposals as records

Only when `model` says `"records"`. The deal holds a list of proposals; one is the principal
(its amount is the deal's). Read `references/proposal-records.md` before the first write.

```
node .claude/skills/prolibu-proposals/scripts/proposal-records.js <command> <domain> …
  deals    <domain> <part of the deal name>
  show     <domain> <dealId>                  proposals in order: status, principal, visible, versions
  versions <domain> <proposalId>              its versions, oldest first
  compare  <domain> <proposalId> <versionId>  what a restore would change
  preview  <domain> '<plan json>'             writes nothing; returns a version
  apply    <domain> '<plan json>' --version <v> --confirmed
```

| Action | Plan |
| --- | --- |
| New proposal on the deal | `{"action":"create","dealId":"…","title":"…","layoutId":"…","expirationDate":"2026-12-31","status":"Draft"}` |
| Title, template, expiry | `{"action":"edit","proposalId":"…","title":"…","layoutId":"…","expirationDate":"…"}` |
| Mark ready / back to draft | `{"action":"status","proposalId":"…","status":"Ready"}` |
| Go back to a version | `{"action":"restoreVersion","proposalId":"…","versionId":"…"}` |

Same flow as above: `show`, plan, `preview`, stop for an explicit yes, `apply`, report with
the `previewUrl`. What changes in this model:

- **Versions are automatic and read-only.** The account saves one when a proposal is born and
  after every content change, only if automatic versions are on (`show` → `settings.autoVersions`;
  off by default). Nobody can save one by hand: when they are off, say so; never promise history.
- **Restoring keeps no copy of the current content.** Run `compare` and show the changes first.
  Status, visibility and the deal stay as they are; the quote is not recalculated.
- **Only `Draft` and `Ready` are written.** `Approved` and `Denied` follow the deal's stage.
  Ready sends nothing and does not move the deal.
- **Never approve or deny here.** Denying any proposal denies the whole deal; approving moves it.
  Both are done in the app. Publishing to the client (`visibleToClient`), choosing the principal,
  reordering, cloning and deleting (it deletes the versions too) are in the app as well.
- **Quote lines are `prolibu-quotes`.** A new proposal is born without lines.
- A deal in an end-of-flow stage blocks every change unless the account allows edits there.

## How the platform behaves

Details, variables and edge cases are in `references/proposal-model.md`.

- **A proposal needs a contact and a title.** Turning it on without them answers 400. The
  platform also fills expiry dates from the account settings and, without a template, applies
  the user's default layout.
- **Sending `enabled: true` again moves the deal** to the account's default proposal stage, if
  one is set, on every save. The script sends it only when turning the proposal on.
- **The template is a layout ContentTemplate.** The server copies its HTML into the deal when
  the id arrives alone; sending any HTML with it stops that copy. Any ContentTemplate id is
  accepted, even a snippet: the script checks the type.
- **A title with `{{ }}` is filled once** with the deal's data and saved filled in.
- **Versions are snapshots.** Some accounts also save an automatic hidden version on every
  proposal save. A version is hidden from the client unless someone publishes it in the app.
  Restoring replaces the whole proposal (title, template, quote) and creates no copy of the
  current one: the script saves a backup first.
- **One active contract per deal.** Generating again while a contract that is not `Rejected`
  exists returns the old one. The script blocks before that.
- **The contract text is filled in at generation** with the deal, contact, company and the
  deal's assignee, and saved filled in. Missing `[[fields]]` print empty; unknown ones vanish.
- **Contracts are created `Ready` by default**, and `Ready` e-mails the participants on create
  and on every later save. The script always sends `Draft` and never edits a non-Draft contract.
- **Roles are `signer` or `reviewer`.** At least one signer. Each needs an e-mail.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Proposal title is required." / "Contact is required for proposal." | Turning on without them | Add the contact to the deal; give a title |
| The deal jumped to another stage after a save | `enabled: true` was sent again and the account has a default proposal stage | Use the script; move it back with `prolibu-stages` |
| The template changed but the document did not | Old HTML was sent with the layout id | Change it with the script (id only) |
| `[[field]]` printed empty in the contract | No data on the deal or contact | Fill the data; the contract keeps its text: edit it in the app, or delete the Draft in the app and generate again |
| A `{{ }}` block shows as raw text | A link inside `{{ }}` (the editor's autolink) or a syntax error | Rewrite the block as plain text in the template |
| "The deal already has the contract…" | One active contract per deal | Work on that contract; to replace a Draft, delete it in the app and generate again |
| Participants got the e-mail again | A save on a `Ready` contract | Change Ready contracts only in the app, once, on purpose |
| Versions disappeared | Someone saved `proposalVersions.details` partially | Never write `details` by hand |
| Which design a proposal uses, or a design must change | Designs are ContentTemplates | `prolibu-document-design` (duplicate before editing) |

## Verify

- `apply` reads every write back: the proposal's state, title and template; the new version
  in the deal's list; the restored title and template; the contract's status `Draft`, its
  documents, participants and roles.
- Give the user the ids, the `previewUrl` for proposals, and the `variables` report for a
  contract.

## Don't

- Move a contract to `Ready`, resend its e-mail, or call the sign, reject, code or
  `generate` endpoints (`generate` without `status` creates it `Ready`) here: sending and
  reminders are `prolibu-contracts`.
- Share the proposal link, publish a version to the client, or e-mail anything.
- Edit an existing contract template or layout through the API: templates are edited in the
  app's editors. This skill creates new contract templates only.
- Write `proposal` or `proposalVersions` with the generic helper, or send `layoutHtml`.
- Use the AI assistant's `createProposal`/`updateProposal` for quotes, or its `previewUrl`
  (it carries the client's contact id and counts as a client view).

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step and `apply`
the write. Quote lines: `prolibu-quotes`. Stages: `prolibu-stages`. Objects and how they
relate: `prolibu-platform-map`.
