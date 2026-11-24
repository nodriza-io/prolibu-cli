---
name: prolibu-recognition
description: Run Prolibu recognitions and gamification the way the app does — create badge types and award them to colleagues, give coins against a manager's rewards budget, create challenges and approve or reject their applications, create prizes and redeem them with coins, and read coins left, budgets left per manager, leaderboards and challenge winners. Every coin movement is previewed with totals against the budget and needs an explicit yes, and anything that notifies people needs its own yes. Use it whenever someone wants to create or award a badge, recognize or "nominate" a colleague, give points or coins, set or check a rewards budget, create a challenge or contest, approve applications or winners, create or redeem a prize, or asks who is first, how many coins someone has or how much budget is left. Spanish triggers: "crea la insignia", "dale una insignia", "nomina a", "reconocimiento", "dale puntos", "monedas", "presupuesto de recompensas", "cuántos puntos le quedan", "crea el reto", "desafío", "aprueba las nominaciones", "aprueba las postulaciones", "quién va primero", "canjear premio", "premios".
---

# Prolibu Recognition

## Central idea

Recognition lives in the achievements module and moves **coins**, a money-like unit:

| What the user says | Object | What happens |
| --- | --- | --- |
| a badge, "la insignia Cliente Feliz" | `BadgeNomination` (the badge **type**: name, icon, coins) | Nothing moves until it is awarded. |
| "nomina a Laura", "dale la insignia" | `Badge` (one award to one person) | **Immediate**, no approval: Laura gets the badge, a notification and an e-mail, and the type's coins. |
| "dale 50 puntos" | `Reward` (coins to one person) | Immediate; in-app notification. |
| a rewards budget | `RewardsBudget` (managers, total, period) | Caps what **each** manager may give in the period, only if the account enforces budgets. |
| "crea el reto" | `Challenge` (coin pot, max winners, window) + `ChallengeApplication` | People apply with evidence; a manager approves; each winner gets `floor(coins / maxWinners)`. |
| a prize, "canjear" | `Prize` (coins, stock) + `RedeemedPrize` | Immediate: coins spent, stock lowered, no approval, nobody notified. |

The rule that breaks things when ignored: **there is no approval step for badges.** "Nominate"
in the app means award now. The only review queue is challenge applications.

`scripts/recognition.js` does the fragile parts in code: it resolves people by e-mail, computes
what each budget has left the way the server does, blocks what the server would refuse half-way,
refuses self-awards and self-approvals, and reads back every write. Your job is the
conversation: agree who, what and how many coins, show the preview with its totals, and write
only after a clear yes.

```
node .claude/skills/prolibu-recognition/scripts/recognition.js <command> <domain> …
  overview    <domain>                                    settings, badge types, prizes, challenges, budgets
  funds       <domain> [--user <email>]                   coins earned, spent, left (yours by default)
  budgets     <domain> [--at YYYY-MM-DD] [--manager <email>]   left per manager in each active budget
  leaderboard <domain> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--top <n>]   coins earned and badges
  challenge   <domain> <code | name | id>                 winners, pending, rejected, slots left
  pending     <domain>                                    challenge applications waiting for review
  preview     <domain> '<plan json>'                      writes nothing; returns a version
  apply       <domain> '<plan json>' --version <v> --confirmed [--reaches-people]
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written). Every command takes `--profile <name>` when the user picks one.

## Ask the user first

1. **Award or give coins:** who (e-mail), which badge type, the note or reason, how many coins.
   Say it is immediate and notifies the person.
2. **Challenge:** the name, the coin pot, how many winners, the application window (dates). A
   challenge does **not** count deals or amounts by itself; ask how winners will prove it.
3. **Prize:** coins and stock (a stock number is required). **Budget:** managers, total, period.
4. **Review:** which applications to approve or reject, with an optional note.

If `accounts/` has several domains, ask which one.

## Steps

1. **Read.** `overview` for the badge types, prizes, challenges, budgets and settings
   (`budgetsEnforced`, coin name). Use `pending`, `challenge`, `budgets`, `funds` or
   `leaderboard` for the question asked. Fields at `null` are admin-only settings.
2. **Plan.** One JSON object with `kind`:

   ```json
   {"kind":"badge-type","name":"Cliente Feliz","description":"…","coins":50,"iconUrl":"https://…","active":true}
   {"kind":"award","badgeType":"Cliente Feliz","to":"laura@example.com","note":"Cierre con Acme"}
   {"kind":"reward","to":["a@example.com","b@example.com"],"coins":20,"reason":"Cierre del trimestre"}
   {"kind":"challenge","name":"10 negocios ganados en diciembre","coins":900,"maxWinners":3,"startDate":"2026-12-01","endDate":"2026-12-31"}
   {"kind":"review","decisions":[{"application":"CAP-…","decision":"approve","note":"Verificado"}]}
   {"kind":"prize","name":"Taza","coins":200,"stock":10}
   {"kind":"budget","name":"Q4 ventas","managers":["boss@example.com"],"totalCoins":5000,"startDate":"2026-10-01","endDate":"2026-12-31"}
   {"kind":"redeem","prize":"Taza","quantity":1}
   {"kind":"update","object":"prize|challenge|badge-type|budget","ref":"<code or name>","set":{"stock":20}}
   ```
3. **Preview.** Tell the user, in plain words: the summary, each person and amount, the
   **total coins**, and for each of their budgets `spentByYou → leftBefore → leftAfter`; the
   `reachesPeople` line; every warning. If `blockers` is not empty, explain and stop.
4. **Wait for an explicit yes.** For `award`, `reward` and approvals, the yes must cover the
   notifications too (who gets what). Never batch-approve or batch-reward without having shown
   the total against the budget.
5. **Write.** `apply` with the same plan and `--version`, `--confirmed`, plus
   `--reaches-people` for award, reward and approvals. It refuses when anything moved since the
   preview (a record, the budget spent, your funds): preview again and show the new figures.
6. **Report** the codes saved, coins given and budget left. If `written < of`, say exactly
   which items were saved and preview the rest; never rerun the whole plan.

## How the platform behaves

Details, evidence and edge cases are in `references/recognition-model.md`.

- **Coins are charged to whoever creates them.** A direct reward and a badge's coins charge
  the giver; a challenge winner charges the manager who approves. Each manager is checked
  **alone** against a budget's whole total: a budget with 3 managers and 1,000 coins lets each
  give 1,000. Budgets only block when the account enforces them (off by default).
- **Batches stop half-way.** The server checks each coin grant one at a time; the preview
  shows the item where the budget runs out and blocks it.
- **Challenges:** applicants apply for themselves only; once a winner is approved, coins and
  max winners are locked; rejecting an approved winner does **not** take the coins back.
- **Funds** = coins received − coins spent on prizes, all time. A redemption is for the caller
  only (nobody redeems for someone else) and is final.
- **Notifications:** badge award → the person gets an in-app notification and an e-mail by
  default, and the award shows in the home widget "Recent awards" to their workspace; coins →
  in-app notification; challenge rejection, prize redemption, budgets, types → nothing.
- **Badges are not edited.** Editing an award whose type gives coins can grant them again;
  the script refuses `update` on awards and on rewards.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| "No active rewards budget found at the moment." | Budgets enforced; the giver (or approver) is not a manager of a budget active today | `budgets --manager`; create or extend a budget (its own yes) |
| "Cannot find an active rewards budget to cover the reward." | The giver's spending in the period + this grant exceeds every budget | Give less, or raise `totalCoins` |
| "Insufficient funds." on a redemption | Coins left < coins × quantity | `funds`; nothing to do but earn more |
| "Sorry, insufficient stock…" | Stock below the quantity | `update` the prize stock |
| "This challenge has already reached its maximum number of winners." | `maxWinners` approved | Reject the rest, or a new challenge |
| "Cannot change coins or maxWinners after winners were approved." | A winner exists | Create another challenge |
| "Challenge has not started yet." / "…period has ended." | Applying outside the window | `update` the dates (its own yes) |
| "aprueba las nominaciones" finds nothing to approve | Badges have no approval | Show `pending` (challenge applications) instead |

## Verify

- `apply` reads every record back: an award with coins must show one reward linked, an
  approval must show `approved` and a reward, a redemption its `spentFunds`.
- Give the user the codes (`BDG-…`, `CAP-…`, `RPR-…`) and run `budgets` or `funds` again
  when coins moved.

## Security

- The script acts with the user's key and role, never more. Reading budgets, rewards and
  applications needs the achievements manager role; a `403` is reported, never worked around.
- Reviews go only through this script: it reviews applications the user can read and refuses
  self-approval. Never call the approve or reject routes by hand or with a code nobody read.
- The preview names every person reached. A notification or e-mail cannot be unsent.
- Undo (each its own yes, in the app or the generic helper): deleting an award or an
  application also deletes its coins (the person's funds can go negative if already spent);
  deleting a redemption gives the coins back but **not** the stock.
- Claimable reward codes (`redemptionCode`) are out of scope: a code works like a bearer
  voucher for whoever has it. Give coins to a named person instead.

## Don't

- Don't say a badge was "sent for approval": it was awarded.
- Don't create a challenge that promises automatic counting (deals won, sales): it has none.
  For a ranking by business results, build a report with `prolibu-reports-dashboards`.
- Don't give coins to yourself or approve your own application.
- Don't approve or reward in bulk without the preview's total against the budget.
- Don't add `--reaches-people` before the user agreed to notify exactly those people.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step and `apply`
the write. For how objects relate, see `prolibu-platform-map`.
