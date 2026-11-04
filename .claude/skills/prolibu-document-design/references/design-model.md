# Document design objects: how the platform behaves

Verified against the backend, the app and live reads on a test account. Read it when a case
falls outside the steps in `SKILL.md`.

## ContentTemplate

| Field | Meaning |
| --- | --- |
| `contentTemplateName`, `contentTemplateCode` | Name (required) and code (generated, usable in the URL instead of the id) |
| `templateType` | `layout`, `content`, `snippet`, `certificate`, `customView` (default `content`) |
| `pages` | The editor's design tree. Only the visual editor writes it |
| `html` | The rendering the editor saves with the pages. Empty = blank document |
| `codes`, `meta`, `assets` | Editor output: code blocks, switches (agent card…), uploaded images (File ids) |
| `defaultFont`, `secondaryFont`, `embeddedFonts` | Font codes (`Font.fontCode`). Older templates hold File ids in `embeddedFonts`; both are read |
| `taxonomy.language` | Two-letter language. With a language, snippets in another language are skipped in the document |
| `defaultLayout.origin` | `Global Layout`, `User Company` (+ `company`), `User Primary Workspace` (+ `primaryWorkspace`) |
| `retargeting.metaPixelId` | Layouts only. 5–20 digits, else `400 Invalid Meta Pixel ID` |
| `library.publish`, `library.deal`, `library.previewData` | Public library. Picking a deal copies that deal's data into `previewData` |
| `active`, `tags`, `assignee`, `collaborators`, `allowEveryone` | Usual record fields |

Rules on save:

- **Default layout:** one per workspace, per company and one global. A second one answers
  `Only one default layout per workspace/company is allowed` / `Only one default global layout
  is allowed`. Origin without its company/workspace answers `Company is required…`. Sending
  `origin: null` clears the whole block. A default layout cannot be deleted.
- **Default lookup** for a user (`GET /v2/contenttemplate/defaultLayout`): the user's own
  `defaultLayout`, then their primary workspace's, then their company's, then the global one;
  404 when none.
- **Deal save:** when a deal's proposal gets a layout id without html, the server copies the
  layout's `html` into the deal (`proposal.template.layoutHtml`). Without a layout it picks a
  product's layout or the user's default. The copy is not refreshed later.
- **Render (each view):** the viewer loads the layout by id and takes `taxonomy.language`,
  `defaultFont`, `embeddedFonts`, `codes`, `meta`, `templateScript` and `retargeting` from it
  live; it uses the deal's `layoutHtml` copy, regenerating it from the layout only when the
  copy is missing. Snippets on line items, families and groups are loaded live by id; the copy
  stored on the deal is used only when the template was deleted. Presentations have no copy.
- **Fonts in a document** are resolved by `fontCode` on every view.

Where a template is referenced (what `show` counts):

| Type | Referenced from |
| --- | --- |
| layout | `Deal.proposal.template.layout`, `Presentation.layout`, `MessageTemplate.presentation.layout`, `EmailCampaign.presentation.layout`, `ProposalWizard.proposalPreset.layout`, default layout |
| snippet | `Product.snippets`, `ProductFamily.snippets`, `ProductGroup.snippets` (and copied onto deal line items) |
| content | copied into `Deal.proposal.template.customContent` when inserted; no reference kept |

A filter on a field the server does not know is dropped silently and the list returns every
record (for example a filter on line-item snippets inside deals). The script counts only when
the server echoes the filter back; otherwise it reports the count as unknown.

## Duplicating

The app's Clone (templates list) creates the copy through the normal create and uploads the
images again as new files, then rewrites the image addresses inside the pages. The script
copies `templateType`, `pages`, `html`, `codes`, `meta`, `assets`, fonts, language and `active`
in one create, so the copy renders the same at once, but it points to the same image files.
Not copied: default-layout status (unique per scope), library publication (deal data) and the
Meta pixel (belongs to one brand). Names are not unique on the server; the script blocks a
name that already exists so a second apply cannot make a second copy.

## Font

`fontName` (required, unique, cannot change after create), `fontCode` (`FNT-…`), `fontFile`
(File, required). Upload is `POST /v2/font` as multipart with `fontName` and the file in
`fontFile`. The server checks only that the uploaded file's name ends in `ttf`, `otf`, `woff`
or `woff2` and sets no size limit for it; a body that names an existing File id skips even that.
After save the file is renamed to the font code. Fonts are visible to every user by default.

## CustomView

`customViewName`, `customViewCode` (`CVI-…`), `display`: `agentCard`, `quote`,
`internalNotes`, `specialNotes`, `snippets` (booleans, all default `true` in the platform) and
`productGroups` / `productFamilies` (ids; empty = all).

The app's Share → Custom view loads a preset, lets the seller toggle it, and builds an
anonymous link with those settings: `quote: false` drops the quote, `snippets: false` the
snippets, `agentCard: false` the agent card, group/family lists keep only those lines.
**Presets show internal notes by default: turn `internalNotes` off before a link goes to a
customer** (the script creates presets with it off). Editing a preset does not change links
already sent.

## Presentation

`title` (default "Untitled Presentation (date)"), `contact` (required), `layout` (required,
type layout), `assignee`, `collaborators`, `expirationDate`, `emailCampaign` (set by the
platform), `tracking`: `totalViews`, `lastSeenAt`, `engagement`, `views[]` (each with the
viewer contact, open and last-seen times, duration in ms, returns, device, place, IP, network
provider). E-mail campaigns create presentations on the fly when a recipient opens the link.
Saving one notifies its assignee and new collaborators; a tracked view notifies the owner.
The expiry date is not checked by the server when serving the presentation.

## Plugin and Template

- **Plugin:** `pluginName`, `pluginCode`, `version`, `active`, `package` (zip with
  `<pluginCode>.js`), `optionsSchema`. Saving a package unzips it into a public folder;
  switching `active` makes that folder public or private. Developer work; list only.
- **Template:** system pages, notification e-mails and vCards. Rendering looks for a file
  shipped with the platform by name first; a stored record is used only when asked for by its
  id. Admin-only on most accounts.

## Permissions seen on a test account

| Object | Admin | Seller profile |
| --- | --- | --- |
| ContentTemplate | all | create; reads only its own and shared ones (403 on others) |
| Font | all | create (every user may add account-wide fonts) |
| CustomView | all | create its own |
| Presentation | all (this skill only reads) | 403 |
| Plugin | all (this skill only lists) | list answers empty |
| Template | all (this skill only lists) | 403 |

Roles differ per account: trust the 403, not this table.
