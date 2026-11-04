---
name: prolibu-scoring
description: Explain, build and maintain Prolibu lead and deal scoring the way the platform computes it — read the account's scoring switches, list scoring profiles, explain why a contact or deal has a given score (or none) criterion by criterion, create or edit a rules profile (always inactive first) with checks the server never runs, try it on real records without saving, activate or deactivate it, and re-score a short list of named records. Use it whenever someone asks why a score is high, low or empty, wants to create or change scoring criteria or bands, wants to activate a scoring profile, or asks to recalculate scores. Spanish triggers: "puntaje", "score", "scoring", "lead scoring", "calificación del contacto", "por qué tiene ese puntaje", "no tiene puntaje", "perfil de scoring", "criterios de puntaje", "bandas frío tibio caliente", "recalcular puntajes".
---

# Prolibu Scoring

## Central idea

A **scoring profile** (`Scoring`) gives points to a Contact or a Deal: each criterion is a
json-logic condition (`when`) plus points (negative subtracts). The sum, capped to 0–100, is
the record's `score`; the band (`cold`, `warm`…) whose range contains it is its `scoreBand`.
Only **Contact** and **Deal** have a score. Per entity, one profile is active per workspace,
plus one for the whole account; a record uses its workspace's active profile, else the
account's.

The rule that surprises everyone: **a score is computed only when the record is saved.**
Activating or editing a profile re-scores nothing; each record changes on its next save.
Deactivating leaves old scores frozen. Engagement counters (`signals.*`) are refreshed only by
a re-score, never by normal activity, under rules profiles.

`scripts/scoring.js` does the fragile parts in code. It lints criteria the server accepts
silently: unknown operators, missing fields, linked records, list attributes, unreachable bands.
It creates profiles inactive, and shows which profile an activation switches off. A re-score
is limited to ids the user named. Your job is the conversation: agree what counts and how much,
show the preview, and write only after a clear yes.

```
node .claude/skills/prolibu-scoring/scripts/scoring.js <command> <domain> …
  status   <domain> [--counts]                      switches, active profiles, findings
  profiles <domain> [--entity Contact|Deal]         show <domain> <profileId | scoringCode>
  explain  <domain> --entity Contact|Deal --record <id | name | e-mail> [--scoring <profileId>]
  try      <domain> <profileId> <recordId,…>        score with a profile, saves nothing (≤10)
  plan     <domain> '<plan>'      →  apply <domain> '<plan>' --version <v> --confirmed
  activate-preview <domain> <id>  →  activate <domain> <id> --version <v> --confirmed
  deactivate-preview <domain> <id> → deactivate <domain> <id> --version <v> --confirmed
  recompute-preview <domain> '{"entity":"Contact","ids":[…]}'
                                  →  recompute … --version <v> --confirmed --reaches-people
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written). Every command takes `--profile <name>` when the user picks one.

## Ask the user first

In plain business terms:

1. **Contacts or deals?** No other record has a score.
2. **The whole account or one workspace?** `status` shows the key's user. If it has a primary
   workspace, every profile it creates applies only there. Say so before planning.
3. **What counts and how much:** each rule in words, its points, and the bands (name, from, to).
4. **New profile or change the active one?** A change to the active one applies to each
   record on its next save. Recommend: create inactive, `try` it, then activate.
5. **For "why" questions:** which record (name, e-mail or id).

If `accounts/` has several domains, ask which one.

## Steps

**Why does this record have this score (or none)?**

1. Run `explain`. It reads the stored score and breakdown, the profile that applies, and a
   fresh `preview` of that profile on the record.
2. Answer criterion by criterion from `criteria`: met or not, its points, and `valuesRead`
   (what the record holds). Use `checklist` and `findings` for an empty or stale score.
3. If the key gets `profileAccess: "forbidden"`, explain only from `stored.breakdown` and say
   an admin can show the rest. Never retry with another profile.

**Many records have no score.** Run `status --counts`: `withoutScoreNotSavedSinceProfile` counts
the ones waiting for a save. `explain` one id from `sampleWithoutScore`. Offer a re-score only
for ids the user names; never write your own scripts or queries for this.

**Create or change a profile.**

1. `status`, then `profiles` / `show` to reuse what exists.
2. Write the plan. A new one needs the scope: `"workspace": null` (whole account) or a
   workspace id. To edit, give `"id"` (id or code) and only the fields that change. `criteria`
   and `bands` are replaced whole, so send the full list.

   ```json
   {"set": {"scoringName": "Deals — quote size", "entity": "Deal", "workspace": null,
     "criteria": [
       {"key": "big", "label": "Quote over 10M", "when": {">": [{"var": "quoteTotal"}, 10000000]}, "points": 20},
       {"key": "sku", "label": "Quotes SKU-1", "when": {"some": [{"var": "proposal.quote.lineItems"},
         {"==": [{"var": "productCode"}, "SKU-1"]}]}, "points": 10},
       {"key": "stale", "label": "No activity 30+ days", "when": {">": [{"var": "daysSinceLastActivity"}, 30]}, "points": -10}],
     "bands": [{"key": "cold", "label": "Cold", "min": 0, "max": 29},
       {"key": "warm", "label": "Warm", "min": 30, "max": 59}, {"key": "hot", "label": "Hot", "min": 60, "max": 100}]}}
   ```

   Field names and the json-logic cookbook are in `references/scoring-model.md`.
3. Run `plan`. Tell the user the changes, `highestReachableScore`, every warning (unreachable
   bands, empty fields, gaps) and any blocker. Then stop and wait for a yes.
4. Run `apply` with `--version`. A new profile is created **inactive**. Report its id.
5. Offer `try <profileId> <ids>` on 3–5 real records: the score they would get, without saving.

**Activate or deactivate.** Run `activate-preview`. Tell the user which profile it switches
off (`displaced`), how many records are in scope, and that existing scores change only on each
record's next save. Wait for a yes; then `activate`. `deactivate-preview` says which profile
applies afterwards and that current scores stay as they are.

**Re-score named records.** Only for ids the user named (at most 50). Run
`recompute-preview` and show `sideEffects`: each record is saved again, so its webhooks
(listed with their hosts), AI triggers and notifications fire once per record. Closed-stage
deals fail. Wait for a yes to exactly that, then `recompute … --reaches-people`.

## How the platform behaves

Details and evidence are in `references/scoring-model.md`.

- **Scores change only on save.** No backfill after activating or editing a profile.
- **Activation is silent.** It switches off the other active profile of the same entity and
  scope, without any notice. The script names it in the preview.
- **Only rules profiles.** `type: "ai"` and `"hybrid"` do nothing today: they score by
  their rules only. Offer a rules profile instead and never write `ai.*`.
- **The server accepts broken criteria.** An unknown operator or field, or a bad condition,
  counts as "not met" with no error. A criterion without `when` gives its points to everyone.
- **Links are ids.** `contact.city` or `company.name` is always empty. A list attribute
  such as `proposal.quote.lineItems.productCode` is too: use `some` over the list.
- **Engagement counters (`signals.*`) are stale** until a re-score. Their dates are never
  equal to a text date: use `daysSinceLastActivity`.
- **Bands:** the first range in stored order that contains the score wins. The script saves
  them sorted by `min` and warns about gaps, overlaps and bands above the reachable maximum.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| Many records have no score | Not saved since a profile applied (no backfill) | `explain`; re-score named ids, or wait for saves |
| Nothing scores at all | Scoring off, entity not enabled, or no active profile | `status`; an admin changes the account settings |
| A criterion never adds | Linked-record path, list attribute, unknown field or operator | `show` lints; fix with `plan` |
| Every record gets the same points | Criterion without `when` | Add a condition |
| "Caliente" never appears | Positive points below the band's minimum | Raise points or lower the band |
| Score did not change after editing the profile | Applies on the next save | `try` shows the new value; re-score named ids |
| A deal's score is frozen | Closed stage: saves and re-scores are refused | Expected; explain it |
| Old scores after deactivating | Nothing clears them | Expected; activate another profile and re-score |

## Verify

- `apply` reads the profile back and lists fields that did not save (`mismatches`); a new
  profile must read `active: false` with the scope asked for.
- `activate` reads back the profile and each displaced one (`stillActive` must be empty).
- `recompute` reports `processed`/`failed` and each record's score before and after.

## Don't

- Call `seed-default`: it creates an active profile that switches off the current one.
- Re-score a whole entity or send a query; only the user's named ids.
- Write the account's scoring switches. Say which one is off; an admin changes it in settings.
- Set `active` in a plan, or create a profile of type `ai`/`hybrid`.
- Delete profiles. Retry a 403 another way or with another profile.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. Each `plan` / `*-preview` is the summary
step. Changing contact or deal fields so a criterion fires belongs to the generic flow in
`prolibu-platform-map`. Reports grouped by score belong to `prolibu-dashboards`.
