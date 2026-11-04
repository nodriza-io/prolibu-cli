# Proposal wizard: model and behaviour

Verified against the platform's code and a non-production account. Read it when a case falls
outside the steps in `SKILL.md`.

## ProposalWizard (`/v2/proposalwizard`)

`GET /v2/proposalwizard/<code or id>` works with either. The schema is in
`GET /v2/user/me` → `modelSchemas.ProposalWizard`.

| Field | Notes |
| --- | --- |
| `proposalWizardCode` | Made by the server on create: the name as a slug plus 3 digits. It IS the public link. Renaming the wizard keeps it; changing it breaks every shared link, QR and short link. |
| `proposalWizardName` | Required. Deal names are `@<wizard name> - <visitor's name>`; also the link preview title. |
| `assignmentGroup` | Required. A UserGroup. The app's picker shows only type "Proposal Wizard"; the server accepts any type. |
| `wizardGroup` | Membership in a `/pwg/<code>` chooser (a ProposalWizardGroup). Set on the wizard, not on the group. |
| `proposalPreset.title` | Required. Proposal title of each created deal. |
| `proposalPreset.stage`, `.layout` | Stage and layout template (`templateType: layout`) of the deal. |
| `proposalPreset.expirationDays`, `.unpublishedDays` | Proposal expiration / unpublish dates = now + days. |
| `proposalPreset.timeSensitiveDiscounts` | `enabled`, `strategy` (Real-Time or Limited-Time), `time` in **milliseconds**, `overrideDiscount.percentage` (decimal) or `.amount`. The override replaces the discount of every line, preset lines included. |
| `proposalPreset.quote` | Preset lines: they go first in every quote. |
| `proposalPreset.source`, `.adCampaign` | Copied to the new contact and the deal. Default source: "Proposal Wizard" in the account language. |
| `lineItemsSource.pricebook` | Every active entry of this list is offered. |
| `lineItemsSource.pricebookEntries` | Loose extra entries (duplicates with the list are merged). |
| `lineItemsSource.advisorPricebooks` | Only for a signed-in advisor. A chosen list replaces the price of base products it contains in the same currency; it never adds products. |
| `contactFields.firstName/lastName/mobile/companyName` | true = asked and required. E-mail is always required. |
| `dealFields.observations` | Asked and required when true. |
| `allowMultipleLineItems` | Up to 100 lines when true, otherwise 1. |
| `createVersionPerLineItem` | One proposal version per line (an extra deal update). |
| `allowSignIn`, `requireAuthentication` | Advisor mode; advisors only. Without `allowSignIn`, a session is ignored. |
| `language` | The page has texts only in es, en, pt; any other shows Spanish. The e-mail to the visitor uses this language. |
| `form` | A Form whose fields are added to the page. |
| `htmlHeader`, `displaySettings.subtitle` | HTML, sanitized in the browser. |
| `termsAndConditions` | `enabled`, `acceptanceText`, `documentUrl`. Enforced in the browser only. |
| `active` | Defaults to **true**. Inactive: the page and submissions answer "not active". |

A `PATCH` merges nested objects key by key and replaces lists whole. The script sends the
whole merged object anyway.

## What a submission does

1. Checks: the wizard exists and is active; advisors-only needs a session; products must be in
   the wizard's catalog and active; quantity 1–9999; discounts and advisor lists only for a
   signed-in advisor, within the product rules.
2. Owner: the signed-in advisor (when `allowSignIn`), otherwise the assignment group.
   `enableLoadBalancing` off = a random active user; on = the next active user in list order,
   and the group's user list is rewritten (the chosen user moves to the end). No active user:
   the submission fails ("No active users found in the group." or "attempts exceeded").
3. Contact: reused when one with that e-mail exists in the owner's primary workspace (its
   owner and data are kept; the typed name and mobile are ignored). Otherwise created, owned by
   the deal's owner.
4. Deal: name, owner, contact, `proposalWizard` (the wizard's id), proposal with the quote
   (preset lines + chosen lines), layout, stage, dates, source. The deal's own recalculation
   then applies the account's pricing settings.
5. A short link `/r/<code>` to the proposal viewer, e-mailed to the visitor (always). The owner
   gets the "assigned to you" notice. Contact and deal webhooks and automations run.
6. Linked form: its fields are registered as a form submission. If the form is inactive,
   password-protected, or public with captcha on (the Form default), they are dropped silently.

The page's anonymous config and the anonymous response hold only public fields (no preset,
group, price sources or product costs).

## Diagnosis checklist (`doctor`)

| Code | Level | Meaning |
| --- | --- | --- |
| `emptyGroup`, `noActiveUsers`, `groupMissing` | error | Every anonymous submission fails. |
| `activeUnknown`, `unreadableUsers` | warning | Group users this profile cannot read; deals can still go to them. |
| `groupType` | warning | Group of another type. |
| `noProducts` | error | Nothing to choose; submissions answer 400. |
| `inactiveProducts`, `pricebookInactive`, `mixedCurrencies` | warning | Catalog surprises. |
| `advisorListsUnused`, `authWithoutSignIn` | warning | Settings that do nothing. |
| `formCaptcha`, `formInactive`, `formPassword`, `formMissing` | warning | Extra fields dropped. |
| `language`, `timeDiscountShort`, `termsEmpty` | warning | Page or discount surprises. |
| `inactiveSiblings` | warning | The page's switcher offers inactive wizards of the same group. |
| `pageFails`, `advisorsOnly`, `noCaptcha` | error / info | What the anonymous page answers. |

## Links

- Wizard: `https://<domain>/pw/<code>`. Group chooser: `https://<domain>/pwg/<groupCode>`.
- Per product: `?pbe=<entryId>[,<entryId>]`, plus `&avoidChangeProduct=true` to lock it. The
  entry must be in the wizard's catalog.
- Short link: a ShortUrl `{shortUrlCode, url}`; it answers at `https://<domain>/r/<code>` with
  a redirect. Short links are shared by the whole account and store the full address.
- QR image: `https://<domain>/v2/service/qrcode/?text=<url-encoded link>` (SVG).

## Permissions

Reading or changing wizards, wizard groups and user groups needs the ProposalWizard /
UserGroup permissions (admins). Sales roles get a 403. Short links need ShortUrl permissions.
The public page, its config and submissions need no login.
