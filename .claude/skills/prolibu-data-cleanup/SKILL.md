---
name: prolibu-data-cleanup
description: Find and resolve duplicate Prolibu contacts and companies — detect them across the whole account (exact e-mail, other e-mails, normalized phone, similar names, company domain, tax id), show what points at each record, merge one group at a time (deals, notes, tasks, calls, meetings, conversations and lists move to the primary; empty fields filled; the duplicate marked, never deleted) with a preview, one explicit yes per group, a log of every record moved and a read-back; and tag stale contacts as archived. Use it whenever someone asks for duplicate or repeated contacts or companies, wants to merge or unify two records, asks which contacts have had no activity since a date, or wants to archive or tidy old contacts. Spanish triggers: "contactos duplicados", "empresas duplicadas", "contactos repetidos", "fusiona", "fusionar", "unificar contactos", "mismo correo", "mismo teléfono", "archiva los contactos", "sin actividad desde", "limpiar la base".
---

# Prolibu Data Cleanup

## Central idea

The platform has **no merge** and **no archive** for contacts or companies. A merge is built
from ordinary updates: every record that points at the duplicate is re-pointed to the primary,
the primary's empty fields are filled, and the duplicate is marked. The duplicate is **never
deleted**: deleting a contact or company also deletes every note, task, call and meeting on its
list, and the moved ones stay on that list (the API cannot clear it). Some references cannot be
moved at all (e-mails, submissions, a deal's company): the preview lists them. A merge cannot
be undone by the platform, so each group gets its own preview and its own yes.

`scripts/cleanup.js` does this in code: detection, reference counts (refusing to trust a filter
the server dropped), the fill, the moves, the mark, an audit note, a local log of every move,
and the read-back.

```
node .claude/skills/prolibu-data-cleanup/scripts/cleanup.js <command> <domain> …
  duplicates <domain> <contact|company> [--by email,phone,name,domain,id] [--limit <n>]
  show       <domain> <contact|company> <id | e-mail | companyCode>   record + what points at it
  inactive   <domain> --before YYYY-MM-DD [--limit <n>]               contacts with no activity since
  preview    <domain> '<plan json>'                                   writes nothing; returns a version
  apply      <domain> '<plan json>' --version <v> --confirmed [--fires-webhooks]
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written). Every command takes `--profile <name>`.

## Ask the user first

1. **Which account.** If `accounts/` has several domains, ask.
2. **Contacts or companies**, and by what: e-mail, phone, name, domain, tax id (default: all
   that apply).
3. **For each group to merge: which record stays** (the primary). The script suggests the
   most complete one; the user decides. Name-only matches ("low" confidence) are different
   people until the user says otherwise.
4. **To archive:** the cut-off date, and the tag name (default `Archivado`).

## Steps

1. **Detect.** `duplicates <domain> contact` (or `company`). Show the count, the high-confidence
   groups first, with the reasons (`why`), and the `detailFile` with every group. Do not list
   hundreds of groups in the chat: offer to go group by group.
2. **Inspect a group.** `show <domain> contact <id>` for each record: what points at it and what
   would stay on the duplicate.
3. **Plan one group:**

   ```json
   {"kind": "merge", "object": "contact", "primary": "<id or e-mail>", "duplicates": ["<id or e-mail>"]}
   ```

   Companies: `"object": "company"`, records by id or `companyCode`. Contacts: optional
   `"markTag"` (default `Fusionado`).
4. **Preview.** `preview <domain> '<plan>'`. Tell the user, in plain words:
   - `fillsPrimary`: each field the primary gains and from which record;
   - `moves`: how many deals, notes, tasks… move;
   - `staysOnDuplicate`: what cannot move and why (e-mails, submissions, deals' company…);
   - `markDuplicate`, `triggers` (webhooks or scripts that will run), every `warning`;
   - that the merge cannot be undone and the duplicate is kept, not deleted.
   On `blockers` (exit 3), explain and stop.
5. **Wait for an explicit yes to this group.** A yes to one group is not a yes to the next.
   If `triggers` is not empty, the yes must cover them (external systems get the updates).
6. **Write.** `apply <domain> '<same plan>' --version <version> --confirmed`, plus
   `--fires-webhooks` only when the preview listed triggers and the user agreed. It refuses
   when any record changed since the preview, or when the group is already merged.
7. **Report.** How many records moved, `problems`, and the `logFile` path (every record moved,
   from and to). Then offer the next group.

**Inactive contacts.** `inactive <domain> --before 2025-01-01` lists contacts not edited since
then, with no submission, deal change or e-mail since. Archive them with
`{"kind":"archive","contacts":["<id or e-mail>", …],"tag":"Archivado"}` (up to 200 per plan):
preview, yes, apply. It only adds the tag (created if missing); nothing is deleted, nobody is
notified. Companies cannot be archived (they have no tags).

## How the platform behaves

Details, the full reference table and the traps are in `references/cleanup-model.md`.

- **What moves.** Contacts: deals, presentations, notes, tasks, calls, meetings (as parent and
  as attendee), conversations, contact lists. Companies: contacts, notes, tasks,
  conversations.
- **What stays on the duplicate.** E-mails, form and ad submissions, converted leads, contract
  signers, tickets, billing records; consent and unsubscribe state; for companies, the deals'
  company (read-only, so company reports still count those deals under the old company).
- **What the primary keeps.** Its own values, owner, collaborators, group, stage and history.
  Only empty fields are filled; other e-mails, phones, tags and domains are added.
- **The mark.** Companies: renamed `[FUSIONADA] <name>`, domains emptied (so new contacts link
  to the primary). Contacts: tag `Fusionado`, e-mail kept. A note on the primary lists what moved.
- **Side effects.** Updating deals fires the account's `Deal.update` webhooks; moving notes or
  tasks updates the primary. The preview reads the active webhooks and scripts and names them.
- **Permissions.** A seller sees only its own contacts and often no companies; a contact merge
  needs to read every movable reference (presentations, conversations…). A `403` stops the
  script with FORBIDDEN: tell the user an admin must do it; never retry another way.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| Merged company still shows deals in reports | Deal.company is read-only in the API | Expected; the preview warned. Rename tells them apart |
| New contacts keep linking to the old company | Duplicate still had the domain | The merge empties its domains; check with `show` |
| Merged contact still gets campaigns after unsubscribing | Opt-out was on the duplicate | Unsubscribe the primary in the app |
| Notes vanished after deleting a duplicate | Delete cascades over its activity list | Never delete merged duplicates |
| "Already merged" | The group was merged before | Nothing to do |
| FORBIDDEN on presentation/conversation | Profile cannot read a movable reference | An admin profile runs the merge |

## Verify

- `apply` reads the primary back (every filled field) and counts each movable reference on
  the duplicate: anything left is listed under `problems`.
- Give the user the `logFile` path; it is the only record of what moved.

## Don't

- Delete a duplicate, merged or not, or call `DELETE` on contacts or companies.
- Merge more than one group per yes, or pick the primary for the user on a low-confidence group.
- Re-point e-mails, submissions, contracts, tickets or billing records by hand.
- Change owners, collaborators, groups or stages as part of a merge (use `prolibu-stages` or
  the app).
- Use `--fires-webhooks` before the user agreed to the listed triggers.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. Duplicates coming from a file go to
`prolibu-imports` (it checks before importing); a lead that would duplicate a contact to
`prolibu-leads`; adding notes or tasks to a record to `prolibu-activities`; webhooks themselves
to `prolibu-webhooks`.
