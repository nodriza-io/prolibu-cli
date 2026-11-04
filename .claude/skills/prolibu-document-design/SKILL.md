---
name: prolibu-document-design
description: Work with Prolibu's proposal and document designs the way the app does — find which template a proposal or presentation uses and everything else that uses it (deals, presentations, campaigns, wizards, products), duplicate a template before changing it, rename it, switch it off, change its language, fonts or Meta pixel, make a layout the default, create an empty template or snippet for the visual editor, upload a font file, save custom-view presets for sharing a proposal, and read who viewed a presentation and when it expires. Design itself (pages, text, images) is made in the app's visual editor; this skill says exactly what to do there. Use it whenever someone asks which template a proposal uses, wants to copy or change a template for another brand, add a font, make a snippet, hide parts of a shared proposal, or asks who opened a presentation. Spanish triggers: "qué plantilla usa", "duplica la plantilla", "plantilla de propuesta", "layout por defecto", "crea un snippet", "sube esta fuente", "fuente de la plantilla", "vista personalizada", "oculta las notas", "quién vio la presentación", "cuándo vence la presentación".
---

# Prolibu Document Design

## Central idea

A **ContentTemplate** is a design made in the app's visual editor. Its type says where it is
used: `layout` (the whole proposal or presentation), `content` (pages inserted into a
proposal), `snippet` (a block attached to a product, family or group, printed with each line),
`certificate`. The editor produces the design (`pages`) and its rendering (`html`) together;
the API cannot make or edit a design. **A template in use is shared:** fonts, language, the
Meta pixel and editor switches of a layout, and every part of a snippet, are read live on each
view, so a change reaches proposals already sent. Change a copy unless the user wants every
proposal to change.

Around it: **Font** (a font file for the editors, by `fontCode`), **CustomView** (a saved
preset for the app's Share → Custom view), **Presentation** (a layout sent to one contact,
with view tracking and an expiry), **Plugin** (developer packages, list only) and **Template**
(system pages and notification e-mails, list only).

`scripts/design.js` does the fragile parts: it lists every use of a template before a change,
refuses design fields, checks fonts and names exist, copies a template whole, validates font
files by content, defaults custom views to hiding internal notes, and reads every write back.

```
node .claude/skills/prolibu-document-design/scripts/design.js <command> <domain> …
  templates <domain> [name] [--type layout|content|snippet|certificate]
  show <domain> <template id|code|name>     summary, uses, what a change reaches, version
  default-layout <domain>                   the layout this key's user starts proposals with
  fonts <domain> [name]   views <domain>   plugins <domain>   system-templates <domain>
  presentations <domain> [title] [--contact <e-mail|id>]
  presentation <domain> <id|code>           each view (who, when, how long, device, city), expiry
  preview <domain> '<plan json>'            writes nothing; returns a version
  apply   <domain> '<plan json>' --version <v> --confirmed
```

Output is JSON. Exit codes: 0 ok, 1 API error, 2 usage error (nothing sent), 3 blocked
(nothing written). Every command takes `--profile <name>`.

## Ask the user first

1. **Which account**, if `accounts/` has several domains.
2. **Which template:** a name is enough (`templates <domain> "<part of the name>"`). For "which
   template does this deal use", `prolibu-proposals show` gives the deal's layout id.
3. **Change the original or a copy?** Default: a copy, whenever `show` lists any use.
4. **For a copy:** its name (the brand, e.g. "Propuesta — Marca X") and language.
5. **For a font:** the file path and the name to show in the editors (cannot change later).
6. **For a custom view:** which parts the client sees: agent card, quote, special notes,
   snippets, internal notes (default off), and product groups or families to keep.

## Steps

1. **Read.** `show <domain> <template>`: tell the user the type, language, fonts, whether it
   is a default layout, and `uses` with the sample names. A `count: null` means unknown: say so.
2. **Plan.** One plan per write:

   | Want | Plan |
   | --- | --- |
   | Copy a template | `{"kind":"duplicate","from":"<id or code>","name":"…","language":"es"}` |
   | Rename, switch off, language, fonts, pixel | `{"kind":"edit","id":"…","set":{"name":"…","active":false,"language":"en","defaultFont":"<fontCode>","secondaryFont":"<fontCode>","embeddedFonts":["<fontCode>"],"metaPixelId":"123…"}}` |
   | Default layout | `{"kind":"default","id":"…","origin":"Global Layout"}`, `"User Company"` + `"company"`, `"User Primary Workspace"` + `"workspace"`; `"origin":null` stops it |
   | Empty template for the editor | `{"kind":"create","templateType":"snippet","name":"…","language":"es"}` |
   | Upload a font | `{"kind":"font","name":"…","file":"/path/font.woff2"}` |
   | Custom view preset | `{"kind":"view","name":"…","display":{"quote":false,"internalNotes":false,"productFamilies":["<name>"]}}`; add `"id"` to change one |

   - `embeddedFonts` replaces the whole list: include the codes that must stay (older
     templates hold file ids there; keep them as they are, the editor still reads them).
   - `metaPixelId`: digits only, layouts only; `null` removes it.
3. **Preview.** Tell the user `changes`, every `warning`, `uses` and `reach` in plain words.
   A `blocker` means stop and explain it.
4. **Stop and wait for an explicit yes**, even if the request already said "do it". An edit
   of a template in use, a default layout change and a font upload each need their own yes.
5. **Write.** `apply` with the same plan, `--version` and `--confirmed`. It refuses when
   anything changed since the preview.
6. **Report** ids, names and `problems`. For templates give the preview path
   (`https://<domain>` + `previewPath`, opened while signed in) and say what is left for the
   editor (below).

**What only the visual editor does.** Text, images, tables, page layout and which font each
text uses. Tell the user: open the app → Templates, open the template, edit, save. For "a
snippet with the commercial terms": create it empty here, then give the user the terms as plain
text to paste in the editor; then it is attached to products, families or groups in the app
(the product's Snippets field).

## How the platform behaves

Details and evidence are in `references/design-model.md`.

- **Deals keep a copy of the layout's design** from when the layout was picked; a new design
  reaches a deal only when the layout is picked again. Fonts, language, the agent card switch,
  the template script and the pixel are read live from the layout.
- **Snippets are read live** on every view of every proposal with a product, family or group
  that carries them. **Content** is copied into the proposal when inserted.
- **Presentations, campaign landings and proposal wizards** use their layout live.
- **One default layout per scope** (global, a company, a workspace). Order: the user's own,
  their workspace's, their company's, the global one. A default layout cannot be deleted.
- **Fonts:** names are unique and cannot be changed. The server checks only the file name's
  extension; the script also checks the content and a 5 MB limit. Every user can use a font.
- **Custom views** are only presets. The shared link carries the settings in its address, so
  changing a preset does not change links already sent, and the reader can edit the address.
  The platform's own default shows internal notes; the script defaults them to off.
- **Presentations:** the expiry is shown to the reader, but the server keeps serving them. Who
  may read presentations depends on the role (a seller usually gets a 403).

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| Changed a layout but the deal still shows the old design | Deals keep a copy | Pick the layout again on the deal (`prolibu-proposals`) |
| A font or pixel change appeared on proposals already sent | Read live from the layout | Duplicate first next time; edit back if needed |
| "template does not found" in the preview | Template has no design yet | Open it in the editor and save |
| "Only one default … is allowed" | Scope already has a default | `default` with `origin: null` on the holder first |
| "A font with the same name already exists" | Names are unique | Another name, or use the existing font |
| Client saw internal notes | Shared with a view that shows them | New link with a view that hides them |

## Verify

- `apply` reads every write back and lists any field that did not save under `problems`.
- After a duplicate, open the copy's preview path and compare it with the original.

## Don't

- Write `pages`, `html`, `codes`, `meta` or `assets`, or change `templateType`.
- Edit a template in use when a copy would do, or change a default layout without its own yes.
- Create, send or update presentations, open presentation or proposal links, or share them:
  opening one as the contact counts as their view and notifies the seller. Campaigns that
  send presentations belong to `prolibu-messaging`.
- Publish a template in the public library (`library`): it copies a deal's data into a public
  preview. Plugins and system templates are listed only.
- Delete templates or fonts here; deletions are made in the app.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md). A `403` means
the profile's user may not do that: stop and say so; never retry another way or with another
profile. A deal's proposal, its versions and contract templates: `prolibu-proposals`. E-mail
templates (MessageTemplate) and campaigns: `prolibu-messaging`.
