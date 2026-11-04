# Contract model and server behavior

What `scripts/contract.js` relies on, verified against the platform's code and a test
account. Read it when a case falls outside the steps of `SKILL.md`.

## Fields

| Field | Meaning |
| --- | --- |
| `status` | `Draft`, `Ready`, `Pending`, `Signed`, `Rejected`. The default is `Ready`: a contract created without a status is sent at once. |
| `signers` | Contact ids in signing order. |
| `signerEvidences` | Per contact id: `fullName`, `email` (a copy), `role` (`signer`/`reviewer`), `status` (`Pending`/`Signed`/`Rejected`), and after acting the date, IP, location, signature image and request headers. |
| `options.sendEmailsInOrder` | One at a time: only the first participant is e-mailed at send; each next one when the previous signs. |
| `options.verification.emailCode` | The participant gets a code by e-mail before signing. |
| `options.deadlineDate` | After it, signing is refused. Nothing else changes. |
| `options.reject.allow` | The participant may reject with a reason (10–250 characters). |
| `skipDealApproval` | When true, signing does not move the deal. |
| `contractDocuments` / `signedDocuments` | The PDFs to sign / the final PDFs with the audit page. |
| `origin` | `{modelName, docId}`: where it was generated from (usually a `Deal`). |
| `tracking` | Views of the signing page. |

Templates are Contract records with `isContractTemplate: true`; lists must exclude them
(`xquery={"isContractTemplate":{"$ne":true}}`; `isContractTemplate=false` as a query parameter
matches nothing because it compares text).

## Send (`Draft` → `Ready`)

- The app's "Save and Send" saves the form with `status: "Ready"`. The script sends only
  `PATCH /v2/contract/<id>` with `{"status":"Ready"}`.
- On that change the server requires at least one participant and one document. Then, for any
  save that leaves the contract `Ready` with participants and documents, it e-mails the
  request: to every contact in `signers`, or only to the first with `sendEmailsInOrder`. Saves
  that only touch bookkeeping (views, the deadline reminder mark, assets) do not re-send.
- The address is the contact's `email` at that moment; the copy in `signerEvidences` is not
  used. The e-mail's "requested by" is the contract's `createdBy` user.
- The server does not check the deadline, the signature positions, or that someone has the
  `signer` role. The script blocks an expired deadline and an all-reviewer contract, and only
  sends contracts generated from a deal (uploaded PDFs need signature positions set in the
  app).
- The list's "Send Contract" row action e-mails everyone without moving the contract to
  `Ready`: the participants get a link that only says "draft". Do not use it as a recipe.

## Remind

`POST /v2/contract/resendEmail/<contractId>/<contactId>/single` e-mails the request to that
contact. The server checks neither that the contact is a participant nor the contract's
status. Mode `all` e-mails every participant, including those who already signed, in any
status. The script calls only `single`, once per pending participant, and with
`sendEmailsInOrder` only the current one: the first `Pending` entry of `signerEvidences`, in
the order its keys were saved (the platform's own rule for "next").

There is no automatic reminder to participants. The only automatic message is internal: about
24 hours before the deadline, the users of the record get a notice (once per date).

## Signing (done by the participant, never by this skill)

- Signing is refused on `Draft`, `Signed`, `Rejected` and after the deadline. The turn is not
  enforced with `sendEmailsInOrder`; reviewers and signers sign the same way.
- After each signature: status `Pending`, the next person is e-mailed (one at a time), every
  participant and the owner get a "signed" e-mail, and the record's users get a notification.
- When everyone has signed: status `Signed`, the signed PDF with the audit page, and the deal
  moves to the system stage "Approved" unless `skipDealApproval`. That update runs the deal's
  stage rules, webhooks and scripts. A booking agreement confirms its calendar event instead.
- A rejection sets the contract and the participant `Rejected`, e-mails everyone, and leaves
  the deal where it is. A `Rejected` contract lets the deal generate a new one.

## Withdraw (`Ready` → `Draft`)

`PATCH {"status":"Draft"}`. No e-mail is sent. The signing page then shows only that the
contract is a draft and signing is refused. Allowed by the script only while every
participant is still `Pending`. Moving a `Pending` contract back to `Draft` and sending it
again would e-mail the people who already signed and ask them again.

## Download

`GET /v2/contract/<id>?select=contractDocuments signedDocuments&populatePath=[{"path":"contractDocuments"},{"path":"signedDocuments"}]&outputFormat=signedUrl`
returns each file with a `signedUrl` that expires after 15 minutes. The script fetches it at
once, checks it is a PDF and saves it; the address is never printed.

## Traps the server accepts silently

- Any save of a `Ready` contract re-sends the request (name, tag, assignee…).
- A create with participants and a document and no status is sent on the spot.
- Writing `signerEvidences` rebuilds it from what is sent: a role-only entry becomes `Pending`
  and loses the signature, IP and location. On a `Pending` contract that "unsigns" people.
- `status` can be set by hand: `Signed` with pending people is accepted, without signed
  document, e-mails or deal approval. `Rejected` by hand blocks signing without telling anyone.
- After the deadline the contract never closes on its own.

## Permissions

The key acts as its user. Reading and sending need the contract permissions of that user's
role and access to the record. A `403` means stop and tell the user; never retry with
another profile.
