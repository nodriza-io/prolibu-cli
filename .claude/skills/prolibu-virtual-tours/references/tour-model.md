# Virtual tours: the model, the CLI and the app

Read this when a case falls outside the steps in `SKILL.md`. Each rule was checked against the
platform's code, the app's tour editor and viewer, and live calls on a test account. Rules marked
"code only" were not run live.

## The records

| Object | API path | What matters |
| --- | --- | --- |
| `VirtualTour` | `/v2/virtualtour` | `virtualTourName` (required), `virtualTourCode` (unique; a random `VIRTUALTOUR-…` when not given), `description`, `eventType` (`Automotive` or `Spaces`), `config`, `scenes` (ordered ids), `floorPlans` (ordered ids), `thumbnail` |
| `Scene` | `/v2/scene` | `sceneName`, `sceneType` (`2d`, `360`, `sequence`; default `360`), `automotiveType` (`external`, `internal`, `details`, `imperfections`, `engine`), `automotiveColor` (text: the color image's `_id`), `media` (ordered image ids, 50 MB each), `thumbnail`, `camera` (initial view), `spots` |
| `FloorPlan` | `/v2/floorplan` | `floorPlanName`, `media` (one image), `spots` |
| `Spot` | `/v2/spot` | a hotspot: `type` (`navigation`, `info`, `media`, `link`, `audio`), `targetScene` for navigation, `position` or `keyframes`, `origin` (`{modelName, docId}` of its scene or floor plan) |

- `config` is a nested object, not a free-form field. A `PATCH` merges it key by key.
  - Unknown keys are dropped silently. The CLI's `navigation` block for Spaces is one of them.
  - `config.theme` must be `modern`, `flow`, `cascade` or `classic`. Anything else answers 400.
  - The other groups are `ui` (fullscreen, ribbon, splash, share button, live button,
    watermark), `floorPlan`, `hotspots`, `panorama`, `camera`, `sequence` and `customCode`.
- `config.automotiveColors.external` and `.internal` are arrays of File ids. A color File's
  `meta` is `{id, name, hex, code, type: "automotive-color"}`.
  - The app keeps `meta.id` stable across new versions of a color, and re-points scenes by it.
  - The viewer shows a swatch only for colors that some scene points to.
  - A scene with no color shows under every color.
- Nothing cascades.
  - Deleting a tour leaves its scenes.
  - Deleting a scene deletes its own images, but leaves its hotspots and any navigation
    hotspot pointing to it.
  - The app's editor deletes a scene's hotspots first. It only unlinks a scene that another
    (cloned) tour also uses.
- Creating a `Spot` with `origin` adds it to that scene's `spots` (checked live).
- `thumbnail` is not set by the CLI or by the app's editor. A pushed tour has none (checked
  live).
- `GET /v2/virtualTour/view/<id>` is public (no key) and returns the tour fully filled in:
  - colors, scenes with their media and hotspots, floor plans;
  - `config.ui.splash.image` and `config.ui.watermark.image` as whole file objects.

  The viewer at `https://<domain>/ui/spa/virtualTour/view/<id>` reads it. A `#<sceneCode>`
  or `#<scene _id>` at the end opens on that scene. Otherwise the tour opens on the first
  scene; in a car tour, on the first `external` scene.
- The app's editor lives at `/ui/spa/stg/virtualTours/<id>` (new suite) or
  `/ui/spa/suite/virtualTours` (classic suite).

## What each CLI command does

Every `vt` command reads the key from `accounts/<domain>/profile.json`, and asks for anything
missing. With no terminal, a prompt either waits or exits with code 130.

| Command | Non-interactive form | Prompts when missing | Writes to the account |
| --- | --- | --- | --- |
| `vt create` | `--domain <d> --prefix <p> --type automotive\|spaces` | domain, key (no profile), prefix, type, and "delete the existing folder?" when the prefix folder is not empty | No. Writes `accounts/<d>/vt/<p>/` with templates and an `EXAMPLE_TOUR`, and rewrites `profile.json` as `{apiKey}` |
| `vt push` | `--domain <d> --prefix <p> --tour <folder>` | domain, prefix, key | Yes: see below. Without `--tour` it processes every folder |
| `vt pull` (alias `download-all`, `sync`) | `--domain <d> --prefix <p>` | domain, prefix (default `all`), key | No. Downloads every tour (one page of up to 500) |
| `vt download` | `--domain <d> --prefix <p> --id <id>` | domain, prefix, id, key | No |
| `vt bulk` | `--domain <d> --prefix <p> --type …` | domain, prefix, type | Yes: always creates. `--watch` keeps running |

### `vt push`, step by step (code and live)

1. **Read the folder.**
   - `_config.json` holding invalid JSON is read as empty, without a word.
   - The type comes from `eventType`: `Spaces` or, by default, Automotive. `--type` overrides
     it.
2. **Find the tour.**
   - First `GET /v2/virtualTour/view/<_id>`. Any error moves on to the next try.
   - Then the list filtered by `virtualTourCode` = `_config.virtualTourCode` or the folder name.
3. **Update path.**
   1. `PATCH` the name and description (when set), and `config` = CLI defaults + the folder's
      `config`, merged one level deep. Only when `config` exists in the file.
   2. `DELETE` every scene. In Spaces, `DELETE` every floor plan too.
   3. Upload colors (Automotive):
      - Each `_colors/<side>/<slug>.<ext>` goes to `POST /v2/file`, with
        `filePath .api/VirtualTour/<id>/config.automotiveColors.<side>/<slug>.<ext>`.
      - `meta.name` is built from the slug, `meta.hex` is `#000000`, `meta.code` is the
        upper-case slug.
      - A path already used by the same user answers 400 (the file exists). The CLI prints
        "Color upload failed" and carries on.
      - Only when some color uploaded does it set `config.automotiveColors` to the colors
        uploaded **this time**. Colors that failed then leave the tour.
   4. Create the scenes:
      - one multipart `POST /v2/scene/` each (`sceneName`, `sceneType`, `automotiveType`,
        `automotiveColor`, `media` files);
      - `automotiveColor` is the uploaded color's id, or the text `null`, which the server
        stores as empty;
      - then `PATCH scenes` with the new ids. A scene that fails is skipped, with a message.
   5. Spaces: create the floor plans the same way, then `PATCH floorPlans`.
   6. It prints "Updated" and exits 0 even when some uploads failed.
4. **Create path:** `POST /v2/virtualtour`, then colors, scenes and floor plans as above. It
   writes `_id` into `_config.json` only when the file had none.
   - So a stale `_id` is never replaced. Later pushes find the tour by code instead.
5. **Scene order.**
   - Automotive: the folders `external`, `exterior`, `internal`, `interior` in that order.
     Inside each, the color folders in directory order. Inside each color folder, 2D and 360°
     files sorted by name, then the sequence last.
   - Spaces: `scenes/` sorted by file name.
6. **Scene names.**
   - The name is the file name without its prefix and extension: `-` and `_` become spaces,
     each word is capitalized. A trailing `_001` (up to 3 digits) is dropped for 2D and 360°.
   - A sequence takes the name of its lowest-numbered frame, so `seq_001.png` makes a scene
     named "001".
7. **Files.**
   - Picked up: `.jpg .jpeg .png .webp .gif .avif`. The server refuses `.avif` (400, scene
     skipped).
   - In a car folder, a file without a `2d_`, `360_` or `seq_` prefix is skipped. In
     `scenes/`, it becomes a 360°.
   - Other folders are ignored: `details/` or `engine/` from a download, `_colors` in Spaces.
   - Videos are never uploaded.

### `vt download` / `vt pull` (code and live)

- **Tour folder:** named after `virtualTourCode`.
  - `_config.json` gets `_id`, name, code, description, `eventType` and `config`.
  - `automotiveColors` is removed.
  - The splash and watermark images stay as whole objects. A push of that file answers 400
    `[object Object]` until each is replaced by its `_id` (checked live).
- **Colors:** saved as `_colors/<side>/<slug of meta.name>.<ext>`.
- **Car scenes:** saved under `<automotiveType>/<color slug or scene slug>/`.
  - The files are named `2d_<scene slug>_001.<ext>`, `360_…`, or `seq_…`.
  - A scene of type `details`, `imperfections` or `engine` lands in a folder that push
    ignores.
- **Space scenes:** saved under `scenes/`. Floor plans go to `_floorplans/<slug>.<ext>`.
- **Download failures:** a failed image download is printed and skipped.
- **Wrong advice:** both commands end with "To re-upload, run `vt bulk`". `bulk` creates a
  new tour every time and fails on an existing code. Ignore the hint.
- **Pulling into a used prefix:** files are overwritten by name, and files of scenes deleted
  since then stay. A push would upload them again.

### `vt bulk`

- It always creates: a tour per folder, coded with the folder name.
- It ignores `_id` and `virtualTourCode`, and never writes `_id` back.
- A second run fails on the unique code (code only). It exits 0 even then.
- Use `preview` + `push` per folder instead.

## What a push loses on an existing tour

These are rebuilt from files, or not at all:

- hotspots of scenes and floor plans (checked live: the hotspot stays, pointing at a deleted
  scene);
- initial views (`camera`; checked live) and scene thumbnails;
- scene names as typed in the app, and their order;
- scenes of the `details`, `imperfections` and `engine` groups;
- video scenes;
- scenes shared with a cloned tour (they would be deleted for both);
- the swatch hex of new colors (always `#000000`).

The script's `preview` lists them, and `push` needs `--accept-losses` once the user agreed.

## What the script adds to `vt push`

- **Same reading as the CLI.** `preview` follows the CLI's rules above, and also checks the
  file types and sizes the server accepts.
- **Blocks:**
  - unlinked code matches;
  - stale `_id`;
  - an update with no images;
  - file objects in `config`;
  - a bad theme;
  - a type mismatch;
  - shared scenes;
  - rejected files.
- **The version** is a hash of the tour, the folder's files and the plan. `push` refuses when
  it changed.
- **`push` runs one folder:** `./prolibu vt push --domain --prefix --tour <folder>`, with no
  terminal, and collects the CLI's failure lines.
- **After the CLI, `push` re-links colors:**
  - `config.automotiveColors` is set back to the tour's existing color for each swatch file
    (matched by file name or color name), plus any new color the CLI uploaded.
  - Each new scene is re-pointed to the color of its folder, matched one to one with the
    folder's scene list. If the counts or names differ, it reports a problem instead.
  - Duplicate color files the CLI uploaded and nobody uses are reported in
    `relinked.unusedColorFiles`.
- **Read back:** the number of scenes, floor plans and colored scenes against the preview.
