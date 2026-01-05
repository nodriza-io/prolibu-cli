# Virtual Tour CLI

Herramienta CLI moderna para gestionar Virtual Tours de Prolibu. Permite crear, descargar y subir tours masivamente con una interfaz de línea de comandos sofisticada.

## ✨ Características

- 🚀 **Bulk Upload**: Sube múltiples tours desde estructura de carpetas
- 📥 **Download**: Descarga tours existentes para editarlos localmente
- 🚗 **Automotive**: Soporte completo para configuradores de autos (colores externos/internos)
- 🏠 **Spaces**: Soporte para tours de espacios/inmobiliario (panoramas + floor plans)
- 📊 **UI Moderna**: Spinners, barras de progreso y tablas de resultados
- 👀 **Watch Mode**: Auto-upload al detectar cambios
- ⚙️ **Configuración Flexible**: Funciona con o sin archivos de config

## 🏷️ Tipos de Tour

### 🚗 Automotive (default)

Para configuradores de vehículos con:

- Colores externos (carrocería)
- Colores internos (interior)
- Scenes organizadas por color

### 🏠 Spaces

Para tours de espacios/inmobiliario con:

- Panoramas 360° directos
- Floor plans (planos de piso)
- Navegación entre espacios

## 📁 Estructura de Carpetas

### Estructura Automotive

```
virtualTours/
└── NOMBRE_TOUR/                    # El nombre de la carpeta = virtualTourCode
    ├── _config.json                # Opcional: metadatos del tour
    ├── _colors/                    # Texturas de colores
    │   ├── external/               # Colores externos (carrocería)
    │   │   ├── azul-portimao.webp
    │   │   └── blanco-alpino.png
    │   └── internal/               # Colores internos (interior)
    │       ├── veganza-mocha.png
    │       └── veganza-ostra.webp
    ├── external/                   # Scenes externas
    │   └── {color-slug}/           # Carpeta por color
    │       └── seq_*.png           # Archivos de secuencia
    └── internal/                   # Scenes internas
        └── {color-slug}/
            ├── 2d_*.jpeg           # Imágenes 2D
            ├── 360_*.webp          # Panoramas 360°
            └── seq_*.png           # Secuencias
```

### Estructura Spaces

```
virtualTours/
└── NOMBRE_TOUR/                    # El nombre de la carpeta = virtualTourCode
    ├── _config.json                # Opcional: metadatos del tour
    ├── _floorplans/                # Planos de piso (opcional)
    │   ├── planta-baja.jpg
    │   └── segundo-piso.png
    └── scenes/                     # Panoramas 360°
        ├── 360_sala-principal.webp
        ├── 360_cocina.webp
        ├── 360_habitacion.webp
        └── 360_terraza.jpg
```

## 🏷️ Convenciones de Nombres

### Prefijos de Archivos

| Prefijo | Tipo de Scene | Descripción                       |
| ------- | ------------- | --------------------------------- |
| `2d_`   | 2D            | Cada archivo = 1 scene            |
| `360_`  | 360           | Cada archivo = 1 scene panorámica |
| `seq_`  | Sequence      | Múltiples archivos = 1 scene      |

### Ejemplos

```
seq_001.png, seq_002.png, seq_003.png  → 1 scene tipo "sequence" con 3 frames
2d_dashboard.jpeg                       → 1 scene tipo "2d"
360_interior.webp                       → 1 scene tipo "360"
```

## 🚀 Comandos

### Crear Proyecto

```bash
./prolibu vt create --domain dev11.prolibu.com --prefix my-project
```

### Subir Tours (Bulk Upload)

```bash
# Subir todos los tours (Automotive por defecto)
./prolibu vt bulk --domain dev11.prolibu.com --prefix my-project

# Subir tours de tipo Spaces
./prolibu vt bulk --domain dev11.prolibu.com --prefix my-project --type spaces

# Subir un tour específico
./prolibu vt bulk --domain dev11.prolibu.com --prefix my-project --tour BMW_81AP

# Modo watch (auto-upload al detectar cambios)
./prolibu vt bulk --domain dev11.prolibu.com --prefix my-project --watch
```

### Descargar Tour Existente

```bash
./prolibu vt download --domain dev11.prolibu.com --prefix my-project --id 69416e08729e7ce2b7dca043
```

Esto descarga el tour completo incluyendo:

- Todas las scenes con sus archivos de media
- Colores (texturas) externos e internos (para Automotive)
- Floor plans (para Spaces)
- Configuración del tour

## ⚙️ Configuración

### \_config.json (Opcional)

Cada tour puede tener un archivo `_config.json` para personalizar metadatos:

**Para Automotive:**

```json
{
  "virtualTourName": "BMW 218 Gran Coupé",
  "description": "Virtual tour del nuevo BMW Serie 2",
  "eventType": "Automotive",
  "config": {
    "theme": "flow"
  }
}
```

**Para Spaces:**

```json
{
  "virtualTourName": "Apartamento Centro",
  "description": "Tour virtual del apartamento en el centro",
  "eventType": "Spaces",
  "config": {
    "theme": "cascade",
    "floorPlan": { "showOpened": true },
    "hotspots": { "enableAudio": true }
  }
}
```

**Si no existe `_config.json`:**

- `virtualTourName` = nombre de la carpeta formateado (ej: `BMW_81AP` → `Bmw 81ap`)
- `virtualTourCode` = nombre exacto de la carpeta
- `description` = generado automáticamente
- `eventType` = detectado por `--type` flag o "Automotive" por defecto

### settings.json

```json
{
  "virtualToursFolder": "./virtualTours"
}
```

## 📊 Interfaz de Usuario

El CLI muestra una interfaz moderna con:

```
╔════════════════════════════════════════════════════════════╗
║                 VIRTUAL TOUR BULK CREATOR                  ║
║                      Prolibu CLI v1.0                      ║
╚════════════════════════════════════════════════════════════╝

  ⚙️  Configuration
  ────────────────────────────────────────────────────────
  • Domain: dev11.prolibu.com
  • Path: ./virtualTours

✓ API connected
✓ Config: BMW 218 Gran Coupé
✓ Colors: 11 registered
✓ VirtualTour: 694af4b6c2729d25d60af809

  █████████░░░░░░░░░░░ 45% | 4/9 scenes | Dashboard (2d)

┌─────────────────────────┬──────────┬──────────┬──────────┐
│ Tour                    │ Status   │ Scenes   │ Colors   │
├─────────────────────────┼──────────┼──────────┼──────────┤
│ BMW_218_GRAN_COUPE      │ ✓ OK     │ 9        │ 11       │
└─────────────────────────┴──────────┴──────────┴──────────┘
```

## 🎨 Colores Automotivos

Los colores se suben como archivos de imagen (texturas) y se asocian automáticamente a las scenes.

### Estructura de Colores

```
_colors/
├── external/           # Para scenes externas (carrocería)
│   ├── azul-portimao.webp
│   ├── blanco-alpino.png
│   └── negro-zafiro.webp
└── internal/           # Para scenes internas (interior)
    ├── veganza-mocha.png
    └── veganza-ostra.webp
```

### Asociación Automática

El nombre del archivo de color (sin extensión) se mapea a las carpetas de scenes:

```
_colors/external/azul-portimao.webp  →  external/azul-portimao/seq_*.png
_colors/internal/veganza-mocha.png   →  internal/veganza-mocha/2d_*.jpeg
```

## 📂 Ejemplo Completo

```
virtualTours/
└── BMW_218_GRAN_COUPE/
    ├── _config.json
    ├── _colors/
    │   ├── external/
    │   │   ├── azul-portimao.webp
    │   │   ├── blanco-alpino.webp
    │   │   └── negro-zafiro.webp
    │   └── internal/
    │       ├── veganza-mocha.png
    │       └── veganza-ostra.png
    ├── external/
    │   ├── azul-portimao/
    │   │   ├── seq_001.png
    │   │   ├── seq_002.png
    │   │   └── ... (36 frames)
    │   ├── blanco-alpino/
    │   │   └── seq_*.png
    │   └── negro-zafiro/
    │       └── seq_*.png
    └── internal/
        ├── veganza-mocha/
        │   ├── 2d_dashboard.jpeg
        │   ├── 2d_asientos.jpeg
        │   └── 360_interior.webp
        └── veganza-ostra/
            └── 2d_*.jpeg
```

## 🔧 Flujo de Trabajo Recomendado

### 1. Crear desde cero

```bash
# 1. Crear proyecto
./prolibu vt create --domain dev11.prolibu.com --prefix bmw

# 2. Agregar carpetas de tours en virtualTours/
# 3. Subir
./prolibu vt bulk --domain dev11.prolibu.com --prefix bmw
```

### 2. Editar tour existente

```bash
# 1. Descargar tour
./prolibu vt download --domain dev11.prolibu.com --prefix bmw --id <tour-id>

# 2. Editar archivos localmente
# 3. Re-subir (crear nuevo tour con los cambios)
./prolibu vt bulk --domain dev11.prolibu.com --prefix bmw
```

## 📋 Formatos Soportados

| Tipo     | Extensiones                                       |
| -------- | ------------------------------------------------- |
| Imágenes | `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.avif` |

## ⚠️ Notas Importantes

1. **virtualTourCode único**: Cada carpeta de tour debe tener un nombre único. Si ya existe un tour con ese código, el upload fallará.

2. **Orden de archivos**: Para secuencias, los archivos se ordenan alfabéticamente. Usa padding con ceros: `seq_001.png`, `seq_002.png`, etc.

3. **Colores opcionales**: Si no hay carpeta `_colors/`, las scenes se crean sin color asociado.

4. **Carpetas alternativas**: Se soportan tanto `external/internal` como `exterior/interior`.

```

```
