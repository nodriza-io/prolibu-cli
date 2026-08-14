# Prolibu CLI — agent guide

## Documentation map

Read the document that covers your task before writing code. Each one is a verified reference;
none of it should be reconstructed from memory.

| Task | Read |
|---|---|
| Anything about the platform's API, objects, auth, permissions | [`docs/integrations-for-ai-agents/`](docs/integrations-for-ai-agents/README.md) — start at its index |
| Host a static site or SPA on an account | [`07-sites-forms-and-endpoints.md` §3](docs/integrations-for-ai-agents/07-sites-forms-and-endpoints.md#3-hosted-sites) |
| Public form that creates records | [`07-sites-forms-and-endpoints.md` §2](docs/integrations-for-ai-agents/07-sites-forms-and-endpoints.md#2-web-to-lead-forms) |
| Inbound HTTP endpoint or webhook receiver | [`07-sites-forms-and-endpoints.md` §1](docs/integrations-for-ai-agents/07-sites-forms-and-endpoints.md#1-custom-endpoints--inbound-http) |
| Server-side automation, triggers, cron jobs | [`05-automation-and-scripts.md`](docs/integrations-for-ai-agents/05-automation-and-scripts.md) |
| End-to-end, copy-pasteable integrations | [`12-integration-recipes.md`](docs/integrations-for-ai-agents/12-integration-recipes.md) |
| Build/deploy sites, scripts and virtual tours with this CLI | [`README.md`](README.md) |

Claude Code agents working inside this repo also get these as skills in
[`.claude/skills/`](.claude/skills) (`prolibu-sites`, `prolibu-scripts`, `prolibu-endpoints`),
which route to the same references.

---

# Virtual Tour (VT) Commands

CLI tool for managing Prolibu virtual tours. Supports two tour types: **Automotive** (car configurators with colors + external/internal scenes) and **Spaces** (real estate with panoramas + floor plans).

## Authentication

API key stored in `accounts/{domain}/profile.json`:

```json
{ "apiKey": "your-api-key-here" }
```

All API calls use `Authorization: Bearer {apiKey}` header against `https://{domain}/v2`.

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

- `vt push` is idempotent for updates — it deletes all existing scenes/floorPlans and re-uploads from local files. Image ordering depends on filesystem order.
- `vt bulk` always creates new tours. Use `vt push` for upsert behavior.
- The folder name becomes the `virtualTourCode` if not specified in `_config.json`.
- `_id` in `_config.json` is written automatically by `pull` and `push` (after first create). Do not fabricate it.
- The `--tour` flag matches against the folder name (which equals the tour code).
