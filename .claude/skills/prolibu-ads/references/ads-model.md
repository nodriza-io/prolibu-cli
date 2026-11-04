# Ads model

Reference for `prolibu-ads`. Read the section you need.

## The path of one lead

1. Meta sends a `leadgen` webhook to the ad service (outside the account). The service reads the
   lead with the page's token, translates the field names (a fixed dictionary: `correo` →
   `email`, `nombre_completo` → first and last name…) and calls `POST /v2/contact/submit` with a
   service token.
2. `Contact.submit` refuses everything when `modules.directory.contacts.submissions.enabled` is
   off (`403`), and a lead without `email` (`400`). Neither leaves a record in the account.
3. A lead whose Meta id (`refId`) was already recorded is dropped as a retry.
4. If the Meta form has an active mirror (AdHubForm on, Form `type: meta` active, at least one
   mappable question), its field map replaces the dictionary's result and its group fills the
   lead's empty group. A field map that fails validation is dropped and the lead is saved with
   the dictionary's result.
5. Same e-mail (in an active workspace) = the same person: a **re-contact**. It adds a note,
   resets the stage to the account's default stage, records the submission and notifies; it
   never changes the owner, group, ad or first-touch data.
6. A new person is created by the account's "contact creator" user, `direction: Inbound`,
   `source: "<Facebook|Instagram> AdHub"` (or the ad's name), the default stage, and the
   workspace of the page.
7. On save: the AdCampaign is found by the ad id (`adCampaignMeta.adCampaignCode`) or created
   without group; the ad's group is inherited only when the contact still has no owner and no
   group; then the load balancer runs.
8. Answers that fill no field go to a note "Información adicional del formulario Meta" and to the
   submission's `data`.

## Objects

| Object | Route | Who | Notes |
| --- | --- | --- | --- |
| `AdHub` | `/v2/adhub` | admin | `adHubCode` (ADH-…), `adHubName`, `adProvider` (Meta, TikTok, LinkedIn; fixed), `state` (Pending, Connected; read-only), `active`, `details[]` (pages, written by the connection, replaced on every reconnection), `pageWorkspaces[]`, `qualificationMappings[]`, `metaCredential`, `workspace` |
| `AdHubForm` | `/v2/adhubform` | admin | `adHub`, `provider`, `pageId`, `pageName`, `formId` (Meta id, unique), `formName`, `formStatus` (ACTIVE, ARCHIVED, DELETED, DRAFT), `form` (the meta Form), `active`, `lastSeenAt`, `discoveredAt` |
| `Form` type `meta` | `/v2/form` | admin | `formSchema` mirrored from Meta's questions, `mappings[0]` = `{modelName: "Contact", action: "create", fieldMap, assignmentGroup?}`, `assignmentGroup`. Never served publicly. |
| `AdCampaign` | `/v2/adcampaign` | admin (sellers: search only) | `adCampaignCode` (the Meta ad id), `adCampaignName`, `assignmentGroup` |
| `ContactSubmission` | `/v2/contactsubmission` | own records | `contact`, `sequence` (1 = new, 2+ = re-contact), `source`, `adCampaign`, `adCampaignMeta`, `refId` (Meta lead id), `data`, `createdAt` |
| `Contact` | `/v2/contact` | own records | `adCampaign` and `adCampaignMeta` = first touch; `submissions.{firstAt,lastAt,count,lastAdCampaign,lastSource}`; `assignmentGroup`, `assignee` |
| `UserGroup` | `/v2/usergroup` | admin | `users[]` (order = turn), `enableLoadBalancing`, `userGroupType` |

A Deal created for a contact inherits the contact's `source` and `adCampaign` when it has none.

## `adCampaignMeta`

`provider`, `source` (Facebook, Instagram), `accountId`, `accountName`, `accountTimezone` (the
ad account counts days in this zone), `pageId`, `pageName`, `formId`, `formName`, `campaignId`,
`campaignName` (the Meta campaign), `adSetId`, `adSetName`, `adCampaignCode`, `adCampaignName`
(the ad), `currency`, `stats.financial.*` and `stats.engagement.*`. The stats are **lifetime
snapshots of the ad** at submission time: never add them up across submissions.

Filter by `adCampaignMeta.provider` to separate ad leads from web forms. Date ranges go inside
`$and` (one operator per field survives the server's rewrite).

## Routing

```
lead has assignee                       → that owner, nothing else
mirror applies and has a group          → that group   (mapping group > form group)
else the ad (AdCampaign) has a group    → that group   (new contact, or the ad changed)
group with load balancing               → next ACTIVE member in users[] becomes owner,
                                          and moves to the end of users[]
group without load balancing            → no owner; every member gets "available" notice
group missing, empty or nobody active   → no owner, no group
```

- The group's type is not checked; the app's pickers offer every type.
- Changing a group or a form's group never touches contacts already in the account.
- A web form's group is `prolibu-forms`; its rules are the same.

## Workspace

`pageWorkspaces` row of the page (`workspaceCode`, trimmed) → that workspace; an unknown code
falls back to the Ad Hub's `workspace`. A deactivated workspace makes the submission fail.
Existing contacts keep their workspace; notes and submissions follow the contact's.

## Meta Conversions API (stage reports)

After a contact update that changes `stage`, for a contact with `adCampaignMeta.provider ==
Meta`:

1. The Ad Hub that owns the page (most recently updated) and its `qualificationMappings`.
2. The new stage's `stageCode` must have a row with a non-empty `eventName`.
3. With a previous stage, both stages need a numeric `index` and the new one must be higher
   (forward move). Re-contacts reset the stage, so they never report.
4. The Meta lead id is the `refId` of the contact's **first** Meta submission (digits only).
5. The credential (`metaCredential`, a `ServiceCredential` of type meta, active, with dataset id
   and token) must exist.

It is fire-and-forget: failures are only logged. The app also has a manual test event; it
sends a real event to Meta and is not used by this skill.

## Forms discovery

When an account connects, the Ad Hub lists each page's ACTIVE lead forms and creates their
mirrors with a seeded field map (dictionary keys → contact fields; the e-mail question is
guessed by label as a last resort). A lead from an unknown form creates its mirror too. A
re-discovery refreshes the questions and adds new keys, and never re-adds a key the user
removed. Deleting the meta Form leaves the mirror "unconfigured"; the next lead recreates it.

## Permissions

- Admin: everything above.
- Sales agent: `AdCampaign.search` only; no Ad Hubs, mirrors, groups or users. Submissions and
  contacts by record access (their own).
- `/v2/user/preferences` shows `modules.directory.contacts.submissions.enabled` to every user;
  the rest of that preference (a shared secret for the ingestion) is admin-only and is never
  read by this skill.
