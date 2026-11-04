---
name: prolibu-contracts
description: Follow a Prolibu contract from Draft to signed the way the app does it — list contracts, show who takes part, their roles, whose turn it is, the deadline and the audit trail, send a Draft for e-signature (the first send), remind the people who still have to sign, take a sent contract back to Draft, download the original or signed PDF, and explain what signing does to the deal. Use it whenever someone asks to send a contract for signature, who still has to sign, to remind a signer, to withdraw or cancel a sent contract, to download a signed contract, or reports signers who got the e-mail again, a link that says "draft", or a deal that moved to Approved by itself. Spanish triggers: "enviar a firma", "quién falta por firmar", "recuérdale que firme", "reenviar el contrato", "retirar el contrato", "anular el contrato", "descargar el contrato firmado", "estado del contrato".
---

# Prolibu Contracts

## Central idea

A contract is a Contract record with participants (`signers`, in signing order), each a
contact with a role, `signer` or `reviewer`. Its status runs `Draft` → `Ready` (sent) →
`Pending` (someone signed) → `Signed` or `Rejected`. The rule that hurts when ignored:
**every save of a `Ready` contract e-mails the signature request again**, so a sent contract
is never edited. Preparing the contract (template, participants, roles, options) belongs to
`prolibu-proposals`; this skill starts when the Draft is ready.

`scripts/contract.js` does the fragile parts in code: it computes exactly who gets an
e-mail, refuses to send unless the user's list matches it, reminds only people who still have
to sign (one by one, never "all"), writes nothing but the status, and never prints a signing
link or a file address. Your job is the conversation: agree with the user who receives what,
show the preview, and act only after a clear yes.

```
node .claude/skills/prolibu-contracts/scripts/contract.js <command> <domain> …
  list             <domain> [name] [--status <S>] [--deal <dealId>]
  status           <domain> <contractId> [--evidence]
  send-preview     <domain> <contractId>                      writes nothing; returns a version
  send             <domain> <contractId> --version <v> --recipients <a@x,b@y> --confirmed --reaches-people
  remind-preview   <domain> <contractId> [--signer <contactId>]
  remind           <domain> <contractId> [--signer <contactId>] --version <v> --recipients <…> --confirmed --reaches-people
  withdraw-preview <domain> <contractId>
  withdraw         <domain> <contractId> --version <v> --confirmed
  download         <domain> <contractId> [--original] [--out <folder outside the repo>]
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written).

## Ask the user first

In plain business terms:

1. **Which contract?** A name or the deal is enough; `list` finds the id.
2. **To send or remind:** the exact people and e-mails that will receive it. The preview
   gives the list; the user confirms it, and you pass it as `--recipients`.
3. **To withdraw:** that the signing links will stop working and nobody is told.
4. **To download:** the signed PDF or the original, and where to save it (default: a temp
   folder).

If `accounts/` has several domains, ask which one.

## Steps

1. **Find it.** `list <domain> "<name>"` (or `--deal <dealId>`, `--status Ready`). Several
   matches: list them and ask.
2. **Read it.** `status <domain> <contractId>`. Tell the user, in order, each participant, role
   and state, whose turn it is, the deadline, how many times the link was opened and the
   `dealEffect`. Add `--evidence` (IP and location of who signed) only if the user asks for it.
3. **Preview the action.**
   - First send: `send-preview`. It only works on a Draft generated from a deal.
   - Reminder: `remind-preview` (add `--signer <contactId>` for one person).
   - Back to Draft: `withdraw-preview`.

   Tell the user every `blockers` and `warnings` item in plain words. For a send, say who is
   e-mailed now, who later (one at a time), the deadline, whether they may reject, who the
   e-mail says requested it, and the `dealEffect`.
4. **Stop and wait for an explicit yes** to exactly that list of e-mails. End your turn with
   the preview, even when the request already said "send it". A yes to a send is not a yes to
   a reminder, nor the other way round.
5. **Act.** Run the command with the preview's `version`, `--recipients` equal to the
   preview's `recipients`, `--confirmed` and, for `send` and `remind`, `--reaches-people`. The
   script refuses when the contract or a participant's e-mail changed since the preview, or
   when the list differs: preview again and show the user.
6. **Report.** Who was e-mailed, the new status, and the deal effect. For a download, the
   local file paths.

## How the platform behaves

Details and evidence are in `references/contract-model.md`. Read it when a case falls
outside the steps.

- **Sending is saving the status `Ready`.** The server then e-mails every participant, or only
  the first one when they go one at a time (`sendEmailsInOrder`). The address is the contact's
  current e-mail, not the copy shown on the contract.
- **Every later save of a `Ready` contract re-sends the request** to the same people, whatever
  field changed. Only the status goes through this script; never edit a sent contract.
- **One at a time only picks who gets the e-mail.** The next person is e-mailed when the
  previous one signs. The platform does not stop a later person from signing first.
- **A reminder re-sends the same request** to one person. The platform would also re-send to
  people who already signed, to non-participants and on closed contracts; the script allows
  only pending participants, and only the current one when they go one at a time.
- **The deadline closes signing but not the contract.** After it, nobody can sign and the
  contract stays `Ready` or `Pending`. The script blocks sends and reminders past it.
- **Withdrawing (`Ready` → `Draft`) revokes the links:** they show only that it is a draft.
  Nobody is told. Sending again later e-mails everyone again. It is allowed only before anyone
  signed.
- **When everyone has signed, the deal moves to the system stage "Approved"**, even if the
  account's pipeline uses other stages, unless the contract has `skipDealApproval`. That move
  fires the deal's webhooks and stage rules. The `dealEffect` field says which case applies.
- **The e-mail says "requested by" the contract's creator** (for a contract generated from a
  deal, whoever generated it), not whoever presses send.
- **Download addresses expire after 15 minutes.** The script saves the PDFs straight to disk
  and never prints the address.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| Signers got the request again | Someone saved the `Ready` contract (any field) | Do not edit sent contracts; to change it, `withdraw`, fix with `prolibu-proposals`, send again |
| The link says the document is a draft | Sent with the list's "Send Contract" row action, which e-mails without moving to `Ready`, or it was withdrawn | `send-preview` / `send` |
| "You must add at least one signer / document to the contract" | Sending without participants or document | Fix the Draft with `prolibu-proposals` |
| Nobody can sign, the contract stays open | The deadline passed | Decide in the app; the platform has no expiry status |
| The deal jumped to "Approved" | Everyone signed and `skipDealApproval` is off | Expected; move it with `prolibu-stages` only if the user wants |
| A signer says it is not their turn but they could sign | One at a time is not enforced | Explain; nothing to fix here |

## Verify

- `send` and `withdraw` read the contract back and check the status (`Ready` / `Draft`).
- `remind` reports each person e-mailed; if one call fails it stops and says who already got it.
- `download` checks every file is a PDF and gives local paths.

## Don't

- Save, PATCH or re-create a `Ready` contract for anything but the intended send: every save
  e-mails the participants again. That includes the generic API helper. Do not offer it as
  an option either: the way to change a sent contract is withdraw, fix the Draft, send again.
- Edit participants or roles (`signers`, `signerEvidences`) on a sent contract: rewriting them
  on a `Pending` contract wipes signatures already given. Participants change only on a Draft,
  in `prolibu-proposals`.
- Set the status by hand to `Signed`, `Pending` or `Rejected`: it skips the signed document,
  the e-mails and the deal approval.
- Cancel a partially signed contract, delete a contract, or send a contract that was not
  generated from a deal (an uploaded PDF with signature positions): send the user to the app.
- Use resendEmail with "all", remind someone who already signed, or remind a contact who is
  not a participant.
- Print, share or build a signing link or a file address, or open the public signing pages
  and routes (sign, reject, view, code). Only the participant uses them.
- Show IP, location or signature data unless the user asked for `--evidence`.
- Send WhatsApp messages: the app's WhatsApp button only shares the link (see above).

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. The `*-preview` commands are the summary
step; `send`, `remind` and `withdraw` the writes, and the first two reach people. On a
production account say so in the summary. A `403` means the profile's user may not do this:
stop and say so. Templates, drafts and participants: `prolibu-proposals`. Deal stages:
`prolibu-stages`. Objects and how they relate: `prolibu-platform-map`.
