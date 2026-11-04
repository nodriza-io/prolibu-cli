# Cobalt: how anything visual must look

Cobalt is Prolibu's design system: web components named `co-*` and CSS tokens named `--co-*`.
Every page an agent builds for an account (a site, an extended-quote picker, a form, a landing)
uses it, so it looks and behaves like the app. Hand-made CSS with its own colors and plain
`<button>`/`<input>` is the failure this file exists to prevent.

The exception: proposal and contract documents (doc-render) carry the **client's** brand, not
Cobalt's look. Those follow `prolibu-document-design`.

Cobalt is the floor, not the bar: the layout, hierarchy and checks a page must pass are in
[`UI-QUALITY.md`](UI-QUALITY.md).

## Load it from the account

Every account domain serves Cobalt, the same version the app uses. Use root-relative paths so
the page works on any account and in `-dev` and prod alike:

```html
<link rel="stylesheet" href="/ui/static/cobalt/tokens/tokens.css">
<link rel="stylesheet" href="/ui/static/cobalt/tokens/tokens-dark.css"> <!-- only if the page offers dark mode -->
<script type="module" src="/ui/static/cobalt/cobalt/cobalt.esm.js"></script>
```

The sites and extended-quote checks accept these `/ui/static/cobalt…` paths (any other
absolute path is still a blocker). A page hosted outside Prolibu pins the npm build instead:
`https://cdn.jsdelivr.net/npm/@prolibu-suite/cobalt-core@<version>/dist/cobalt/cobalt.esm.js`
and `…/@prolibu-suite/cobalt-tokens@<version>/build/css/tokens.css`. React or Vue builds use
`@prolibu-suite/cobalt-react` / `@prolibu-suite/cobalt-vue` plus `@prolibu-suite/cobalt-tokens`.

## Find the right component before writing one

The account serves the docs for LLMs. Read the index, then the page you need:

```
https://<domain>/ui/static/cobalt-docs/llms.txt
https://<domain>/ui/static/cobalt-docs/_llms-txt/componentes.txt      every co-* with props, events, methods
https://<domain>/ui/static/cobalt-docs/_llms-txt/guias-y-theming.txt   tokens, colors, dark mode
https://<domain>/ui/static/cobalt-docs/_llms-txt/formularios.txt       co-form and form fields
```

Look up each component's props there; do not guess them. Common picks:

| Need | Component |
|------|-----------|
| Button | `co-button` (variant `primary · secondary · stroke · soft · ghost · danger · success`; `shape="square"` for text buttons) |
| Text, search | `co-input` (`icon-left`, `clearable`) |
| Number, date | `co-number-field`, `co-date-field` (value `YYYY-MM-DD`) |
| Choose one | `co-select`; on/off `co-switch`, `co-checkbox` |
| Rows, tables | `co-list-item`, `co-data-table` |
| Containers | `co-card` (`variant`, `padding`), `co-modal`, `co-drawer`, `co-page-header` |
| Status | `co-badge`, `co-chip`, `co-helper-text` (`status`), `co-toast` |
| Loading, empty | `co-skeleton`, `co-loader`, `co-empty-state` |
| Icon | `co-icon name="…"` (Phosphor names) |

## Rules

- **Colors, spacing, fonts, radii and shadows come from tokens.** In the page's CSS use the
  semantic layer: `--co-semantic-text-default`, `-text-muted`, `-border-default`,
  `-border-subtle`, `-accent`, `-status-error`… and the
  scales `--co-spacing-*`, `--co-font-size-*`, `--co-border-radius-*`, `--co-shadow-*`,
  `--co-font-family-primary`. The semantic layer follows dark mode for free. No hex in the CSS.
- **Surfaces are a trap.** Page, panels, headers and cards: `--co-semantic-surface-page` or
  `-surface-secondary` (white). A quiet fill (a search row, a chip group, an icon tile):
  `-surface-control` (gray-100) or `-surface-muted` (gray-200). **`-surface-primary` is the
  black fill of a primary button**: never a panel, header or card background.
- **Your CSS does layout only:** grid, flex, widths, gaps. Do not restyle the inside of a
  `co-*` (it is shadow DOM).
- **A brand color goes once, as a token override** in `:root`, e.g.
  `:root { --co-color-primary-azul: #7c3aed; --co-semantic-border-focus: #7c3aed; }`.
  Ask the user for the brand color; never invent one.
- **Events are camelCase CustomEvents** with the value in `event.detail`: `coInput`,
  `coChange`, `coSelect`, `coClose`. `co-button` has none: listen to `click`.
- **Booleans are attributes** (`disabled`, `full-width`). A `size` or `variant` outside the
  component's list is ignored silently, so copy it from the docs.
- **`hidden` needs a rule:** components set `display` on their host, which beats the
  attribute. Add `[hidden] { display: none !important; }`.
- **Every state is visible:** loading (`co-skeleton`/`co-loader`), empty (`co-empty-state`),
  error (`co-helper-text status="error"` or `co-toast`).
- Dark mode: load `tokens-dark.css` and set `document.documentElement.dataset.theme = 'dark'`.

## Checked automatically

`cobalt-check.js` (used by `site.js preview` and `extended-quote.js lint`) warns when a page
does not load Cobalt, loads it without tokens, writes more than 4 colors by hand, or uses
plain `button`/`input`/`select`. They are warnings, not blockers: read them to the user and
fix them before publishing. The examples in each skill's `assets/example/` pass clean.
