# Prolibu CLI — agent guide

## Start with the skill for your task

Claude Code agents in this repo get these skills from [`.claude/skills/`](.claude/skills). Each
one is the procedure for its task, verified against the platform's code: use it instead of
working from memory or from the guide.

| Task | Skill |
|---|---|
| First step: connect to an account, check the API key, import an account repo, Prolibu MCP in Claude | [`prolibu-account-setup`](.claude/skills/prolibu-account-setup/SKILL.md) |
| Which object or skill fits a goal; any object without its own skill | [`prolibu-platform-map`](.claude/skills/prolibu-platform-map/SKILL.md) |
| Server-side code without an LLM: automations, record triggers, cron jobs | [`prolibu-scripts`](.claude/skills/prolibu-scripts/SKILL.md) |
| Host a static site or SPA on an account | [`prolibu-sites`](.claude/skills/prolibu-sites/SKILL.md) |
| Inbound HTTP endpoint or webhook receiver | [`prolibu-endpoints`](.claude/skills/prolibu-endpoints/SKILL.md) |
| Public form that creates records | [`prolibu-forms`](.claude/skills/prolibu-forms/SKILL.md) |
| Notify another system when records change | [`prolibu-webhooks`](.claude/skills/prolibu-webhooks/SKILL.md) |
| Store another system's id on a record (`refId` / `refUrl`) | [`prolibu-external-refs`](.claude/skills/prolibu-external-refs/SKILL.md) |
| Import contacts, companies or deals from CSV/Excel without duplicates; bulk edits; import results | [`prolibu-imports`](.claude/skills/prolibu-imports/SKILL.md) |
| Add fields to an object, or create a custom object | [`prolibu-custom-fields`](.claude/skills/prolibu-custom-fields/SKILL.md) |
| Catalog: products, price lists and prices, taxes, volume discounts, coupons; load a catalog from Excel | [`prolibu-catalog`](.claude/skills/prolibu-catalog/SKILL.md) |
| Add, change or remove products on a deal's quote | [`prolibu-quotes`](.claude/skills/prolibu-quotes/SKILL.md) |
| Set up a deal's proposal and template, its versions, contract templates and contracts ready for e-signature | [`prolibu-proposals`](.claude/skills/prolibu-proposals/SKILL.md) |
| A product picker or configurator inside the quote editor | [`prolibu-extended-quote-sites`](.claude/skills/prolibu-extended-quote-sites/SKILL.md) |
| Pipelines and stages: move a record, required fields | [`prolibu-stages`](.claude/skills/prolibu-stages/SKILL.md) |
| Tasks, notes, meetings and calls on a record; a record's activity history | [`prolibu-activities`](.claude/skills/prolibu-activities/SKILL.md) |
| Support tickets: open, assign, reply or note; case types, routing; articles and portal | [`prolibu-support`](.claude/skills/prolibu-support/SKILL.md) |
| E-mail templates with variables, contact lists and e-mail campaigns (test, launch, schedule) | [`prolibu-messaging`](.claude/skills/prolibu-messaging/SKILL.md) |
| Reports and dashboards: build, add pages, combine reports, goals vs. actuals, zeros | [`prolibu-dashboards`](.claude/skills/prolibu-dashboards/SKILL.md) |
| Native AI agents: instructions, model, skills, actions, scheduled and record-event triggers, runs and token cost | [`prolibu-ai-agents`](.claude/skills/prolibu-ai-agents/SKILL.md) |
| Virtual tours: create, upload scenes, update, download | [`prolibu-virtual-tours`](.claude/skills/prolibu-virtual-tours/SKILL.md) |
| Commercial exceptions and product rules: why a rule blocks a quote, request, approve or reject an exception, create or edit rules | [`prolibu-commercial-exceptions`](.claude/skills/prolibu-commercial-exceptions/SKILL.md) |
| Booking calendars: setup, free slots, book, move, cancel or confirm appointments, quote-booking diagnosis | [`prolibu-calendars`](.claude/skills/prolibu-calendars/SKILL.md) |
| Billing: invoice a deal or by hand, record or remove payments, emit or void, receivables | [`prolibu-billing`](.claude/skills/prolibu-billing/SKILL.md) |
| Send contracts for e-signature, follow and remind signers, withdraw, download signed PDFs | [`prolibu-contracts`](.claude/skills/prolibu-contracts/SKILL.md) |
| WhatsApp/SMS conversations: read and summarize, reply or send templates, assign, hand back to the AI agent, conversation flows as drafts | [`prolibu-conversations`](.claude/skills/prolibu-conversations/SKILL.md) |
| Leads: triage, assign by turns, convert without duplicates; follow-up protocols; sellers' goals | [`prolibu-leads`](.claude/skills/prolibu-leads/SKILL.md) |
| Scoring: explain a score, rules profiles (created inactive), activation, re-score of named records | [`prolibu-scoring`](.claude/skills/prolibu-scoring/SKILL.md) |
| Public self-service quoter (/pw): wizards, groups, assignment, links; diagnose missing quotes | [`prolibu-proposal-wizard`](.claude/skills/prolibu-proposal-wizard/SKILL.md) |
| Read-only diagnosis: script did not run, webhook, e-mail or notice not received, sign-in failures, who changed a record | [`prolibu-diagnostics`](.claude/skills/prolibu-diagnostics/SKILL.md) |
| Projects of tasks and work orders: create, status, reschedule | [`prolibu-projects`](.claude/skills/prolibu-projects/SKILL.md) |
| Ad leads: Ad Hubs, mirrored Meta forms, ad campaigns, lead routing and counts | [`prolibu-ads`](.claude/skills/prolibu-ads/SKILL.md) |
| Duplicate contacts and companies: find, merge, archive stale contacts | [`prolibu-data-cleanup`](.claude/skills/prolibu-data-cleanup/SKILL.md) |
| Read-only access review: roles, record rules, workspaces, who can see a record | [`prolibu-access-review`](.claude/skills/prolibu-access-review/SKILL.md) |
| Proposal and document designs, fonts, custom views, presentation views | [`prolibu-document-design`](.claude/skills/prolibu-document-design/SKILL.md) |
| Academy: courses and programs, enrollment, progress, certificates | [`prolibu-academy`](.claude/skills/prolibu-academy/SKILL.md) |
| Saved filters, default columns, menu links, row actions and widgets | [`prolibu-ui-customization`](.claude/skills/prolibu-ui-customization/SKILL.md) |
| Promote or compare configuration between accounts (dev to prod) without pushing profiles | [`prolibu-config-promotion`](.claude/skills/prolibu-config-promotion/SKILL.md) |
| Create a new skill, or rebuild one that does not work | [`prolibu-skill-creator`](.claude/skills/prolibu-skill-creator/SKILL.md) |

Every skill that writes to an account follows
[`_shared/WRITE-FLOW.md`](.claude/skills/_shared/WRITE-FLOW.md): read first, show a plain
summary, write only after an explicit yes, read back. Anything visual (a site, a picker, a form page) is built with Cobalt, the app's design
system ([`_shared/COBALT.md`](.claude/skills/_shared/COBALT.md)), to the design bar in
[`_shared/UI-QUALITY.md`](.claude/skills/_shared/UI-QUALITY.md), and checked with
`_shared/ui-review.js` and its screenshots before it is published. The API's own rules (filters with
`xquery`, populate depth, how `PATCH` merges) are in
[`api-conventions.md`](.claude/skills/prolibu-platform-map/references/api-conventions.md).

## Other references

| Need | Read |
|---|---|
| The platform explained for an outside integrator (no CLI) | [`docs/integrations-for-ai-agents/`](docs/integrations-for-ai-agents/README.md) |
| End-to-end, copy-pasteable integrations | [`12-integration-recipes.md`](docs/integrations-for-ai-agents/12-integration-recipes.md) |
| Virtual tours with this CLI | [`prolibu-virtual-tours`](.claude/skills/prolibu-virtual-tours/SKILL.md) (the section below is a command reference) |
| Everything else this CLI does | [`README.md`](README.md) |

---

# Virtual Tour (VT) Commands

CLI tool for managing Prolibu virtual tours. Supports two tour types: **Automotive** (car configurators with colors + external/internal scenes) and **Spaces** (real estate with panoramas + floor plans).

## Authentication

API key stored in `accounts/{domain}/profile.json`:

```json
{ "apiKey": "your-api-key-here" }
```

All API calls use `Authorization: Bearer {apiKey}` header against `https://{domain}/v2`.

Agents never read, copy or print that key. `.claude/settings.json` denies the Read tool on
`accounts/**/profile*.json`, and a Bash hook (`.claude/hooks/guard-account-keys.js`) refuses
commands that name a profile file, glob an account folder or pull `apiKey` out with inline
code. Call the API through `node .claude/skills/_shared/prolibu-api.js <domain> <METHOD> <path>`
or the skill's own script; they read the key themselves and never print it.

The `--apikey` flag overrides the stored key. If neither exists, the CLI prompts interactively.

## Commands

### `vt create`

Scaffold a new VT project workspace. No API calls — only creates local files.

```sh
./prolibu vt create --domain dev11.prolibu.com --prefix my-project --type automotive
```

Creates `accounts/{domain}/vt/{prefix}/` with template files and an `EXAMPLE_TOUR/` folder.

### `vt pull`

Download ALL virtual tours from an account. Aliases: `download-all`, `sync`.

```sh
./prolibu vt pull --domain dev11.prolibu.com --prefix my-project
```

Fetches every tour via the API and writes the full folder structure locally. Overwrites existing local files if the tour already exists locally.

### `vt push`

Push local changes to remote. Updates existing tours; creates new ones if not found.

```sh
./prolibu vt push --domain dev11.prolibu.com --prefix my-project
./prolibu vt push --domain dev11.prolibu.com --prefix my-project --tour BMW_X3
```

**Update strategy:** Finds existing tour by `_id` (from `_config.json`) or by `virtualTourCode` (folder name). If found: patches config, deletes old scenes/floorPlans, re-uploads new ones. If not found: creates the tour and saves `_id` back to `_config.json`.

### `vt bulk`

Create new tours in bulk. Always creates — never updates existing tours.

```sh
./prolibu vt bulk --domain dev11.prolibu.com --prefix my-project --type automotive
./prolibu vt bulk --domain dev11.prolibu.com --prefix my-project --watch
```

Runs in a forked child process. With `--watch`/`-w`, watches the virtualTours folder and re-uploads on changes.

### `vt download`

Download a single tour by ID.

```sh
./prolibu vt download --domain dev11.prolibu.com --prefix bmw --id 69416e08729e7ce2b7dca043
```

## Flags Reference

| Flag | Description | Default |
|------|-------------|---------|
| `--domain <domain>` | Prolibu domain (e.g. `dev11.prolibu.com`) | prompted |
| `--prefix <name>` | Project name (subfolder under `accounts/{domain}/vt/`) | prompted |
| `--apikey <key>` | API key override | from profile.json |
| `--folder <path>` | Path to virtualTours folder | `./virtualTours` |
| `--tour <name>` | Process only this tour (matches folder name) | all tours |
| `--id <id>` | VirtualTour MongoDB ID (for `download`) | — |
| `--type <type>` | `automotive` or `spaces` | `automotive` |
| `--watch`, `-w` | Watch mode (for `bulk`) | off |

## Folder Structure

After `vt pull` or manual creation:

```
accounts/{domain}/
├── profile.json                    # { "apiKey": "..." }
└── vt/{prefix}/
    ├── index.js                    # Bulk upload script (auto-synced from templates)
    ├── config.json                 # { "variables": [] }
    ├── settings.json               # { "virtualToursFolder": "./virtualTours" }
    ├── lib/
    └── virtualTours/
        └── {TOUR_CODE}/            # Folder name = virtualTourCode
            ├── _config.json        # Tour metadata and configuration
            │
            │  # Automotive type:
            ├── _colors/
            │   ├── external/       # Color texture images (one per color)
            │   └── internal/
            ├── external/
            │   └── {color-slug}/   # Scene images for this color
            └── internal/
                └── {color-slug}/
            │
            │  # Spaces type:
            ├── _floorplans/        # Floor plan images
            └── scenes/             # Scene images
```

## `_config.json` Format

### Minimal (for creating new tours)

**Automotive:**
```json
{
  "virtualTourName": "BMW X3 2025",
  "description": "Interactive configurator",
  "eventType": "Automotive",
  "config": {
    "theme": "flow"
  }
}
```

**Spaces:**
```json
{
  "virtualTourName": "Hotel Suite",
  "description": "Virtual walkthrough",
  "eventType": "Spaces",
  "config": {
    "theme": "cascade",
    "floorPlan": { "showOpened": true }
  }
}
```

### After pull (includes remote data)

A pulled `_config.json` includes `_id`, `virtualTourCode`, and the full `config` object with UI settings, camera, navigation, hotspots, etc. The `_id` field is critical — it links the local folder to the remote tour for `vt push` updates.

Key fields:
- `_id` — MongoDB ID. If present, `push` uses it to find the existing tour.
- `virtualTourCode` — Unique code. Fallback identifier if `_id` is missing.
- `virtualTourName` — Display name.
- `eventType` — `"Automotive"` or `"Spaces"`. Determines folder structure.
- `config.theme` — UI theme (`"flow"`, `"cascade"`, etc.).
- `config.ui` — Splash screen, watermark, fullscreen, buttons.
- `config.panorama` — Auto-rotate, tiny planet, speed.
- `config.camera` — FOV limits, zoom behavior.
- `config.sequence` — Drag, autoplay, zoom settings for sequences.

## Image Naming Conventions

File name prefixes determine the scene type:

| Prefix | Scene Type | Example |
|--------|-----------|---------|
| `2d_` | 2D flat image | `2d_front-view.webp` |
| `360_` | 360° panorama | `360_interior.webp` |
| `seq_` | Sequence frame (all `seq_` files in a folder = 1 scene) | `seq_001.webp`, `seq_002.webp`, ... |

**Rules:**
- The scene name is derived from the filename (without prefix and extension).
- For sequences, use zero-padded numbering: `seq_001`, `seq_002`, etc.
- Supported formats: `.webp`, `.png`, `.jpg`, `.jpeg`.
- Color texture files in `_colors/` have no prefix requirement — the filename becomes the color slug.
- Floor plan files in `_floorplans/` have no prefix — filename becomes the floor plan name.

## Workflow Recipes

> **Agents: use the [`prolibu-virtual-tours`](.claude/skills/prolibu-virtual-tours/SKILL.md) skill.**
> `vt push` on an existing tour deletes and re-creates every scene (hotspots, initial views,
> scene order and names made in the app are lost) and, for car tours, leaves the scenes
> without their color. The recipes below are the CLI's raw commands, not a safe procedure.

### Pull → Edit → Push (sync existing tours)

```sh
# 1. Download all tours
./prolibu vt pull --domain dev11.prolibu.com --prefix my-project

# 2. Edit _config.json, add/remove images, etc.
# (make changes locally)

# 3. Push changes back
./prolibu vt push --domain dev11.prolibu.com --prefix my-project
```

### Create a new tour from scratch

```sh
# 1. Create a folder with the tour code as name
mkdir -p accounts/dev11.prolibu.com/vt/my-project/virtualTours/NEW_TOUR

# 2. Add _config.json
cat > accounts/dev11.prolibu.com/vt/my-project/virtualTours/NEW_TOUR/_config.json << 'EOF'
{
  "virtualTourName": "New Tour",
  "description": "My new virtual tour",
  "eventType": "Automotive",
  "config": { "theme": "flow" }
}
EOF

# 3. Add scene images with correct prefixes
# Place in external/{color}/ or internal/{color}/ for automotive
# Place in scenes/ for spaces

# 4. Push to create remotely
./prolibu vt push --domain dev11.prolibu.com --prefix my-project --tour NEW_TOUR
```

### Batch config update

```sh
# 1. Pull current state
./prolibu vt pull --domain dev11.prolibu.com --prefix my-project

# 2. Edit _config.json in multiple tour folders
# (e.g., change theme, enable splash screen, update descriptions)

# 3. Push all changes
./prolibu vt push --domain dev11.prolibu.com --prefix my-project
```

### Duplicate and modify a tour

```sh
# 1. Copy an existing tour folder
cp -r accounts/dev11.prolibu.com/vt/project/virtualTours/BMW_X3 \
      accounts/dev11.prolibu.com/vt/project/virtualTours/BMW_X5

# 2. Edit the new _config.json:
#    - Remove "_id" (so push creates a new tour instead of updating the original)
#    - Change "virtualTourName"
#    - Optionally change "virtualTourCode" or let it use the folder name

# 3. Replace/add scene images as needed

# 4. Push only the new tour
./prolibu vt push --domain dev11.prolibu.com --prefix project --tour BMW_X5
```

## Important Notes

- `vt push` is **not** safe to repeat on a tour edited in the app: it deletes all existing scenes/floorPlans (and the app work on them) and re-uploads from local files; car tours lose their colors. Image ordering depends on filesystem order. Preview it with the `prolibu-virtual-tours` skill.
- `vt bulk` always creates new tours. Use `vt push` for upsert behavior.
- The folder name becomes the `virtualTourCode` if not specified in `_config.json`.
- `_id` in `_config.json` is written automatically by `pull` and `push` (after first create). Do not fabricate it.
- The `--tour` flag matches against the folder name (which equals the tour code).
