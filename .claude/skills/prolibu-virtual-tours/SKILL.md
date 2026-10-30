---
name: prolibu-virtual-tours
description: Create, update and download Prolibu virtual tours (car configurators and 360° spaces) with the CLI's `vt` commands, the safe way. It lays out the tour folder and the image names, previews exactly what a push will create, delete and upload, pushes one tour after the user agrees and puts each scene back on its color, changes settings without touching the scenes, and downloads one tour or every tour in the account. Use it whenever someone wants to create a virtual tour of a car or a space; upload scenes, photos, 360° panoramas, image sequences, colors or floor plans; change an existing tour; or back up or download tours. Also use it when someone reports scenes that lost their color, hotspots or an initial view that vanished, a push that "deleted the scenes", or a 400 "[object Object]" when pushing. Spanish triggers: "tour virtual", "recorrido virtual", "subir escenas", "panorámicas 360", "configurador de autos", "descargar los tours", "planos de planta".
---

# Prolibu Virtual Tours

## Central idea

A tour (`VirtualTour`) is one record with its settings (`config`) and the list of its `scenes`.
A `Spaces` tour also lists its `floorPlans`. Each scene keeps its images in order: one for 2D or
360°, many for a sequence (a spin). Hotspots are their own records and hang from scenes and
floor plans. In an `Automotive` tour, `config.automotiveColors` lists the color swatch images,
and each scene names its color by that image's `_id`.

**`vt push` never edits a scene.** On every update it deletes all the tour's scenes (and, in
Spaces, its floor plans) and uploads the folder again. Work done in the app on those scenes is
lost: hotspots, initial views, scene names and order. On top of that, the CLI drops every
scene's color on each update. So the script runs every push, and a change of settings alone
never goes through a push.

`scripts/vt.js` replays what `vt push` will do with one folder and writes nothing. Its `push`
command then runs `./prolibu vt push --tour <folder>` only if nothing changed since that
preview. Afterwards it puts each scene back on its color and reads the tour back. Your job is
the conversation: agree on the tour, the images and the type with the user, show the preview,
and push only after a clear yes.

```
node .claude/skills/prolibu-virtual-tours/scripts/vt.js <command> <domain> …
  list    <domain> [--search <text>]          the account's tours: id, code, name, type, scenes, link
  show    <domain> <tour id or code>          colors, scenes (and what a push would lose), floor plans
  preview <domain> <prefix> <folder>          writes nothing; returns a version
  push    <domain> <prefix> <folder> --version <v> --confirmed [--accept-losses]
```

`<folder>` is `accounts/<domain>/vt/<prefix>/virtualTours/<folder>`. Output is JSON. Exit
codes: 0 ok, 1 API or CLI error, 2 usage error (nothing sent), 3 blocked (nothing written).

## Ask the user first

In plain business terms:

1. **New or existing tour?** For an existing one, find it with `list` (`--search` by name).
2. **For a new tour:**
   - Is it a car (`Automotive`) or a space (`Spaces`)?
   - Its name, and a code. The code is the folder name: start with a letter, then letters,
     digits, `-` or `_`.
   - What each image is: a flat photo, a 360° panorama, or the frames of a spin.
   - For a car: its colors, and the swatch image of each one.
   - For a space: any floor plans.
3. **For an existing tour:** is it only the name, the description or settings (theme,
   autorotate, splash…), or also scenes and images?
4. **For downloads:** one tour or all of them.

If `accounts/` has several domains, ask which one.

## Steps

### A. Create a tour

1. **Lay out the folder** under `accounts/<domain>/vt/<prefix>/virtualTours/<CODE>/` (pick a
   new `<prefix>` per project). Copy the user's images in, renamed as follows.

   | Type | Where the images go | Scene per |
   | --- | --- | --- |
   | Automotive | `_colors/external/<color>.png`, `_colors/internal/<color>.png` (the swatches) | — |
   | Automotive | `external/<color>/` or `internal/<color>/` (same `<color>` as the swatch) | file |
   | Spaces | `scenes/` | file |
   | Spaces | `_floorplans/<name>.png` | one plan per file |

   | File name | Scene |
   | --- | --- |
   | `2d_<name>.jpg` | 2D photo, named `<Name>` |
   | `360_<name>.jpg` | 360° panorama |
   | `seq_<name>_001.jpg`, `seq_<name>_002.jpg`… | all the `seq_` files of one folder make one spin, in number order, named after the first file |

   - Use jpg, png, webp or gif, at most 50 MB each.
   - In a car folder, a file without a prefix is skipped. In `scenes/`, it becomes a 360°.
   - Videos are never uploaded.

2. **Write `_config.json`** in that folder:

   ```json
   { "virtualTourName": "<name>", "description": "<one line>", "eventType": "Automotive",
     "config": { "theme": "flow" } }
   ```

   - `eventType` is `Automotive` or `Spaces`.
   - `theme` is one of `modern`, `flow`, `cascade`, `classic`. The CLI defaults to `flow`
     for cars and `cascade` for spaces.
   - Leave out `_id`: the push writes it, and it links the folder to the tour from then on.

3. **Preview.** Run `preview <domain> <prefix> <CODE>`. It must say `"action": "create"`. Tell
   the user:
   - the scenes to create, with their type and color;
   - the colors and floor plans;
   - `skipped` files;
   - every warning.

4. **Wait for an explicit yes**, then **push** with `push … --version <v> --confirmed`.
5. **Report** the tour name, its `_id` and its `link` (the public viewer). New colors get the
   swatch hex `#000000`: the user sets the real hex in the app.

### B. Change only the name, description or settings

Don't push. Patch the tour with the generic helper. `config` merges key by key, and the scenes
are not touched:

```
node .claude/skills/_shared/prolibu-api.js <domain> PATCH /v2/virtualtour/<id> \
  --data '{"config":{"panorama":{"autoRotate":false}}}' --confirmed
```

Read the current values with `show` first. Then summarize the change and wait for a yes.

### C. Change scenes, images or colors of an existing tour

1. **Get its folder.** If it was created or downloaded here, its `_config.json` has the tour's
   `_id`. Otherwise run
   `./prolibu vt download --domain <domain> --prefix <new prefix> --id <tour id>`.
2. **Edit the files** the user asked for: add, remove or replace images with the names above.
3. **Preview.** Run `preview`. Tell the user:
   - what is deleted (every current scene) and what is uploaded;
   - `settingsChanged`: values the push resets;
   - every warning (new start scene, scene names that change…);
   - every item in `losses`. Each loss needs its own yes.
4. **Push** after the yes. Add `--accept-losses` only when the user accepted every loss.

### D. Download tours

- **One tour:** `./prolibu vt download --domain <domain> --prefix <new prefix> --id <id>`.
- **All tours:** `./prolibu vt pull --domain <domain> --prefix <new prefix>`.
- **Always use a new prefix.** Pulling into a used one overwrites files and leaves stale
  images, which a later push would upload again.
- **Report the folder.** Never push a pulled folder as a whole: change one tour folder and push
  it with this script.

## How the platform behaves

Details, every CLI prompt and the evidence summary are in `references/tour-model.md`.

- **An update replaces every scene.** The CLI deletes each scene and its images, then uploads
  the folder. Hotspots stay behind on scenes that no longer exist, and navigation to a deleted
  scene stops working. The script lists these as `losses`.
- **The CLI breaks the colors on update.** Each push uploads every swatch again. A swatch
  already uploaded to the same path is refused (400), the CLI says "Updated", and the new
  scenes have no color. The viewer then shows no color choice. `push` puts each scene back on
  the tour's existing color, and it keeps the existing swatches as they are (hex, name).
- **The tour is found by `_id`, then by code.** A folder without `_id` whose code belongs to
  an existing tour would replace that tour's scenes. The script blocks it.
- **A settings PATCH merges.** Only the keys sent change. A push instead sends the folder's
  `config` over the CLI defaults, so missing keys go back to those defaults (`settingsChanged`).
- **A downloaded `_config.json` can hold whole file objects** (splash or watermark images).
  The server answers 400 "[object Object]" before deleting anything; replace each one with its
  `_id`.
- **`theme` is checked** (400 outside the four values). Unknown `config` keys are dropped
  silently.
- **Scenes come from the folder order.** Car scenes go external, then internal, by color folder
  and file name. The first scene is the one the tour opens on.
- **The public link** is `https://<domain>/ui/spa/virtualTour/view/<id>`. It needs no login,
  and the images are public files.

## Symptoms

| Symptom | Cause | Fix |
| --- | --- | --- |
| After a push, no color choice; every scene shows for every color | The CLI's update left the scenes without color | Push through the script, or re-run its `push` |
| Hotspots or the initial view vanished | A push recreated the scenes | Redo them in the app; the script warns before |
| Push "deleted the scenes" | Folder without images, or files the server rejected | `preview` blocks both |
| 400 "…[object Object]…" on push | Downloaded `_config.json` with a file object | Replace it with its `_id` |
| A push changed the wrong tour | Folder without `_id`, code of another tour | `preview` blocks it |
| `vt bulk` fails or duplicates | `bulk` always creates and never links the folder | Use `preview` + `push` per folder |
| A spin is named "001" | Sequences take the first file's name | Name frames `seq_<name>_001…` |

## Verify

- `push` reads the tour back. It checks the scenes and floor plans uploaded against the
  preview and the scenes linked to their color, and returns `problems`. `saved: true` means
  none.
- Give the user the `link`, and run `show` when they want to check scenes and colors.

## Don't

- Run `./prolibu vt push` yourself, or without `--tour`: it pushes every folder of the prefix.
- Run `vt bulk` (always creates; `--watch` never ends) or interactive forms. Every `vt` call
  needs `--domain` and `--prefix` (plus `--type` for `create`, `--id` for `download`), or it
  waits on a prompt.
- Pass `--apikey`, or run `vt create` in a prefix that exists: it asks to delete the folder.
  The folder from step A is enough; `vt create` only adds an `EXAMPLE_TOUR` and rewrites the
  profile file.
- Push a whole pulled folder, or push to change settings only.
- Write `_id` by hand unless it is the real id of the same tour, confirmed by the user.
- Delete tours, scenes or colors through the API: scenes may be shared with other tours.

## Writing to an account

Reads and writes follow [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md): domain, reads
only, plain summary, explicit yes, write, read back. `preview` is the summary step and `push`
the write. For other objects, see `prolibu-platform-map`.
