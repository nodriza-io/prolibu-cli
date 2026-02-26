# Plan de Migración: RPM Widgets → formily-antd-complete

> **Objetivo**: Mover `SectionsEditor` y `FooterTableEditor` al paquete npm
> `formily-antd-complete` bajo el namespace `src/rpm/`, siguiendo el patrón
> canónico del paquete (ver `reference/RichText.tsx`).

---

## Estructura de esta carpeta

```
docs/rpm-migration/
├── PLAN.md                          ← este archivo
├── source/
│   ├── SectionsEditor.tsx           ← código fuente actual (con marcas 🔧)
│   └── FooterTableEditor.tsx        ← código fuente actual (con marcas 🔧)
└── reference/
    └── RichText.tsx                 ← patrón canónico a seguir
```

Los archivos `source/` contienen el código **TAL CUAL está** en `shared/components/`.
Las adaptaciones necesarias están marcadas con `🔧 ADAPTAR #N` en comentarios
dentro de cada archivo. **No escribas desde cero**: copia el fuente, aplica las
marcas 🔧 y listo.

---

## Repo destino

- **Repositorio**: `github.com/wilmaribg/antd`
- **Paquete npm**: `formily-antd-complete`
- **Versión actual**: `1.0.3` → **nueva versión**: `1.0.4`
- **Build**: `tsc -p tsconfig.build.json`
- **Entry point**: `lib/index.js` / `lib/index.d.ts`

---

## Paso 0 — Clonar y preparar

```bash
git clone git@github.com:wilmaribg/antd.git
cd antd
npm install
git checkout -b feat/rpm-widgets
```

---

## Paso 1 — Crear estructura `src/rpm/`

```bash
mkdir -p src/rpm/sections-editor
mkdir -p src/rpm/footer-table-editor
```

Archivos a crear:

```
src/rpm/
├── index.ts                           ← barrel del namespace RPM
├── sections-editor/
│   └── index.tsx                       ← SectionsEditor adaptado
└── footer-table-editor/
    └── index.tsx                       ← FooterTableEditor adaptado
```

---

## Paso 2 — Adaptar `SectionsEditor`

Copiar `source/SectionsEditor.tsx` → `src/rpm/sections-editor/index.tsx`

Aplicar las 5 marcas 🔧:

### 🔧 #1 — Import RichText (ruta interna)

```diff
- import { RichText } from "formily-antd-complete";
+ import { RichText } from "../../rich-text";
```

### 🔧 #2 — Import mapReadPretty

```diff
- import { connect, mapProps } from "@formily/react";
+ import { connect, mapProps, mapReadPretty } from "@formily/react";
```

### 🔧 #3 — Export interface pública

Descomentar y activar:

```typescript
export interface SectionsEditorProps {
  value?: string | Record<string, SectionConfig>;
  onChange?: (value: string) => void;
  disabled?: boolean;
  readOnly?: boolean;
}
```

### 🔧 #4 — Agregar ReadPretty preview

Descomentar y activar:

```typescript
const SectionsEditorPreview: React.FC<{ value?: string }> = ({ value }) => {
  if (!value) return <span>-</span>;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    const count = Object.keys(parsed).length;
    return <span>{count} sección(es)</span>;
  } catch {
    return <span>-</span>;
  }
};
```

### 🔧 #5 — mapReadPretty en connect

```diff
  export const SectionsEditor = connect(
    SectionsEditorInner,
    mapProps((props: any) => ({
      ...props,
      disabled: props.disabled || props.readOnly,
    })),
+   mapReadPretty(SectionsEditorPreview),
  );
```

---

## Paso 3 — Adaptar `FooterTableEditor`

Copiar `source/FooterTableEditor.tsx` → `src/rpm/footer-table-editor/index.tsx`

Aplicar las 4 marcas 🔧:

### 🔧 #1 — Import mapReadPretty

```diff
- import { connect, mapProps } from "@formily/react";
+ import { connect, mapProps, mapReadPretty } from "@formily/react";
```

### 🔧 #2 — Export interface pública

```typescript
export interface FooterTableEditorProps {
  value?: string | { label: string; value: string }[];
  onChange?: (value: string) => void;
  disabled?: boolean;
  readOnly?: boolean;
}
```

### 🔧 #3 — Agregar ReadPretty preview

```typescript
const FooterTableEditorPreview: React.FC<{ value?: string }> = ({ value }) => {
  if (!value) return <span>-</span>;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    const count = Array.isArray(parsed) ? parsed.length : 0;
    return <span>{count} fila(s)</span>;
  } catch {
    return <span>-</span>;
  }
};
```

### 🔧 #4 — mapReadPretty en connect

```diff
  export const FooterTableEditor = connect(
    FooterTableEditorInner,
    mapProps((props: any) => ({
      ...props,
      disabled: props.disabled || props.readOnly,
    })),
+   mapReadPretty(FooterTableEditorPreview),
  );
```

---

## Paso 4 — Barrel `src/rpm/index.ts`

Crear `src/rpm/index.ts`:

```typescript
export * from './sections-editor'
export * from './footer-table-editor'
```

---

## Paso 5 — Registrar namespace en `src/index.ts`

Agregar **una sola línea** al final del barrel existente:

```diff
  export * from './upload'
+ export * from './rpm'
```

> Después de esto, los consumidores importan directamente:
> ```typescript
> import { SectionsEditor, FooterTableEditor } from "formily-antd-complete";
> ```

---

## Paso 6 — Bump versión

En `package.json`:

```diff
- "version": "1.0.3",
+ "version": "1.0.4",
```

---

## Paso 7 — Build & Validar

```bash
npm run build          # tsc -p tsconfig.build.json

# Verificar que se generaron los archivos:
ls lib/rpm/
# → index.js  index.d.ts
# → sections-editor/index.js  sections-editor/index.d.ts
# → footer-table-editor/index.js  footer-table-editor/index.d.ts

# Verificar que el barrel raíz re-exporta:
grep "SectionsEditor" lib/index.d.ts
grep "FooterTableEditor" lib/index.d.ts
```

---

## Paso 8 — Publicar

```bash
npm publish
```

---

## Paso 9 — Actualizar consumidores (prolibu-cli)

En el proyecto `prolibu-cli`:

```bash
npm install formily-antd-complete@1.0.4
```

Luego en `shared/FormRenderer.tsx`, cambiar los imports locales por imports
desde el paquete npm:

```diff
- import { SectionsEditor } from "./components/SectionsEditor";
- import { FooterTableEditor } from "./components/FooterTableEditor";
+ import { SectionsEditor, FooterTableEditor } from "formily-antd-complete";
```

Y se puede eliminar:
- `shared/components/SectionsEditor.tsx`
- `shared/components/FooterTableEditor.tsx`

---

## Checklist resumen

| # | Tarea | Archivo(s) |
|---|-------|------------|
| 1 | Crear `src/rpm/sections-editor/index.tsx` | Adaptar `source/SectionsEditor.tsx` (5 marcas 🔧) |
| 2 | Crear `src/rpm/footer-table-editor/index.tsx` | Adaptar `source/FooterTableEditor.tsx` (4 marcas 🔧) |
| 3 | Crear `src/rpm/index.ts` | Barrel: 2 re-exports |
| 4 | Editar `src/index.ts` | Agregar `export * from './rpm'` |
| 5 | Editar `package.json` | version: `1.0.3` → `1.0.4` |
| 6 | Build | `npm run build` |
| 7 | Validar | `ls lib/rpm/` + grep exports |
| 8 | Publicar | `npm publish` |
| 9 | Actualizar prolibu-cli | `npm install formily-antd-complete@1.0.4` |
| 10 | Limpiar shared/components/ | Eliminar SectionsEditor.tsx + FooterTableEditor.tsx |

---

## Datos de referencia: JSON Schema `format` values

Los plugins de Prolibu usan el campo `format` en JSON Schema para indicar
qué widget renderizar. La correspondencia es:

| `format` en JSON Schema | `x-component` Formily | Export del paquete |
|--------------------------|------------------------|--------------------|
| `sections-editor` | `SectionsEditor` | `SectionsEditor` |
| `footer-table-editor` | `FooterTableEditor` | `FooterTableEditor` |
| `rich-text` | `RichText` | `RichText` |

---

## Estructura de datos

### SectionsEditor

```json
{
  "Familia A": {
    "title": "Título opcional",
    "notes": "<p>HTML con notas</p>",
    "order": 0,
    "customRows": [
      { "description": "Desc", "value": "Val", "position": "start|end" }
    ]
  }
}
```

### FooterTableEditor

```json
[
  { "label": "FORMA DE PAGO", "value": "Crédito a 30 días" },
  { "label": "VALIDEZ",       "value": "30 días" }
]
```
