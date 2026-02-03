# Sistema de Paquetes de Plugins

## Resumen

Los plugins se distribuyen como paquetes ZIP que contienen el bundle JavaScript y assets adicionales (imágenes, CSS, etc.). El backend descomprime el paquete y sirve los archivos desde una carpeta pública.

---

## Flujo Completo

```
┌─────────────┐     ZIP      ┌─────────────┐    unzip    ┌─────────────┐
│   CLI       │ ──────────▶  │   Backend   │ ──────────▶ │   S3/Public │
│  (build)    │   upload     │  (Plugin)   │             │   folder    │
└─────────────┘              └─────────────┘             └─────────────┘
                                    │
                                    │ bundleUrl (computed)
                                    ▼
                             ┌─────────────┐    <script>  ┌─────────────┐
                             │  Frontend   │ ──────────▶  │   Plugin    │
                             │  (Editor)   │    inject    │  (React)    │
                             └─────────────┘              └─────────────┘
```

---

## 1. CLI - Build & Upload

```bash
./prolibu plugin prod --domain dev11.prolibu.com --prefix my-plugin
```

**Proceso:**
1. Vite build → `dist/my-plugin.js` (UMD bundle)
2. ZIP → `dist.zip` con:
   - `my-plugin.js`
   - `assets/` (imágenes, CSS, etc.)
3. Upload via `PATCH /v2/plugin/{pluginCode}` (multipart/form-data)

**Estructura del ZIP:**
```
dist.zip
├── my-plugin.js        # Bundle principal
└── assets/
    ├── icon.svg
    ├── extra-styles.css
    └── images/
        └── badge.svg
```

---

## 2. Backend - Recepción y Unzip

**Schema del Plugin:**
```javascript
{
  pluginCode: String,
  pluginName: String,
  package: { type: ObjectId, ref: 'File' },  // ZIP file
  createdBy: { type: ObjectId, ref: 'User' },
}
```

**Proceso al recibir package:**
1. Guarda ZIP en S3
2. Ejecuta `File.unzipAction()` → extrae a `/public/plugins/{pluginCode}/`
3. **Valida** que el paquete contenga `{pluginCode}.js` (lanza error si no existe)

**bundleUrl (calculado por frontend):**
```javascript
// El frontend calcula la URL usando la convención {pluginCode}.js
bundleUrl = `${origin}/plugins/${createdBy}/public/plugins/${pluginCode}/${pluginCode}.js`
```

**Resultado en S3:**
```
/plugins/{userId}/public/plugins/my-plugin/
├── my-plugin.js
└── assets/
    └── images/
        └── badge.svg
```

---

## 3. Frontend - Carga del Plugin

**PluginService.ts:**
```typescript
import { computeBundleUrl } from '../utils/plugin';

ApiClient.Plugin.find({
  select: 'pluginCode pluginName active version icon createdBy',
});

// El frontend calcula bundleUrl para cada plugin
plugins.map(plugin => ({
  ...plugin,
  bundleUrl: computeBundleUrl(plugin),
}));
```

**utils/plugin.ts:**
```typescript
export function computeBundleUrl(
  plugin: { createdBy?: { _id: string } | string; pluginCode: string },
  origin?: string
): string {
  const baseUrl = origin || window.location.origin;
  const createdById = typeof plugin.createdBy === 'object'
    ? plugin.createdBy._id
    : plugin.createdBy;
  return `${baseUrl}/plugins/${createdById}/public/plugins/${plugin.pluginCode}/${plugin.pluginCode}.js`;
}
```

**usePluginStore.js:**
```javascript
for (const plugin of this.plugins) {
  if (plugin.bundleUrl) {
    window[plugin.pluginCode] = {};
    const tagId = `${plugin.pluginCode}-js`;
    await tagManager.create(plugin.bundleUrl, tagId);
  }
}
```

**Resultado:** Se inyecta `<script id="my-plugin-js" src="{bundleUrl}">` en el DOM.

---

## 4. Plugin - Acceso a Assets

Desde dentro del plugin, obtener la URL base usando el ID del script:

```typescript
const getPluginBaseUrl = (pluginCode: string): string => {
  const script = document.getElementById(`${pluginCode}-js`) as HTMLScriptElement;
  if (script?.src) {
    return script.src.replace(/\/[^/]+\.js$/, '');
  }
  return '';
};

// Uso
const baseUrl = getPluginBaseUrl('my-plugin');
const badgeUrl = `${baseUrl}/assets/images/badge.svg`;
```

---

## Archivos Clave

| Componente | Archivo |
|------------|---------|
| CLI Build | `cli/commands/plugin/run.js` |
| CLI ZIP | `cli/builders/pluginBuilder.js` |
| API Client | `api/pluginClient.js` |
| Frontend Service | `template-editor/src/services/PluginService.ts` |
| Frontend Store | `template-editor/.../usePluginStore.js` |

---

## Comandos

```bash
# Desarrollo (HMR, no sube)
./prolibu plugin dev --domain dev11.prolibu.com --prefix my-plugin

# Producción (build + zip + upload)
./prolibu plugin prod --domain dev11.prolibu.com --prefix my-plugin
```
