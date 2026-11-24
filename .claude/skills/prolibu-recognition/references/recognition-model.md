# Recognition model: how the platform behaves

Read this when a case falls outside the steps in `SKILL.md`. Every rule here was read in the
platform's code; the ones marked *live* were also called on a test account.

## Objects and fields

| Object (REST path) | Code | Key fields | Notes |
| --- | --- | --- | --- |
| BadgeNomination (`badgenomination`) | `BNM-…` | `badgeNominationName` (required), `description`, `iconUrl` (default image), `icon` (File; copies its URL into `iconUrl`), `coins`, `active`, `lang` | The badge **type**. The platform ships about twenty built-in types with 0 coins (years in company, employee of the month, customer hero…). |
| Badge (`badge`) | `BDG-…` | `badgeNomination` (required), `assignee` (required), `note`, `rewards` (read-only), `comments` | One award. Creating it grants the type's coins as a Reward. |
| Reward (`reward`) | `RWD-…` | `reason` (required), `coins` (required, cannot change after create), `assignee`, `redemptionCode`, `origin` | A coin grant. Needs `assignee` or `redemptionCode`, not both. |
| RewardsBudget (`rewardsbudget`) | `RWB-…` | `rewardsBudgetName`, `managers` (users, required), `totalCoins`, `spendingPeriod.startDate/endDate` (required) | |
| Challenge (`challenge`) | `CHL-…` | `challengeName`, `description`, `coins` (pot, required), `maxWinners` (default 1), `period.startDate/endDate`, `active`, `rewards` (read-only) | |
| ChallengeApplication (`challengeapplication`) | `CAP-…` | `challenge`, `applicant` (forced to the caller), `submission`, `status` (pending/approved/rejected; read-only), `reviewNote`, `reviewedBy`, `reviewedAt`, `coins` | |
| Prize (`prize`) | `PRZ-…` | `prizeName`, `description`, `coins` (price), `stock`, `displayImage`, `active`, `isNewPrize`, `index` | |
| RedeemedPrize (`redeemedprize`) | `RPR-…` | `redeemedPrize` (Prize), `quantity` (≥ 1), `spentFunds` (read-only) | No update route. |

Codes are generated from the clock, so they are unique but not secret.

## Coins and budgets

- **Funds** of a user = sum of `Reward.coins` where `assignee` is the user, minus sum of
  `RedeemedPrize.spentFunds` created by the user, all time. `GET /v2/reward/getFunds` answers
  for the caller only (*live*: a sales agent gets `{totalEarned, totalRedeemed, funds}`).
  For someone else the script sums both collections (manager role needed).
- **Budget check** (only when the account preference "rewards budget required" is on; off by
  default): on every Reward save the server looks for budgets where the **giver**
  (`updatedBy`, which equals the creator on create) is a manager and today is inside the
  period. It sums every Reward the giver created inside each budget's period and passes when
  any budget has room for that sum plus the new coins. Consequences:
  - each manager is measured alone against the whole `totalCoins`;
  - rewards count against every overlapping budget of the same manager;
  - the check also runs when a Reward is edited, counting it twice.
- **Circulation cap** (preference, 0 = off): the sum of all coins ever granted plus the new
  grant may not pass it.
- Who is the giver: a direct reward → its creator; a badge's coins → the badge's creator; a
  challenge winner → the manager who approved.
- Coins cannot be edited on a Reward. To correct one, delete it (own yes) and grant again.
  Deleting a Badge or a ChallengeApplication deletes its Reward.

## Badges

- No approval step. `POST /v2/badge {badgeNomination, assignee, note}` awards at once.
- If the type has coins, a Reward is created for the same person, charged to the creator.
- The server does not check that the type is active; the script does.
- The hook that grants the coins runs on every save of the award, not only on create, so the
  script never edits awards.
- Home widget "Recent awards" (`GET /v2/badge/recentAwards`, any signed-in user, *live*): the
  latest awards of people in the caller's workspaces, with badge name, icon, person's name and
  photo. The note and coins are not shown.

## Challenges

- Create: the pot `coins` and `maxWinners` (≥ 1). Each winner gets `floor(coins/maxWinners)`;
  the remainder is never given. A split of 0 makes every approval fail.
- Apply: `POST /v2/challengeapplication {challenge, submission}`; the applicant is always the
  caller. Refused when the challenge is inactive, before `period.startDate`, after
  `period.endDate`, or when the caller already applied. The challenge does not compute
  anything from deals or other records.
- Review: `PUT /v2/challengeapplication/approve/<code>` or `/reject/<code>` with
  `{reviewNote}`. Approve creates the Reward once (only on the change into approved), refuses
  past `maxWinners`, sets `coins`, `reviewedBy`, `reviewedAt`.
- After the first approval, `coins` and `maxWinners` cannot change.
- Rejecting an approved application keeps the Reward, and frees a winner slot.

## Prizes and redemptions

- `POST /v2/redeemedprize {redeemedPrize, quantity}` for the caller. Refused when redemptions
  are turned off, the prize is inactive, stock < quantity, or funds < coins × quantity.
- On success the prize stock is lowered and `spentFunds` saved. No approval, no notification
  (the preference "users notified on redemption" exists but nothing sends it).
- Stock is read and written in two steps: two redemptions at the same moment can both pass.
- A prize without `stock` or `coins` behaves badly; the script requires both.
- Deleting a redemption gives the coins back (funds are recomputed) but does not restore stock.

## Notifications (defaults; each user may change theirs)

| Event | Who | Channels |
| --- | --- | --- |
| Badge awarded | the person awarded | notification center + e-mail |
| Coins granted (direct, badge coins, challenge win) | the person | notification center |
| Application created, rejected; prize redeemed; budget, type, challenge, prize created | nobody | — |

## Roles

- **Achievements Manager**: everything on all eight objects.
- **Achievements Features** / **Rewards And Prizes**: read rewards, badges (features only) and
  prizes; redeem prizes; read their redemptions.
- Other roles (e.g. Sales Agent, *live*): no access to the lists; `getFunds` and
  `recentAwards` still answer.

## Screens

The V2 app lists badge types, awards, prizes, redemptions and rewards as ordinary tables with
create and edit forms. Challenges, applications and budgets have no V2 screen (the menu entry
is off), so the API is the way to manage them. V1 shows a redeem button per prize that checks
`coins × quantity ≤ funds` before `POST /v2/redeemedprize`.
