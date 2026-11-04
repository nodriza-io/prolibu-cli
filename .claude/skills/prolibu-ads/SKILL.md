---
name: prolibu-ads
description: Work the Prolibu advertising module the way the app does — the connected ad accounts (Ad Hubs) and their pages, the lead forms mirrored from Meta Lead Ads, the ads (AdCampaign) that bring the leads, who receives each new lead (the form's group, then the ad's group, round robin or pool), the workspace each page sends its leads to, lead counts per campaign, ad, form or page for a period (new people vs re-contacts), and the stage → event reports sent to Meta's Conversions API. Diagnoses why a lead landed with nobody, in the wrong team or never arrived, and changes the routing (group of a form or of the ads of a campaign, workspace per page, stage → Meta event) with a preview first. Use it whenever someone asks why Facebook or Instagram leads are not arriving, who gets the leads of a form or campaign, how many leads each campaign brought, or wants to change the team that receives them. Spanish triggers: "leads de Facebook", "leads de Instagram", "leads de Meta", "campaña de Facebook", "formulario de Meta", "no están llegando los leads", "a quién se le asignan los leads", "cuántos leads trajo cada campaña", "grupo de asesores de la campaña", "Ad Hub", "Conversions API", "evento de calificación a Meta".
---

# Prolibu Ads

## Central idea

An ad lead travels **Meta → the ad service (outside the account) → `Contact.submit`**. It
creates or finds a **Contact** (one per e-mail), one **ContactSubmission** per form sent (with
its date, ad, campaign and Meta lead id), and an **AdCampaign** the first time an ad brings a
lead. Despite its name, an AdCampaign is **one Meta ad** (its code is the ad id). A Meta
campaign groups several ads.

Three records decide where a lead goes:

- **AdHub**: one connected ad account. It holds the pages (`details`, written by the
  connection), a workspace per page (`pageWorkspaces`), and the stages reported to Meta
  (`qualificationMappings`, with a Conversions API credential).
- **AdHubForm + Form (type `meta`)**: the mirror of one Meta lead form, with its field map and
  its user group.
- **AdCampaign**: the ad, with an optional user group.

Only a **new person** without owner is routed. The form's group goes first, the ad's group only
fills the gap. A group with load balancing gives the lead to the next active member (round
robin). Without it, the lead waits without owner and every member is notified. Re-contacts and
existing contacts never change owner.

`scripts/ads.js` reads all of this, explains one lead, counts leads per period, and writes only
the routing, with a preview first.

```
node .claude/skills/prolibu-ads/scripts/ads.js <command> <domain> …
  hubs      <domain>                         ad accounts, pages, forms per page, last lead
  forms     <domain> [--hub code] [--page id] mirrored forms: mapping, group, applied or not
  campaigns <domain> [--search text] [--with-group]
  group     <domain> <name|code|id>           members, active, round robin or pool, next in turn
  report    <domain> --from YYYY-MM-DD --to YYYY-MM-DD [--by campaign|ad|adset|form|page|source|account] [--tz zone]
  diagnose  <domain> <contact e-mail|id>      why this lead landed where it did
  preview   <domain> '<plan>'  →  apply <domain> '<plan>' --version <v> --confirmed [--reports-to-meta]
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written). Every command takes `--profile <name>`.

## Ask the user first

1. **Which account.** If `accounts/` has several domains, ask.
2. **Which campaign, ad or form**, in their words. "Campaña" usually means a Meta campaign
   (several ads): use `metaCampaign`. Ask when the name could mean either.
3. **Which team** (user group), and whether it should rotate leads or share a pool.
4. **For counts:** the period, and the time zone if it matters (the script reports the ad
   account's own zone).

## Steps

**Leads are not arriving.** Run `hubs`. Check: submissions enabled, each Ad Hub `Connected`
and active, the page listed, its forms, `lastLeadAt` per page. A lead without e-mail, an
expired page permission or the ad service down leave no trace in the account. Then the
connection must be checked or redone in the app (Ad Hub screen), by an admin. Never here.

**Where did this lead go? / Why has it no owner?** `diagnose <domain> <e-mail>`. It gives the
first touch (page, form, campaign, ad), every submission, the group the form and the ad have
today, the workspace by page, and whether its current stage would be reported to Meta. Explain
`findings` in plain words.

**Who gets the leads of X?** `forms` (the form group and whether it applies) and `campaigns
--with-group`, then `group <domain> <group>` for the members and who is next.

**How many leads per campaign?** `report <domain> --from … --to … --by campaign` (or `ad`,
`adset`, `form`, `page`, `source`, `account`). Each submission is one lead; `newContacts` are
first-time people and `recontacts` people already in the account. If `notes` names another
time zone, rerun with `--tz` to match Meta. For a saved report or chart, use
`prolibu-dashboards`.

**Change the team of a campaign or ads.**

```json
{"kind": "campaign-group", "metaCampaign": "COL - Ventas - Forms", "group": "Inbound team"}
```

Or `"campaigns": ["<ad code | id | exact name>"]`. `"group": null` removes it. An ad that has
not brought any lead yet does not exist here: route its form instead, or add
`"register": [{"adCampaignCode": "<Meta ad id>", "adCampaignName": "<name>"}]`.

**Change the team of a form** (it wins over every ad of that form, new ads too):

```json
{"kind": "form-group", "form": "<Meta form id | AdHubForm id>", "group": "Inbound team"}
```

**Workspace per page, or stages reported to Meta** (whole lists, replaced):

```json
{"kind": "hub", "hub": "ADH-…", "set": {
  "pageWorkspaces": [{"pageId": "1023…", "workspaceCode": "colombia"}],
  "qualificationMappings": [{"stageCode": "contact-sales-qualified", "eventName": "Qualified Lead"}]}}
```

Every write: `preview`, then show the user `changes`, the group's `mode` and members,
`futureRecipients`, `warnings`, `blockers` and `externalEffects`. Stop there. After a yes, run
`apply` with the preview's `--version` and `--confirmed`. A plan that maps stages to Meta also
needs `--reports-to-meta`, only after the user agreed to exactly that.

## How the platform behaves

Details, field lists and evidence are in `references/ads-model.md`.

- **Routing order:** an owner in the lead wins. Then the form's group (only when its mirror is
  on and it maps at least one question), then the ad's group. A group with no members or no
  active member is ignored and the lead stays without owner.
- **Round robin** picks the first active member and moves them to the end of the group's list.
  The platform rewrites that order itself; never edit it by hand.
- **The first lead of a new ad** creates its AdCampaign without group, so it is not routed by
  the ad. A form group covers it.
- **Workspace:** the page's row in `pageWorkspaces`, else the Ad Hub's workspace. A contact
  without workspace is visible only to admins.
- **Meta reports:** a stage move of a Meta lead into a mapped stage sends that event to Meta,
  only when moving forward (higher stage index), with a credential and the lead's Meta id.
  Moving contacts' stages is `prolibu-stages` / `prolibu-leads` work; warn that it reports.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| No leads at all from a page | Ad Hub not connected, inactive, page missing, submissions off, token expired | `hubs`; reconnect in the app |
| Lead without owner | Pool group, group with no active member, or no group | `diagnose`; `group`; a plan |
| Leads go to the old team | The form's group wins over the ad's | `forms`; form-group plan |
| Group change did nothing for old leads | Only new people are routed | Reassign them in the app |
| Seller cannot see a Meta lead | Contact without workspace, or another workspace | hub plan with `pageWorkspaces` |
| Counts differ from Meta | Re-contacts, time zone, leads without e-mail refused | `report --tz <ad account zone>` |
| Meta does not get "qualified" | Stage not mapped, no index, backward move, no credential | `diagnose` → `metaReport` |

## Verify

- `apply` reads every record back; `problems` must be empty.
- After a group change, run `group` to show members and the next in turn.

## Don't

- Connect, reconnect or disconnect an ad account, or touch credentials, tokens or
  `ServiceCredential`: that is OAuth in the app, by an admin.
- Send the test Conversions API event (`/v2/adhub/connect/…/conversion/test`) or call
  `/v2/adhub/connect/…`: the first reaches Meta, the second belongs to the ad service.
- Submit leads (`/v2/contact/submit`) or create contacts to "test" a form.
- Edit user groups (members, order, load balancing) or account preferences.
- Edit a meta form's field map here: it is done in the app's Ad Hub screen.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. Ad Hubs, ad campaigns, mirrored forms and
user groups are **admin only**: a seller gets `403` (only `report` and `diagnose` give partial,
own-records answers). Say an admin must do it; never retry another way or with another
profile. Web forms are `prolibu-forms`; leads already in the account (triage, turns, convert)
are `prolibu-leads`; outbound webhooks to a CRM are `prolibu-webhooks`.
