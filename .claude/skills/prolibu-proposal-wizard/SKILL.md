---
name: prolibu-proposal-wizard
description: Create, configure, publish and diagnose Prolibu proposal wizards (the public quote page /pw/<code>, "Asistente de propuestas") the way the app does it — the catalog it offers, who receives each quote (a "Proposal Wizard" user group, random or round-robin), the fields asked, the deal it creates, per-product links, short links and the page's public headers. Use it whenever someone wants an online quote form or price calculator for customers, a link or QR per product, to change who receives the wizard's quotes, or reports that a visitor's quote never arrived, went to the wrong seller or came out with wrong prices. Spanish triggers: "cotizador en línea", "asistente de propuestas", "wizard de propuestas", "link del cotizador", "QR por producto", "la cotización no le llegó al vendedor", "el wizard no asigna", "precios distintos en el cotizador".
---

# Prolibu Proposal Wizard

## Central idea

A **ProposalWizard** is a public page, `https://<domain>/pw/<proposalWizardCode>`. A visitor
picks products from the wizard's catalog and types an e-mail and a name. Each submission
creates a **contact** (or reuses one), a **deal** with a quote, and a short link. It also
e-mails the visitor and notifies the deal's owner. The owner comes from the wizard's
**assignment group**: a random active user, or round-robin when the group has load
balancing on. A signed-in advisor gets the deal instead, when the wizard allows sign-in.

Four traps break wizards without any error:

- **A new wizard is live at once.** `active` defaults to true.
- **A group with no active user loses the visitor's quote.** The submission fails after the
  visitor filled everything in.
- **No products means every submission fails** (400). It also fails when the products are
  inactive.
- **Extra fields vanish.** A linked Form with its captcha on (the Form default) drops them
  silently. The deal is still created.

`scripts/wizard.js` handles these in code. It always creates wizards unpublished, and makes
publishing its own step. It checks the group's active users, the catalog and the form before
writing, and reads everything back. It never submits the public form. A submission creates
records and e-mails whatever address is typed.

```
node .claude/skills/prolibu-proposal-wizard/scripts/wizard.js <command> <domain> …
  list | show <wizard> | doctor <wizard> | links <wizard> [--lock] | public-check <wizard>
  deals <wizard> [--since YYYY-MM-DD] [--email <visitor>] [--limit <n>]
  preview-create '<plan>'                → create '<plan>' --version <v> --confirmed
  preview-update <wizard> '<plan>'       → update <wizard> '<plan>' --version <v> --confirmed
  preview-publish <wizard>               → publish <wizard> --version <v> --confirmed
  preview-unpublish <wizard>             → unpublish <wizard> --version <v> --confirmed
  preview-group '<plan>'                 → group '<plan>' --version <v> --confirmed
  preview-shortlink <wizard> '<plan>'    → shortlink <wizard> '<plan>' --version <v> --confirmed
```

`<wizard>` is the code (the end of the link) or the id. Output is JSON. Exit codes: 0 ok,
1 API error, 2 usage error (nothing sent), 3 blocked (nothing written). Plans go inline in
single quotes, or as the path of a temp file. Add `--profile <name>` to use another user's key.

## Ask the user first

1. **Which account**, if `accounts/` has several domains. Create or change? Which wizard?
2. **Catalog:** one price list (all its active products), loose entries, or both. Advisor price
   lists only work when advisors sign in.
3. **Who receives the quotes:** an existing "Proposal Wizard" group (show its users and who is
   active) or a new one by e-mail. Random or round-robin.
4. **What is asked:** e-mail always; first name, last name, mobile, company, observations. Terms
   text or link.
5. **Who can use it:** anyone, anyone plus signed-in advisors, or advisors only.
6. **The deal:** proposal title (required), stage, layout template, days until it expires.
7. **Page:** language (`es`, `en` or `pt`; others show Spanish), title, subtitle, button text.
8. **Publish now or later.** Recommend later: test it first in a private window with the
   user's own e-mail.
9. **For a diagnosis:** the visitor's e-mail, the date, and which seller expected the quote.

## Steps

**Create a wizard.**

1. Run `list` to see existing wizards. Check the group with `preview-group` (no write), or
   create one (below).
2. Write the plan. Names are resolved on the server; an unknown or repeated name blocks.

   ```json
   {"set": {"proposalWizardName": "Fair 2026", "assignmentGroup": "<group name or id>",
     "proposalPreset": {"title": "Your quote", "layout": "<layout name>", "expirationDays": 15},
     "lineItemsSource": {"pricebook": "<price list name>", "pricebookEntries": ["<entry id>"]},
     "contactFields": {"firstName": true, "lastName": true, "mobile": true, "companyName": false},
     "dealFields": {"observations": true}, "allowMultipleLineItems": true, "language": "es",
     "displaySettings": {"title": "Get a quote", "subtitle": "<p>…</p>", "submitButtonText": "Send"}}}
   ```

   Other fields: `allowSignIn`, `requireAuthentication`, `lineItemsSource.advisorPricebooks`,
   `proposalPreset.stage`, `proposalPreset.timeSensitiveDiscounts` (`time` in
   **milliseconds**), `termsAndConditions`, `appearance`, `form`, `wizardGroup`. Never `active`
   or `proposalWizardCode`.
3. Run `preview-create`. Tell the user the products offered, the group and how it assigns,
   every warning and blocker. Stop and wait for a yes.
4. Run `create`. It is created **unpublished**. Give the code and the link.
5. Run `doctor`, then `preview-publish`. Publishing is its own yes. After `publish`, suggest a
   test in a private window with the user's own e-mail.

Talk to the user in their language (Spanish when they write in Spanish), also after the write;
the script's English output is for you, not for them.

**Change a wizard.** `preview-update <wizard> '{"set": {…}}'`. Nested objects merge with what is
stored; lists (`pricebookEntries`, `advisorPricebooks`, preset lines) replace the stored list.
A published wizard changes for visitors at once. Changing `proposalWizardCode` changes the
link and breaks shared links, QRs and short links: it needs `--rename-link` after its own yes.

**Assignment group.** Plan: `{"name": "…", "emails": ["…"], "roundRobin": true}`, or
`{"group": "<id or name>", "emails": […]}` to replace the users of an existing group. The
preview shows each user and whether they are active, and which wizards use the group.
Only "Proposal Wizard" groups are created or edited.

**Links and QR.** `links <wizard>` builds the link and one link per product (`?pbe=<entry>`;
`--lock` adds `avoidChangeProduct=true`). Nothing is written. A short link is optional:
`preview-shortlink <wizard> '{"code": "fair-coffee", "pbe": ["<entry>"], "lock": true}'`.
Existing short links are listed for reuse and never deleted. The `qrImage` URL draws the QR.

**Diagnose.** Run `doctor <wizard>`, then `deals <wizard> --since <date> [--email <visitor>]`.
Explain each finding in plain words:

- No deal and no contact: the submission failed. Check for a group with no active user, no
  products, a wizard not published, or a page restricted to advisors.
- Wrong seller: a signed-in advisor took it, or random assignment. `contactOwnerDiffers` means
  an existing contact kept its owner. `readable: false` means a user this profile cannot see.
- Wrong prices: `priceChanged` (the list changed since), lines without an entry (preset lines,
  or a charge the account adds), the time-sensitive discount override, an advisor price list.
  Price fixes belong to **prolibu-catalog**. To put, change or remove a discount that expires
  on a proposal that already exists, use **prolibu-quotes**.
- `twins`: the same visitor twice within a minute (double submit).

**Public page check.** `public-check <wizard>` reads the page as an anonymous visitor, without
any key. It reports indexing headers, captcha, and the fields the anonymous page gets. Headers
and captcha are account settings an admin changes; this skill only reports them.

## How the platform behaves

Evidence and edge cases are in `references/wizard-model.md`.

- **Each submission e-mails the address typed** (a link to the proposal) and notifies the deal's
  owner. Without a captcha (no Cloudflare credential), anyone can submit any e-mail.
- **Contact reuse:** same e-mail in the owner's workspace → the contact is reused, keeps its
  owner and its data. Another workspace → a second contact.
- **Round-robin rewrites the group** on every submission (the chosen user moves to the end).
- **The group type is not checked.** A group of another type works but is hidden in the app's
  picker, and other features may use it. `doctor` flags it.
- **Advisor mode:** with `allowSignIn`, a signed-in advisor gets the deal. Advisors can pick
  advisor price lists and give discounts up to the product rules.
- **Wizard groups** (`/pwg/<code>`) list the member wizards. The page's switcher also shows
  inactive ones.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| Visitor submitted, nothing arrived | Group with no active user, no products, or unpublished | `doctor`; fix the group or catalog |
| Quote went to an unexpected seller | Advisor session, random assignment, or contact owner | `deals`; explain `assignment` and `contactOwnerDiffers` |
| Extra form fields missing | Linked Form with captcha on, inactive or password | Turn the form's captcha off (prolibu-forms) |
| Page in Spanish | Language not es/en/pt | Set `language` to es, en or pt |
| Discount ends instantly | `timeSensitiveDiscounts.time` typed in minutes | Use milliseconds (1 hour = 3600000) |
| Old link or QR stopped working | Code changed, wizard unpublished or deleted | `links`; republish or restore the code |
| Two deals for one visitor | Double submit | `deals` shows `twins` |

## Verify

- `create`, `update` and `group` read the record back and list fields that did not save.
- `publish` and `unpublish` check the anonymous page answers 200 or "not active".
- `shortlink` reads the short link back. The link redirects to the wizard.

## Don't

- Submit the public form yourself (`/v2/proposalwizard/generate`), even "as a test". It creates
  a contact and a deal and e-mails the address. The user tests in a browser with their own e-mail.
- Create a wizard published, or publish without its own yes.
- Delete wizards, groups or short links, or edit a group of another type.
- Share links that carry `apiKey`: they hold a session.
- Change users, roles, credentials or account security settings (never list).

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. Each `preview-*` is the summary step. A
`403` means the profile's user may not see or change wizards (sales roles usually cannot): stop
and say so, never retry it another way or with another profile. Products and prices:
**prolibu-catalog**. The deal's quote: **prolibu-quotes**. The linked form: **prolibu-forms**.
Moving the deal: **prolibu-stages**. For objects and how they relate, see `prolibu-platform-map`.
