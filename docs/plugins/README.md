# Prolibu Plugin Development

This guide covers the plugin development workflow using the Prolibu CLI. Plugins are React-based UI components that extend the Prolibu platform.

## Table of Contents

- [Quick Start](#quick-start)
- [Commands](#commands)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Configuration Files](#configuration-files)
- [API Integration](#api-integration)
- [Architecture](#architecture)
- [Assets](#assets)
- [Plugin Studio](#prolibu-studio)

---

## Quick Start

```bash
# 1. Create a new plugin
./prolibu plugin create --domain dev10.prolibu.com --prefix my-plugin

# 2. Navigate to plugin directory
cd accounts/dev10.prolibu.com/my-plugin

# 3. Start development server
../../prolibu plugin dev --domain dev10.prolibu.com --prefix my-plugin --watch

# 4. Build and publish to production
../../prolibu plugin prod --domain dev10.prolibu.com --prefix my-plugin
```

---

## Commands

### `prolibu plugin create`

Creates a new plugin project with all necessary scaffolding.

```bash
./prolibu plugin create [options]
```

**Options:**

| Option                 | Description                                | Required                          |
| ---------------------- | ------------------------------------------ | --------------------------------- |
| `--domain <domain>`    | Prolibu domain (e.g., `dev10.prolibu.com`) | Yes (interactive if not provided) |
| `--prefix <name>`      | Plugin name/prefix                         | Yes (interactive if not provided) |
| `--description <text>` | Plugin description                         | No                                |
| `--repo <url>`         | Git repository URL to clone from           | No                                |
| `--apikey <key>`       | Prolibu API key                            | Yes (interactive if not provided) |

**What it does:**

1. Creates plugin directory in `accounts/<domain>/<prefix>/`
2. Copies template files (React + Vite + TypeScript)
3. Generates `config.json`, `settings.json`, and `README.md`
4. Updates `vite.config.js` with the plugin name
5. Runs `npm install`
6. Creates both `<prefix>-dev` and `<prefix>` plugins on the API
7. Initializes git repository for the domain

**Example:**

```bash
./prolibu plugin create --domain dev10.prolibu.com --prefix sales-dashboard --description "Sales analytics dashboard"
```

---

### `prolibu plugin dev`

Starts a development server with hot module replacement (HMR).

```bash
./prolibu plugin dev [options]
```

**Options:**

| Option              | Description                     | Default  |
| ------------------- | ------------------------------- | -------- |
| `--domain <domain>` | Prolibu domain                  | Required |
| `--prefix <name>`   | Plugin name/prefix              | Required |
| `--watch, -w`       | Watch for config/README changes | `false`  |
| `--port <port>`     | Dev server port                 | `4500`   |

**What it does:**

1. Ensures plugin exists on the API (creates `<prefix>-dev` if needed)
2. Starts Vite dev server with HMR
3. Opens Plugin Studio interface
4. If `--watch`: syncs `config.json` and `README.md` changes to API in real-time

**Example:**

```bash
./prolibu plugin dev --domain dev10.prolibu.com --prefix sales-dashboard --watch --port 4500
```

Access the dev server at `http://localhost:4500`

---

### `prolibu plugin prod`

Builds the plugin and publishes it to production.

```bash
./prolibu plugin prod [options]
```

**Options:**

| Option              | Description        |
| ------------------- | ------------------ |
| `--domain <domain>` | Prolibu domain     |
| `--prefix <name>`   | Plugin name/prefix |

**What it does:**

1. Runs Vite build (UMD format with CSS injected)
2. Syncs metadata to API:
   - `variables` from `config.json`
   - `description` from `config.json`
   - `readme` from `README.md`
   - `version` from `package.json`
   - `pluginName` (PascalCase)
3. Uploads bundle (`dist/<PluginName>.js`) as `resources`
4. Uploads icon from `src/assets/` (first `.svg`, `.png`, `.jpg`, or `.gif` found)

**Example:**

```bash
./prolibu plugin prod --domain dev10.prolibu.com --prefix sales-dashboard
```

---

### `prolibu plugin import`

Imports an existing plugin from a git repository.

```bash
./prolibu plugin import [options]
```

**Options:**

| Option              | Description                                |
| ------------------- | ------------------------------------------ |
| `--domain <domain>` | Prolibu domain                             |
| `--prefix <name>`   | Plugin name/prefix (defaults to repo name) |
| `--repo <url>`      | Git repository URL                         |
| `--apikey <key>`    | Prolibu API key                            |

**What it does:**

1. Clones the repository
2. Removes `.git` folder (uses domain-level git instead)
3. Updates `config.json` with repository URL
4. Creates `settings.json` if missing
5. Runs `npm install`

**Example:**

```bash
./prolibu plugin import --domain dev10.prolibu.com --repo https://github.com/company/my-plugin.git
```

---

## Project Structure

```
accounts/
└── <domain>/
    ├── profile.json           # API key storage
    └── <plugin-prefix>/
        ├── config.json        # Plugin metadata (syncs to API)
        ├── settings.json      # Local dev settings
        ├── package.json       # NPM dependencies
        ├── vite.config.js     # Vite build configuration
        ├── tsconfig.json      # TypeScript config
        ├── index.html         # Plugin Studio (dev UI)
        ├── README.md          # Documentation (syncs to API)
        ├── src/
        │   ├── index.tsx      # Plugin entry point
        │   ├── utils/
        │   │   └── assets.ts  # Asset URL utilities (required)
        │   ├── plugins/       # Plugin components
        │   │   └── Example/
        │   │       ├── ExamplePlugin.tsx
        │   │       └── ExamplePlugin.scss
        │   └── assets/
        │       └── icon.svg   # Plugin icon
        └── dist/              # Build output
            └── <PluginName>.js
```

---

## Development Workflow

### Dev vs Prod Plugins

The CLI creates two plugin entries on the API:

| Mode | Plugin Code    | Purpose               |
| ---- | -------------- | --------------------- |
| Dev  | `<prefix>-dev` | Development/testing   |
| Prod | `<prefix>`     | Production deployment |

This allows parallel development without affecting production users.

### Hot Module Replacement

In dev mode, changes to React components are instantly reflected in the browser without full page reload.

### Config Sync (Watch Mode)

With `--watch` flag, changes to these files are automatically synced to the API:

- `config.json` → `variables`, `description`
- `README.md` → `readme`

---

## Configuration Files

### config.json

Defines plugin metadata synced to the Prolibu API.

```json
{
  "variables": [
    {
      "name": "apiEndpoint",
      "type": "string",
      "default": "https://api.example.com",
      "description": "External API endpoint"
    }
  ],
  "description": "My plugin description",
  "git": {
    "repositoryUrl": "https://github.com/company/plugin.git"
  }
}
```

### settings.json

Local development settings (not synced to API).

```json
{
  "port": 4500
}
```

### vite.config.js

Vite configuration for building the plugin as a UMD library.

```javascript
export default defineConfig({
  plugins: [
    react(),
    cssInjectedByJsPlugin(),
    prolibuPublishPlugin(), // Enables publish from Studio UI
  ],
  build: {
    lib: {
      entry: "src/index.tsx",
      name: "PluginName", // PascalCase plugin name
      formats: ["umd"],
      fileName: () => "PluginName.js",
    },
    rollupOptions: {
      external: ["react", "react-dom"],
      output: {
        globals: {
          react: "React",
          "react-dom": "ReactDOM",
        },
      },
    },
  },
});
```

---

## Form Schema (Formily + Ant Design)

El sistema de formularios de plugins usa [Formily.js](https://formilyjs.org/) con [Ant Design](https://ant.design/) para renderizar campos de configuración dinámicamente basados en JSON Schema.

### Formato del Schema

El `formSchema` sigue el estándar [JSON Schema](https://json-schema.org/) con extensiones de Formily:

```typescript
formSchema: {
  type: 'object',
  properties: {
    fieldName: {
      type: 'string' | 'number' | 'boolean' | 'array',
      title: 'Field Label',           // Label mostrado en UI
      default: 'default value',        // Valor por defecto
      description: 'Help text',        // Texto de ayuda
      enum: ['opt1', 'opt2'],           // Opciones para select
      format: 'date' | 'textarea',     // Formato especial
      // Formily extensions (opcional)
      'x-component': 'Input',          // Componente específico
      'x-decorator': 'FormItem',       // Wrapper del campo
    }
  }
}
```

### Tipos de Campo Soportados

| type              | format      | Componente Antd       | Descripción              |
| ----------------- | ----------- | --------------------- | ------------------------ |
| `string`          | -           | Input                 | Campo de texto           |
| `string`          | `color`     | Input (type=color)    | Selector de color        |
| `string`          | `textarea`  | Input.TextArea        | Área de texto multilínea |
| `string`          | `password`  | Password              | Campo de contraseña      |
| `string`          | `date`      | DatePicker            | Selector de fecha        |
| `string`          | `date-time` | DatePicker (showTime) | Fecha y hora             |
| `string`          | `time`      | TimePicker            | Selector de hora         |
| `string` + `enum` | -           | Select                | Dropdown con opciones    |
| `number`          | -           | NumberPicker          | Campo numérico           |
| `boolean`         | -           | Switch                | Interruptor on/off       |
| `array`           | -           | Select (multiple)     | Selector múltiple        |

### Componentes Disponibles (x-component)

Todos los componentes de [@formily/antd-v5](https://antd5.formilyjs.org/):

- **Input**, Input.TextArea
- **Select**, Cascader, TreeSelect
- **NumberPicker**
- **DatePicker**, DatePicker.RangePicker
- **TimePicker**, TimePicker.RangePicker
- **Switch**, Checkbox, Checkbox.Group
- **Radio**, Radio.Group
- **Upload**, Upload.Dragger
- **Password**
- **FormGrid**, FormLayout, Space

### Ejemplos

#### Campo de texto básico

```typescript
message: {
  type: 'string',
  title: 'Mensaje',
  default: 'Hola mundo',
  description: 'Mensaje a mostrar'
}
```

#### Selector de opciones (enum)

```typescript
theme: {
  type: 'string',
  title: 'Tema',
  enum: ['light', 'dark', 'auto'],
  enumNames: ['Claro', 'Oscuro', 'Automático'],  // Labels opcionales
  default: 'light'
}
```

#### Selector de color

```typescript
accentColor: {
  type: 'string',
  title: 'Color de Acento',
  format: 'color',
  default: '#0d99ff'
}
```

#### Campo numérico

```typescript
fontSize: {
  type: 'number',
  title: 'Tamaño de Fuente',
  default: 14,
  description: 'Tamaño en píxeles'
}
```

#### Checkbox booleano

```typescript
showBorder: {
  type: 'boolean',
  title: 'Mostrar Borde',
  default: true
}
```

#### Selector de fecha

```typescript
startDate: {
  type: 'string',
  title: 'Fecha de Inicio',
  format: 'date',
  default: ''
}
```

#### Fecha y hora

```typescript
scheduledAt: {
  type: 'string',
  title: 'Programado para',
  format: 'date-time',
  default: ''
}
```

#### Área de texto

```typescript
notes: {
  type: 'string',
  title: 'Notas',
  format: 'textarea',
  default: ''
}
```

### Acceder a los Valores en el Plugin

Los valores del formulario están disponibles en `ctx.formSchemaModel.model`:

```tsx
export const MyPlugin = ({ ctx }: PluginProps) => {
  const { model } = ctx.formSchemaModel;

  return (
    <div
      style={{
        color: model.accentColor,
        fontSize: model.fontSize,
      }}
    >
      {model.message}
    </div>
  );
};
```

### Usar FormRenderer en tu Plugin

Si necesitas renderizar formularios dentro de tu plugin:

```tsx
import { FormRenderer } from "./utils/FormRenderer";

export const MyPlugin = ({ ctx }) => {
  const [values, setValues] = useState({});

  const schema = {
    type: "object",
    properties: {
      name: { type: "string", title: "Nombre", default: "" },
      email: { type: "string", title: "Email", default: "" },
    },
  };

  return (
    <FormRenderer schema={schema} initialValues={values} onChange={setValues} />
  );
};
```

### Componentes Personalizados (Avanzado)

El FormRenderer ya incluye todos los componentes de `@formily/antd-v5`. Si necesitas agregar componentes custom, edita `src/utils/FormRenderer.tsx`:

```tsx
import { ColorPicker } from "antd"; // Ejemplo: usar ColorPicker de Antd 5

// Wrapper para hacerlo compatible con Formily
const AntdColorPicker = ({ value, onChange }) => (
  <ColorPicker value={value} onChange={(_, hex) => onChange(hex)} />
);

const SchemaField = createSchemaField({
  components: {
    // ... componentes existentes
    ColorPicker: AntdColorPicker, // Agregar componente
  },
});
```

Luego úsalo en el schema:

```typescript
customField: {
  type: 'string',
  title: 'Color',
  'x-component': 'ColorPicker'
}
```

---

## API Integration

### Plugin API Endpoints

| Method | Endpoint                  | Description        |
| ------ | ------------------------- | ------------------ |
| GET    | `/v2/plugin/{pluginCode}` | Get plugin by code |
| POST   | `/v2/plugin`              | Create new plugin  |
| PATCH  | `/v2/plugin/{id}`         | Update plugin      |

### Upload Format

Plugins are uploaded via `multipart/form-data` with:

| Field         | Type    | Description               |
| ------------- | ------- | ------------------------- |
| `pluginCode`  | string  | Unique plugin identifier  |
| `pluginName`  | string  | Display name (PascalCase) |
| `active`      | boolean | Enable/disable plugin     |
| `version`     | string  | Semantic version          |
| `description` | string  | Plugin description        |
| `resources`   | file    | Bundle JS file            |
| `icon`        | file    | Plugin icon image         |

---

## Architecture

### Build and Deployment Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            PLUGIN PROD BUILD FLOW                               │
└─────────────────────────────────────────────────────────────────────────────────┘

  LOCAL (CLI)                            REMOTE (Prolibu Backend)
  ═══════════════════                    ════════════════════════

  accounts/{domain}/{plugin}/
  ├── src/
  │   ├── index.tsx ──────┐
  │   ├── plugins/        │
  │   │   └── Example/    │
  │   │       └── *.tsx   │
  │   └── assets/         │              ┌─────────────────────────┐
  │       ├── icon.svg ───┼──────────────│►  Uploaded separately   │
  │       └── images/     │              │   PATCH /v2/plugin      │
  │           └── *.svg ──┼───┐          │   (multipart with icon) │
  │                       │   │          └─────────────────────────┘
  │                       │   │
  │        ┌──────────────┘   │
  │        ▼                  │
  │   ┌─────────────┐         │
  │   │  VITE BUILD │         │
  │   │  (npx vite) │         │
  │   └──────┬──────┘         │
  │          ▼                │
  ├── dist/                   │
  │   └── {plugin}.js ────────┼───┐
  │       (UMD bundle)        │   │
  │       CSS included        │   │
  │                           │   │
  │                           │   │      ┌─────────────────────────┐
  ├── dist.zip ◄──────────────┼───┤      │                         │
  │   ├── {plugin}.js         │   └─────►│  ZIP uploaded to API    │
  │   └── assets/             │          │  PATCH /v2/plugin       │
  │       └── images/*.svg ◄──┘          │  (multipart with zip)   │
  │                                      │                         │
  │                                      └───────────┬─────────────┘
  │                                                  │
  │                                                  ▼
  │                                      ┌─────────────────────────────────────┐
  │                                      │        PROLIBU BACKEND             │
  │                                      ├─────────────────────────────────────┤
  │                                      │                                     │
  │                                      │  1. Receives dist.zip              │
  │                                      │  2. Extracts to S3/Storage         │
  │                                      │  3. Saves document in MongoDB      │
  │                                      │                                     │
  └──────────────────────────────────────┴─────────────────────────────────────┘
```

### Remote Storage (S3/Storage)

After the ZIP is uploaded and extracted, assets are stored at:

```
/plugins/{userId}/public/plugins/{pluginCode}/
├── {pluginCode}.js          ◄── Main bundle (UMD)
└── assets/
    └── images/
        └── badge.svg        ◄── Static assets
```

### Database Document

```json
{
  "pluginCode": "my-plugin",
  "pluginName": "MyPlugin",
  "icon": "ObjectId(...)",
  "package": "ObjectId(...)",
  "version": "1.0.0",
  "description": "...",
  "readme": "...",
  "variables": [],
  "active": true,
  "createdBy": "ObjectId(...)"
}
```

> **Note:** `bundleUrl` is no longer stored in the database. It is computed by the frontend using the formula:
> `{origin}/plugins/{createdBy}/public/plugins/{pluginCode}/{pluginCode}.js`

### Frontend Loading Flow

```
┌─────────────────┐
│  GET /v2/plugin │ ─────► Fetches plugin list with createdBy
└────────┬────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────┐
│  Frontend computes bundleUrl for each plugin:              │
│  bundleUrl = `${origin}/plugins/${createdBy}/public/...`  │
│                                                            │
│  For each active plugin:                                   │
│                                                            │
│  1. window['my-plugin'] = {}                              │
│                                                            │
│  2. Injects <script> into DOM:                            │
│     <script id="my-plugin-js"                             │
│             src="{computedBundleUrl}">                    │
│     </script>                                              │
│                                                            │
│  3. Bundle executes and populates window['my-plugin']:    │
│     window['my-plugin'] = {                               │
│       components: [                                        │
│         { label, render, formSchema, ... }                │
│       ]                                                    │
│     }                                                      │
│                                                            │
│  4. Prolibu renders components based on configuration     │
└────────────────────────────────────────────────────────────┘
```

### Flow Summary

| Step | Action         | Result                                            |
| ---- | -------------- | ------------------------------------------------- |
| 1    | `vite build`   | `dist/{plugin}.js` (UMD bundle with embedded CSS) |
| 2    | ZIP created    | `dist.zip` with bundle + assets                   |
| 3    | Upload to API  | ZIP extracted to S3/Storage                       |
| 4    | Metadata sync  | Plugin document saved to MongoDB                  |
| 5    | Frontend loads | Computes `bundleUrl` and injects `<script>`       |
| 6    | Plugin active  | `window[pluginCode].components` available         |

---

## Assets

Plugins can include static assets like images, fonts, and other files. Understanding how assets are handled is essential for building plugins that display images or load external resources.

### Types of Assets

| Type            | Location                | Handling                                                   |
| --------------- | ----------------------- | ---------------------------------------------------------- |
| **Icon**        | `src/assets/icon.svg`   | Uploaded separately to API, displayed in plugin catalog    |
| **Images**      | `src/assets/images/`    | Packaged in ZIP, served from CDN                           |
| **Fonts**       | `src/assets/fonts/`     | Packaged in ZIP, served from CDN                           |
| **CSS**         | Component `.scss` files | Bundled and injected into JS (via `cssInjectedByJsPlugin`) |
| **Other files** | `src/assets/**/*`       | Packaged in ZIP, served from CDN                           |

### Estilos - Regla Obligatoria

> **⚠️ REGLA OBLIGATORIA: Usar estilos inline de React**
>
> Los plugins **DEBEN** usar **estilos inline de React** (objetos JavaScript) en lugar de archivos CSS/SCSS externos.
>
> **Motivo:** Los archivos SCSS se inyectan en `document.head` mediante una etiqueta `<style>`, lo cual puede fallar en producción si:
>
> - El plugin se renderiza en un Shadow DOM o contexto aislado
> - Las políticas CSP (Content Security Policy) bloquean estilos inline en etiquetas `<style>`
> - El plugin se carga en un iframe con restricciones

**❌ NO hacer (archivos SCSS externos):**

```tsx
// CalendarioPlugin.tsx
import "./CalendarioPlugin.scss"; // ❌ Puede fallar en producción

export const CalendarioPlugin = () => {
  return <div className="calendario-container">...</div>;
};
```

**✅ SÍ hacer (estilos inline de React):**

```tsx
import { CSSProperties } from "react";

const styles: Record<string, CSSProperties> = {
  container: {
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    maxWidth: "350px",
    padding: "20px",
    background: "#ffffff",
    borderRadius: "12px",
    boxShadow: "0 4px 20px rgba(0, 0, 0, 0.1)",
  },
  button: {
    background: "#4a90d9",
    color: "white",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
  },
};

export const CalendarioPlugin = () => {
  return (
    <div style={styles.container}>
      <button style={styles.button}>Click</button>
    </div>
  );
};
```

### Local Structure

```
src/
└── assets/
    ├── icon.svg              ◄── Plugin icon (uploaded separately)
    ├── icon.png              ◄── Alternative icon format
    ├── images/
    │   ├── logo.svg
    │   ├── badge.png
    │   └── background.jpg
    ├── fonts/
    │   └── custom-font.woff2
    └── data/
        └── config.json       ◄── Any static file you need
```

### How Assets Are Packaged

When you run `prolibu plugin prod`:

```
1. VITE BUILD
   └── Creates dist/{pluginCode}.js (CSS is embedded in JS)

2. ZIP CREATION (dist.zip)
   ├── {pluginCode}.js        ◄── From dist/
   └── assets/                ◄── Copied from src/assets/ (excluding icon)
       ├── images/
       │   ├── logo.svg
       │   └── badge.png
       └── fonts/
           └── custom-font.woff2

3. ICON UPLOAD (separate request)
   └── src/assets/icon.svg    ◄── First .svg, .png, .jpg, or .gif found

4. ZIP UPLOAD
   └── Backend extracts to: /plugins/{userId}/public/plugins/{pluginCode}/
```

### Remote URL Structure

After deployment, your assets are available at:

```
https://{domain}/plugins/{userId}/public/plugins/{pluginCode}/
├── {pluginCode}.js                    ◄── Bundle
└── assets/
    ├── images/
    │   ├── logo.svg                   ◄── Your images
    │   └── badge.png
    └── fonts/
        └── custom-font.woff2          ◄── Your fonts
```

### Accessing Assets in Your Plugin

Since plugins run on the Prolibu platform (not your dev server), you need to dynamically resolve asset URLs at runtime.

**The plugin template includes a utility file at `src/utils/assets.ts`** that handles this automatically.

#### Available Functions

```typescript
import { getAssetUrl, createAssetGetter } from "../../utils/assets";

// Option 1: Direct usage
const logoUrl = getAssetUrl("my-plugin", "images/logo.svg");

// Option 2: Create a getter for multiple assets
const getAsset = createAssetGetter("my-plugin");
const logoUrl = getAsset("images/logo.svg");
const badgeUrl = getAsset("images/badge.png");
```

#### Usage in React Components

```tsx
// src/plugins/MyPlugin/MyPlugin.tsx
import React from "react";
import { getAssetUrl } from "../../utils/assets";

const PLUGIN_CODE = "my-plugin";

export const MyPlugin: React.FC<{ ctx: any }> = ({ ctx }) => {
  const logoUrl = getAssetUrl(PLUGIN_CODE, "images/logo.svg");
  const badgeUrl = getAssetUrl(PLUGIN_CODE, "images/badge.png");

  return (
    <div>
      <img src={logoUrl} alt="Logo" />
      <img src={badgeUrl} alt="Badge" />
    </div>
  );
};
```

#### Using Assets in CSS/SCSS

For CSS, you have two options:

**Option 1: Inline styles with dynamic URLs (Recommended)**

```tsx
const MyPlugin: React.FC = () => {
  const bgUrl = getAssetUrl("my-plugin", "images/background.jpg");

  return <div style={{ backgroundImage: `url(${bgUrl})` }}>Content</div>;
};
```

**Option 2: CSS with relative paths (for dev only)**

```scss
// This only works in dev mode!
.container {
  background-image: url("/src/assets/images/background.jpg");
}
```

> **Note:** CSS with hardcoded paths won't work in production. Use inline styles with `getAssetUrl()` for background images.

#### Using Custom Fonts

```tsx
import { getAssetUrl } from "../../utils/assets";

const PLUGIN_CODE = "my-plugin";

// Dynamically inject font-face
const injectFont = () => {
  const fontUrl = getAssetUrl(PLUGIN_CODE, "fonts/custom-font.woff2");
  const style = document.createElement("style");
  style.textContent = `
    @font-face {
      font-family: 'CustomFont';
      src: url('${fontUrl}') format('woff2');
      font-weight: normal;
      font-style: normal;
    }
  `;
  document.head.appendChild(style);
};

export const MyPlugin: React.FC = () => {
  React.useEffect(() => {
    injectFont();
  }, []);

  return <div style={{ fontFamily: "CustomFont" }}>Text with custom font</div>;
};
```

### Dev vs Production URLs

| Environment    | Bundle URL                                    | Asset URL                                               |
| -------------- | --------------------------------------------- | ------------------------------------------------------- |
| **Dev**        | `http://localhost:4500/src/index.tsx`         | `/src/assets/images/logo.svg`                           |
| **Production** | `https://domain.com/plugins/.../my-plugin.js` | `https://domain.com/plugins/.../assets/images/logo.svg` |

The `getAssetUrl()` helper handles this difference automatically.

### Important Considerations

1. **Always use `getAssetUrl()` for assets**

   ```typescript
   // ❌ This won't work in production
   import logo from "./assets/logo.svg";
   <img src="/src/assets/images/logo.svg" />;

   // ✅ Use the included utility
   import { getAssetUrl } from "../../utils/assets";
   const logo = getAssetUrl("my-plugin", "images/logo.svg");
   <img src={logo} />;
   ```

2. **Icon is handled separately**

   - The plugin icon (`src/assets/icon.svg`) is uploaded as a separate file
   - It's not included in the assets folder of the ZIP
   - The icon is used in the Prolibu plugin catalog

3. **CSS is embedded in the bundle**

   - All `.scss` and `.css` files imported in your components are bundled into the JS
   - The `cssInjectedByJsPlugin` injects styles when the plugin loads
   - No separate CSS files are served

4. **File size considerations**
   - Large assets increase the ZIP size and upload time
   - Consider using external CDNs for very large files
   - Optimize images before adding them

---

## Plugin Studio

The development environment includes a Figma-like interface for plugin development.

### Features

- **Component Preview**: Resizable and draggable frame (default 800x600px)
- **Drag & Drop**: Click and drag the frame to reposition it on the canvas
- **Resize**: Drag the edges or corner to resize the preview frame
- **File Viewer**: Built-in code viewer with syntax highlighting
- **Zoom Controls**: 25% - 200% zoom
- **Publish Button**: One-click build and deploy
- **Property Panel**: View plugin info and form schema

### Keyboard Shortcuts & Interactions

| Action               | Description                         |
| -------------------- | ----------------------------------- |
| `Escape`             | Close file viewer                   |
| `Drag frame`         | Move the preview anywhere on canvas |
| `Drag edges/corner`  | Resize the preview frame            |
| `Double-click frame` | Reset size to 800×600 and center    |

### Publish from Studio

Click the "Publish" button to:

1. Build the plugin with Vite
2. Upload to production API
3. Show success/error feedback

This calls the same `prolibu plugin prod` command internally.

---

## Plugin Entry Point

### src/index.tsx

```typescript
import { MyPlugin } from "./plugins/MyPlugin/MyPlugin";

// Re-export FormRenderer for use in plugins (optional)
export { FormRenderer } from "./utils/FormRenderer";

// Helper to create render function
const createRenderFn = (Component: React.ComponentType<any>) => {
  return (node: HTMLElement, opts: any = {}, mode = "prod") => {
    if (mode === "dev") return Component;

    const draw = (attempts: number) => {
      if (attempts > 10) return;
      if (typeof window.ReactDOM?.createRoot === "function") {
        const root = window.ReactDOM.createRoot(node);
        root.render(window.React.createElement(Component, { ctx: opts }));
      } else {
        setTimeout(() => draw(attempts + 1), 100);
      }
    };
    draw(0);
  };
};

export default {
  components: [
    {
      active: true,
      label: "My Plugin",
      containerId: "my-plugin-plugin",
      description: "Plugin description",
      render: createRenderFn(MyPlugin),
      icon: "/assets/icon.svg",
      // JSON Schema format (Formily compatible)
      formSchema: {
        type: "object",
        properties: {
          theme: {
            type: "string",
            title: "Theme",
            enum: ["light", "dark"],
            default: "light",
          },
          message: {
            type: "string",
            title: "Message",
            default: "Hello!",
            description: "Welcome message",
          },
          showHeader: {
            type: "boolean",
            title: "Show Header",
            default: true,
          },
        },
      },
    },
  ],
};
```

> **⚠️ REGLA OBLIGATORIA: containerId**
>
> El `containerId` **DEBE** ser el mismo nombre del `name` en `package.json` con el sufijo `-plugin`.
>
> | package.json name | containerId (obligatorio) |
> | ----------------- | ------------------------- |
> | `calculadora`     | `calculadora-plugin`      |
> | `my-widget`       | `my-widget-plugin`        |
> | `sales-dashboard` | `sales-dashboard-plugin`  |
>
> **Ejemplo:** Si tu `package.json` tiene `"name": "calculadora"`, entonces `containerId` debe ser `"calculadora-plugin"`.

### Component Interface

```typescript
interface PluginComponentProps {
  ctx: {
    formSchemaModel: {
      model: Record<string, any>;
    };
    // Additional context from Prolibu platform
  };
}
```

---

## Troubleshooting

### Common Issues

**"No API key found for domain"**

- Run `prolibu plugin create` first to configure the API key
- Or manually create `accounts/<domain>/profile.json` with `{ "apiKey": "..." }`

**"No bundle found in dist"**

- Ensure `vite.config.js` has correct `fileName` configuration
- Check build output for errors

**"fsevents" error on macOS**

- Add to vite.config.js:
  ```javascript
  optimizeDeps: {
    exclude: ["fsevents"];
  }
  ```

**Icon not uploading**

- Place icon file in `src/assets/`
- Supported formats: `.svg`, `.png`, `.jpg`, `.gif`
