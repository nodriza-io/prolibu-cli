# UI quality: the bar for anything visual

Using Cobalt ([`COBALT.md`](COBALT.md)) makes a page look like Prolibu. It does not make it
good. A page an agent builds must read as if a product designer made it: calm, aligned,
one clear action, nothing cut off, at any width. This is the bar, and it is checked by
looking at the page, not by reading the code.

## Before writing: decide the layout

Write these down in two or three lines before the first tag:

1. **The one job of the page** and its **one primary action** (for a picker: "add the chosen
   products to the quote"). Everything else is secondary.
2. **What the user scans first** and in what order (search → results → what is chosen).
3. **The layout at three widths:** wide (1440), laptop (1024) and phone (390). Decide where a
   side panel goes on a phone (below, or a drawer), how many card columns fit, and what wraps.

## Rules

**Hierarchy**
- One page title (`co-page-header` or an `h1`). No second title that says the same thing.
- One primary button on screen: the page's main action. Repeated actions (one per card or row)
  are `secondary`, `soft` or `ghost`. `co-button` is primary when it has no `variant`.
- Instructions are a line of muted text or `co-helper-text`, never a row of chips. Chips are
  for filters the user clicks or tags on a record.
- Three text levels at most: title, body (13–14px), secondary (12px, muted). Nothing under 12px.

**Color**
- Light surfaces: white page and panels, gray-100/200 only for quiet fills. No dark header or
  side panel (see the surface trap in `COBALT.md`).
- Neutrals plus one accent. Status colors (warning, error, success, info) only for a status the
  user must act on — never to tell tiers, types or categories apart (those are neutral chips).
- A rule or limit of a product (max discount, min quantity) is a quiet line of secondary text or
  an icon with a tooltip, not orange text in every card. Warn in color only when the user's
  current choice breaks it.
- Icons in one color (`--co-semantic-text-muted` or the accent), one size, one weight.

**Alignment and rhythm**
- Spacing only from `--co-spacing-*`, on one rhythm: the same gap between all cards, the same
  padding inside all cards, the same gap between a label and its value everywhere.
- Cards in a row are the **same height** and their footers line up: `co-card stretch`, the card
  body a flex column, the footer `margin-top: auto`.
- Every card has the same structure in the same order (title, meta, body, footer). Optional
  parts keep their place empty or are dropped from all cards of the row.
- Titles that may wrap get a fixed line count (`-webkit-line-clamp: 2`) and the full text in
  `title`. Codes and SKUs do not wrap: one line with an ellipsis.
- Cards have a sensible width: `repeat(auto-fill, minmax(280px, 1fr))` and a `max-width` on the
  content area, so a wide screen does not produce six squeezed columns or one stretched one.

**Nothing cut, nothing sideways**
- Grid tracks are `minmax(0, 1fr)`, flex children that hold text get `min-width: 0`, and rows of
  chips, filters or buttons wrap (`flex-wrap: wrap`) or scroll inside their own box.
- Fixed side panels (for example a 340px cart) collapse below the content under ~900px.
- Sticky footers keep their buttons fully visible; long labels shorten ("Agregar", not
  "Agregar a la cotización" when space is tight) instead of being cut.
- On a phone every tappable control is at least 32px tall (size `m` for buttons).

**States**
- Loading (`co-skeleton` in the shape of the final content), empty (`co-empty-state` sized to its
  container, not a hero), error (what happened and what to do), and disabled states that say
  why (a helper line under the disabled primary button).
- Money right-aligned or in a consistent spot, with the currency, in the same format everywhere.

## Verify by looking, and by measuring

Run the review on the local folder before any preview or publish:

```
node .claude/skills/_shared/ui-review.js <domain> <site folder> [--profile <name>]
```

It serves the folder in headless Chrome as `https://<domain>/site/__ui-review__/` with the
account's real Cobalt and real data (the profile's key acts as the session inside that browser
only; any request that would change data is blocked), at 1440, 1024 and 390 px. It reports
`cutOff`, `unevenCards`, `misalignedActions`, `tooManyPrimaryButtons`, `tooManyColors`,
`coloredCategories`, `darkSurface`, `smallText`, `clippedText`, `smallTouchTargets`, `brokenImages`, HTTP
errors and console errors, and saves a screenshot per width.

1. Fix every finding and run it again until it reports none.
2. **Open each screenshot (Read the png) and look at it** against the rules above. The checks
   cannot judge hierarchy, copy or whether the layout makes sense; your eyes do.
3. Say in the summary to the user what you checked and attach what you saw (widths, findings
   fixed). Never claim a page looks right without having opened the screenshots.

An extended-quote page opened outside the editor must still render (a preview mode with the
catalog), so it can be reviewed the same way.
