# Documento Técnico: Custom UI

## Tabla de Contenidos

1. [Introducción](#introducción)
2. [Conceptos Clave](#conceptos-clave)
3. [Tipos de Custom UI](#tipos-de-custom-ui)
4. [Sidebar - Enlaces en Barra Lateral](#sidebar---enlaces-en-barra-lateral)
5. [Topbar - Enlaces en Barra Superior](#topbar---enlaces-en-barra-superior)
6. [Stage Widget - Widgets en Etapas](#stage-widget---widgets-en-etapas)
7. [Field Widget - Widgets de Campo](#field-widget---widgets-de-campo)
8. [Table Row Action - Acciones de Fila](#table-row-action---acciones-de-fila)
9. [Table Cell Widget - Widgets de Celda](#table-cell-widget---widgets-de-celda)
10. [Default Table Columns - Columnas Predeterminadas](#default-table-columns---columnas-predeterminadas)
11. [Códig JavaScript en Custom UIs](#código-javascript-en-custom-uis)
12. [Ejemplos Prácticos](#ejemplos-prácticos)
13. [API Reference](#api-reference)
14. [Mejores Prácticas](#mejores-prácticas)
15. [Troubleshooting](#troubleshooting)

---

## Introducción

Los **Custom UIs** permiten extender y personalizar la interfaz de usuario del sistema sin modificar el código fuente. Con Custom UIs puedes:

- **Agregar enlaces personalizados** en la barra lateral o superior
- **Crear widgets personalizados** que se renderizan en diferentes contextos
- **Personalizar acciones de tabla** con botones y lógica custom
- **Modificar la visualización de celdas** en tablas con componentes custom
- **Ejecutar código JavaScript** en contextos específicos de la aplicación

Los Custom UIs se crean y gestionan a través del modelo `CustomUi` y se aplican dinámicamente en el frontend según su configuración.

---

## Conceptos Clave

### Modelo CustomUi

**Ubicación**: `/app/modules/system/models/CustomUi.js`

Cada Custom UI tiene los siguientes atributos principales:

```javascript
{
  customUiCode: String,        // Código único generado automáticamente
  customUiName: String,        // Nombre descriptivo (requerido)
  customUiType: String,        // Tipo de Custom UI (required)
  code: String,                // Código JavaScript a ejecutar
  active: Boolean,             // Estado activo/inactivo
  // ... campos específicos según customUiType
}
```

### Tipos de Custom UI

El sistema soporta **7 tipos** de Custom UI:

| Tipo                      | Descripción                     | Uso Principal                       |
| ------------------------- | ------------------------------- | ----------------------------------- |
| **Sidebar**               | Enlaces en barra lateral        | Navegación custom, links externos   |
| **Topbar**                | Enlaces en barra superior       | Accesos rápidos, integraciones      |
| **Stage Widget**          | Widgets en etapas de pipeline   | Visualizaciones custom, métricas    |
| **Field Widget**          | Widgets en campos de formulario | Inputs personalizados, validaciones |
| **Table Row Action**      | Acciones en filas de tabla      | Botones custom, operaciones batch   |
| **Table Cell Widget**     | Widgets en celdas de tabla      | Renderizado custom de datos         |
| **Default Table Columns** | Columnas por defecto            | Configuración de vistas de tabla    |

### Ejecución de Código

Los Custom UIs pueden ejecutar **código JavaScript** que se evalúa en el contexto del frontend. El código tiene acceso a:

- Variables del contexto (record, user, etc.)
- APIs del sistema (axios, lodash, etc.)
- Funciones globales del framework

---

## Sidebar - Enlaces en Barra Lateral

### Descripción

Permite agregar enlaces personalizados en la barra lateral de navegación principal.

### Estructura

```javascript
{
  customUiName: 'Mi Link Custom',
  customUiType: 'Sidebar',
  active: true,
  sideBar: {
    label: 'Documentación',
    url: 'https://docs.example.com',
    target: '_blank',              // '_blank', '_self', '_parent', '_top'
    icon: '<fileId>',              // ObjectId de un archivo de icono
    insertBefore: 'Configuration'  // Insertar antes de este elemento
  },
  code: '' // Opcional
}
```

### Propiedades

| Propiedad      | Tipo     | Requerido | Descripción                                   |
| -------------- | -------- | --------- | --------------------------------------------- |
| `label`        | String   | Sí        | Texto del enlace                              |
| `url`          | String   | Sí        | URL destino                                   |
| `target`       | String   | No        | Comportamiento del link (\_blank por defecto) |
| `icon`         | ObjectId | No        | Referencia a File para el icono               |
| `insertBefore` | String   | No        | Clave del elemento antes del cual insertar    |

### Ejemplo Básico

```javascript
// Crear enlace a documentación externa
const customUi = await CustomUi.create({
  customUiName: "Documentación API",
  customUiType: "Sidebar",
  active: true,
  sideBar: {
    label: "API Docs",
    url: "https://developers.example.com",
    target: "_blank",
  },
});
```

### Ejemplo con Icono

```javascript
// Primero subir el icono
const iconFile = await File.create({
  filename: "docs-icon.svg",
  // ... otras propiedades del archivo
});

// Crear enlace con icono personalizado
const customUi = await CustomUi.create({
  customUiName: "Portal de Soporte",
  customUiType: "Sidebar",
  active: true,
  sideBar: {
    label: "Soporte",
    url: "https://support.example.com",
    target: "_blank",
    icon: iconFile._id,
  },
});
```

### Ejemplo con Posicionamiento

```javascript
// Insertar antes del menú de Configuración
const customUi = await CustomUi.create({
  customUiName: "Recursos",
  customUiType: "Sidebar",
  active: true,
  sideBar: {
    label: "Recursos",
    url: "/recursos",
    target: "_self",
    insertBefore: "Configuration",
  },
});
```

---

## Topbar - Enlaces en Barra Superior

### Descripción

Similar a Sidebar pero los enlaces aparecen en la barra superior de navegación.

### Estructura

```javascript
{
  customUiName: 'Mi Link Topbar',
  customUiType: 'Topbar',
  active: true,
  // Configuración similar a sideBar
  // (El modelo usa campos dinámicos)
}
```

### Ejemplo

```javascript
const customUi = await CustomUi.create({
  customUiName: "Dashboard Analítico",
  customUiType: "Topbar",
  active: true,
  code: `
    // Código para abrir dashboard en nueva pestaña
    window.open('https://analytics.example.com/dashboard', '_blank');
  `,
});
```

---

## Stage Widget - Widgets en Etapas

### Descripción

Renderiza widgets personalizados en las etapas de un pipeline (Deals, Opportunities, etc.).

### Uso

Ideal para mostrar métricas, gráficos o información contextual relacionada con una etapa específica del pipeline.

### Estructura

```javascript
{
  customUiName: 'Widget de Métrica',
  customUiType: 'Stage Widget',
  active: true,
  code: `
    // JavaScript que renderiza el widget
    (function() {
      const stage = window.currentStage; // Acceso al contexto
      const deals = window.currentDeals;

      // Renderizar HTML custom
      const html = \`
        <div class="custom-widget">
          <h3>Métrica: \${stage.stageName}</h3>
          <p>Total Deals: \${deals.length}</p>
        </div>
      \`;

      return html;
    })();
  `
}
```

### Ejemplo: Widget de Progreso

```javascript
const customUi = await CustomUi.create({
  customUiName: "Progreso de Etapa",
  customUiType: "Stage Widget",
  active: true,
  code: `
    (function() {
      const stage = window.currentStage || {};
      const deals = window.currentDeals || [];
      
      // Calcular estadísticas
      const total = deals.length;
      const totalAmount = deals.reduce((sum, d) => sum + (d.amount || 0), 0);
      const avgAmount = total > 0 ? totalAmount / total : 0;
      
      // Generar HTML
      return \`
        <div style="padding: 16px; background: #f8f9fa; border-radius: 8px; margin: 10px 0;">
          <h4 style="margin: 0 0 12px 0; color: #333;">\${stage.stageName || 'Stage'}</h4>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div>
              <div style="font-size: 12px; color: #666;">Total Deals</div>
              <div style="font-size: 24px; font-weight: bold; color: #007bff;">\${total}</div>
            </div>
            <div>
              <div style="font-size: 12px; color: #666;">Promedio</div>
              <div style="font-size: 24px; font-weight: bold; color: #28a745;">
                $\${avgAmount.toFixed(2)}
              </div>
            </div>
          </div>
        </div>
      \`;
    })();
  `,
});
```

---

## Field Widget - Widgets de Campo

### Descripción

Permite crear widgets personalizados para campos específicos de un modelo. Se renderiza en lugar del input estándar del campo.

### Estructura

```javascript
{
  customUiName: 'Widget de Campo Custom',
  customUiType: 'Field Widget',
  active: true,
  fieldWidget: {
    modelName: 'Contact',      // Modelo donde aplica
    fieldName: 'status'        // Campo específico (key route)
  },
  code: `
    // JavaScript para renderizar el widget
  `
}
```

### Propiedades

| Propiedad   | Tipo   | Requerido | Descripción                                  |
| ----------- | ------ | --------- | -------------------------------------------- |
| `modelName` | String | Sí        | Modelo donde se aplica (Contact, Deal, etc.) |
| `fieldName` | String | Sí        | Ruta del campo (key route)                   |

### Ejemplo: Selector de Color Custom

```javascript
const customUi = await CustomUi.create({
  customUiName: "Selector de Prioridad",
  customUiType: "Field Widget",
  active: true,
  fieldWidget: {
    modelName: "Deal",
    fieldName: "priority",
  },
  code: `
    (function() {
      const value = window.fieldValue || 'medium';
      const fieldName = window.fieldName;
      
      const colors = {
        low: '#28a745',
        medium: '#ffc107',
        high: '#dc3545',
        critical: '#6f42c1'
      };
      
      return \`
        <div class="priority-selector">
          <select 
            id="field-\${fieldName}" 
            class="form-control"
            style="border-left: 4px solid \${colors[value] || '#ccc'};"
          >
            <option value="low" \${value === 'low' ? 'selected' : ''}>🟢 Baja</option>
            <option value="medium" \${value === 'medium' ? 'selected' : ''}>🟡 Media</option>
            <option value="high" \${value === 'high' ? 'selected' : ''}>🔴 Alta</option>
            <option value="critical" \${value === 'critical' ? 'selected' : ''}>🟣 Crítica</option>
          </select>
        </div>
      \`;
    })();
  `,
});
```

### Ejemplo: Widget de Fecha con Countdown

```javascript
const customUi = await CustomUi.create({
  customUiName: "Countdown de Fecha Límite",
  customUiType: "Field Widget",
  active: true,
  fieldWidget: {
    modelName: "Task",
    fieldName: "dueDate",
  },
  code: `
    (function() {
      const dueDate = window.fieldValue ? new Date(window.fieldValue) : null;
      const now = new Date();
      
      if (!dueDate) {
        return '<input type="date" class="form-control" placeholder="Sin fecha límite" />';
      }
      
      const diff = dueDate - now;
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      
      let statusColor = '#28a745'; // verde
      let statusText = 'A tiempo';
      
      if (days < 0) {
        statusColor = '#dc3545';
        statusText = 'Vencida';
      } else if (days === 0) {
        statusColor = '#ffc107';
        statusText = 'Hoy';
      } else if (days <= 3) {
        statusColor = '#fd7e14';
        statusText = 'Próxima';
      }
      
      return \`
        <div style="display: flex; gap: 10px; align-items: center;">
          <input 
            type="datetime-local" 
            class="form-control" 
            value="\${dueDate.toISOString().slice(0, 16)}"
            style="flex: 1;"
          />
          <div style="
            padding: 8px 16px; 
            background: \${statusColor}; 
            color: white; 
            border-radius: 4px;
            font-weight: bold;
            white-space: nowrap;
          ">
            \${statusText}: \${Math.abs(days)}d \${Math.abs(hours)}h
          </div>
        </div>
      \`;
    })();
  `,
});
```

---

## Table Row Action - Acciones de Fila

### Descripción

Agrega acciones personalizadas al menú de acciones de cada fila en las tablas de listado.

### Estructura

```javascript
{
  customUiName: 'Acción Custom',
  customUiType: 'Table Row Action',
  active: true,
  rowAction: {
    modelName: 'Contact',                    // Modelo de la tabla
    label: 'Enviar Email',                   // Texto del botón
    icon: 'EmailWhite',                      // Nombre del icono
    slot: 'rowActionsSuffix',                // Posición del botón
    order: 0                                 // Orden dentro del slot
  },
  code: `
    // JavaScript que se ejecuta al hacer click
  `
}
```

### Propiedades

| Propiedad   | Tipo   | Requerido | Descripción                                                          |
| ----------- | ------ | --------- | -------------------------------------------------------------------- |
| `modelName` | String | Sí        | Modelo de la tabla                                                   |
| `label`     | String | Sí        | Texto del botón de acción                                            |
| `icon`      | String | No        | Nombre del icono (ej: 'EditWhite', 'Copy')                           |
| `slot`      | String | No        | Posición: 'rowActionsPrefix', 'rowActionsMiddle', 'rowActionsSuffix' |
| `order`     | Number | No        | Orden dentro del slot (menor = primero)                              |

### Ejemplo: Enviar Email

```javascript
const customUi = await CustomUi.create({
  customUiName: "Enviar Email Marketing",
  customUiType: "Table Row Action",
  active: true,
  rowAction: {
    modelName: "Contact",
    label: "Email Marketing",
    icon: "EmailWhite",
    slot: "rowActionsMiddle",
    order: 1,
  },
  code: `
    (async function() {
      const record = window.currentRecord;
      
      if (!record.email) {
        alert('Este contacto no tiene email registrado');
        return;
      }
      
      const confirmed = confirm(\`¿Enviar email marketing a \${record.email}?\`);
      
      if (confirmed) {
        try {
          const response = await axios.post('/v2/email/marketing', {
            contactId: record._id,
            template: 'newsletter'
          });
          
          alert('Email enviado exitosamente');
          window.location.reload();
        } catch (error) {
          alert('Error al enviar email: ' + error.message);
        }
      }
    })();
  `,
});
```

### Ejemplo: Clonar Registro

```javascript
const customUi = await CustomUi.create({
  customUiName: "Clonar Deal",
  customUiType: "Table Row Action",
  active: true,
  rowAction: {
    modelName: "Deal",
    label: "Clonar",
    icon: "Copy",
    slot: "rowActionsPrefix",
    order: 0,
  },
  code: `
    (async function() {
      const record = window.currentRecord;
      
      const confirmed = confirm(\`¿Clonar el deal "\${record.dealName}"?\`);
      
      if (!confirmed) return;
      
      try {
        // Crear copia del deal
        const cloneData = {
          ...record,
          dealName: record.dealName + ' (Copia)',
          _id: undefined,
          createdAt: undefined,
          updatedAt: undefined
        };
        
        const response = await axios.post('/v2/deal', cloneData);
        
        alert('Deal clonado exitosamente');
        
        // Navegar al nuevo deal
        window.location.href = \`/deal/\${response.data._id}\`;
      } catch (error) {
        alert('Error al clonar: ' + error.message);
      }
    })();
  `,
});
```

### Ejemplo: Exportar a PDF

```javascript
const customUi = await CustomUi.create({
  customUiName: "Exportar Propuesta a PDF",
  customUiType: "Table Row Action",
  active: true,
  rowAction: {
    modelName: "Deal",
    label: "Exportar PDF",
    icon: "Download",
    slot: "rowActionsSuffix",
    order: 10,
  },
  code: `
    (async function() {
      const record = window.currentRecord;
      
      try {
        // Mostrar indicador de carga
        const loadingMsg = 'Generando PDF...';
        console.log(loadingMsg);
        
        // Solicitar generación del PDF
        const response = await axios.post(\`/v2/deal/\${record._id}/export-pdf\`, {
          includeImages: true,
          template: 'professional'
        });
        
        // Descargar el archivo
        const link = document.createElement('a');
        link.href = response.data.downloadUrl;
        link.download = \`\${record.dealName}.pdf\`;
        link.click();
        
        alert('PDF descargado exitosamente');
      } catch (error) {
        alert('Error al generar PDF: ' + error.message);
      }
    })();
  `,
});
```

---

## Table Cell Widget - Widgets de Celda

### Descripción

Personaliza cómo se renderiza una celda específica en las tablas de listado.

### Estructura

```javascript
{
  customUiName: 'Widget de Celda',
  customUiType: 'Table Cell Widget',
  active: true,
  cellWidget: {
    modelName: 'Deal',          // Modelo de la tabla
    fieldName: 'status'         // Campo de la columna
  },
  code: `
    // JavaScript para renderizar la celda
  `
}
```

### Propiedades

| Propiedad   | Tipo   | Requerido | Descripción                |
| ----------- | ------ | --------- | -------------------------- |
| `modelName` | String | Sí        | Modelo de la tabla         |
| `fieldName` | String | Sí        | Ruta del campo (key route) |

### Ejemplo: Badge de Estado

```javascript
const customUi = await CustomUi.create({
  customUiName: "Badge Estado Deal",
  customUiType: "Table Cell Widget",
  active: true,
  cellWidget: {
    modelName: "Deal",
    fieldName: "status",
  },
  code: `
    (function() {
      const value = window.cellValue;
      const record = window.currentRecord;
      
      const statusConfig = {
        'open': { color: '#007bff', text: 'Abierto', icon: '📂' },
        'in-progress': { color: '#ffc107', text: 'En Progreso', icon: '⚙️' },
        'won': { color: '#28a745', text: 'Ganado', icon: '✅' },
        'lost': { color: '#dc3545', text: 'Perdido', icon: '❌' },
        'cancelled': { color: '#6c757d', text: 'Cancelado', icon: '🚫' }
      };
      
      const config = statusConfig[value] || { color: '#ccc', text: value, icon: '❓' };
      
      return \`
        <span style="
          display: inline-block;
          padding: 4px 12px;
          background: \${config.color}15;
          border: 1px solid \${config.color};
          border-radius: 16px;
          color: \${config.color};
          font-weight: 600;
          font-size: 12px;
        ">
          \${config.icon} \${config.text}
        </span>
      \`;
    })();
  `,
});
```

### Ejemplo: Progress Bar

```javascript
const customUi = await CustomUi.create({
  customUiName: "Barra de Progreso",
  customUiType: "Table Cell Widget",
  active: true,
  cellWidget: {
    modelName: "Project",
    fieldName: "completionRate",
  },
  code: `
    (function() {
      const value = window.cellValue || 0;
      const percentage = Math.min(100, Math.max(0, value));
      
      let color = '#28a745'; // verde
      if (percentage < 30) {
        color = '#dc3545'; // rojo
      } else if (percentage < 70) {
        color = '#ffc107'; // amarillo
      }
      
      return \`
        <div style="width: 100%; background: #f0f0f0; border-radius: 4px; overflow: hidden;">
          <div style="
            width: \${percentage}%;
            background: \${color};
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 11px;
            font-weight: bold;
            transition: width 0.3s ease;
          ">
            \${percentage}%
          </div>
        </div>
      \`;
    })();
  `,
});
```

### Ejemplo: Avatar con Tooltip

```javascript
const customUi = await CustomUi.create({
  customUiName: "Avatar Responsable",
  customUiType: "Table Cell Widget",
  active: true,
  cellWidget: {
    modelName: "Task",
    fieldName: "assignee",
  },
  code: `
    (function() {
      const user = window.cellValue;
      
      if (!user) {
        return '<span style="color: #999;">Sin asignar</span>';
      }
      
      const initials = (user.firstName?.[0] || '') + (user.lastName?.[0] || '');
      const fullName = \`\${user.firstName || ''} \${user.lastName || ''}\`.trim();
      
      // Generar color basado en el nombre
      const colors = ['#007bff', '#28a745', '#dc3545', '#ffc107', '#17a2b8', '#6f42c1'];
      const colorIndex = (user._id || '').charCodeAt(0) % colors.length;
      const bgColor = colors[colorIndex];
      
      return \`
        <div 
          style="
            display: inline-flex;
            align-items: center;
            gap: 8px;
          "
          title="\${fullName} - \${user.email || ''}"
        >
          <div style="
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background: \${bgColor};
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 12px;
          ">
            \${initials}
          </div>
          <span style="font-weight: 500;">\${fullName}</span>
        </div>
      \`;
    })();
  `,
});
```

---

## Default Table Columns - Columnas Predeterminadas

### Descripción

Define qué columnas se muestran por defecto en las tablas de listado de un modelo específico.

### Estructura

```javascript
{
  customUiName: 'Columnas Default Contact',
  customUiType: 'Default Table Columns',
  active: true,
  defaultColumns: {
    modelName: 'Contact',
    columns: [
      { field: 'firstName', label: 'Nombre', width: 150 },
      { field: 'lastName', label: 'Apellido', width: 150 },
      { field: 'email', label: 'Email', width: 200 },
      { field: 'company', label: 'Compañía', width: 180 },
      { field: 'status', label: 'Estado', width: 120 }
    ]
  }
}
```

### Propiedades

| Propiedad   | Tipo   | Requerido | Descripción                       |
| ----------- | ------ | --------- | --------------------------------- |
| `modelName` | String | Sí        | Modelo de la tabla                |
| `columns`   | Array  | Sí        | Array de definiciones de columnas |

### Estructura de Columna

```javascript
{
  field: 'fieldName',       // Nombre del campo (key route)
  label: 'Display Name',    // Título de la columna
  width: 150,               // Ancho en pixels (opcional)
  sortable: true,           // Permitir ordenamiento (opcional)
  filterable: true          // Permitir filtrado (opcional)
}
```

### Ejemplo: Configuración Completa

```javascript
const customUi = await CustomUi.create({
  customUiName: "Vista Deals - Ventas",
  customUiType: "Default Table Columns",
  active: true,
  defaultColumns: {
    modelName: "Deal",
    columns: [
      {
        field: "dealName",
        label: "Nombre del Deal",
        width: 250,
        sortable: true,
        filterable: true,
      },
      {
        field: "amount",
        label: "Monto",
        width: 120,
        sortable: true,
      },
      {
        field: "stage",
        label: "Etapa",
        width: 150,
        filterable: true,
      },
      {
        field: "closeDate",
        label: "Fecha Cierre",
        width: 130,
        sortable: true,
      },
      {
        field: "assignee",
        label: "Responsable",
        width: 180,
        filterable: true,
      },
      {
        field: "probability",
        label: "Probabilidad",
        width: 100,
      },
    ],
  },
});
```

### Ejemplo: Vista Minimalista

```javascript
const customUi = await CustomUi.create({
  customUiName: "Vista Tareas - Simple",
  customUiType: "Default Table Columns",
  active: true,
  defaultColumns: {
    modelName: "Task",
    columns: [
      { field: "taskName", label: "Tarea", width: 300 },
      { field: "status", label: "Estado", width: 120 },
      { field: "dueDate", label: "Vencimiento", width: 130 },
      { field: "assignee", label: "Asignado a", width: 150 },
    ],
  },
});
```

---

## Código JavaScript en Custom UIs

### Contexto de Ejecución

El código JavaScript en Custom UIs se ejecuta en el contexto del navegador del usuario. Tiene acceso a:

#### Variables Globales Disponibles

```javascript
// Variables del sistema
window.currentRecord; // Registro actual (en row actions, cell widgets)
window.cellValue; // Valor de la celda (en cell widgets)
window.fieldValue; // Valor del campo (en field widgets)
window.fieldName; // Nombre del campo
window.currentUser; // Usuario actual
window.currentStage; // Etapa actual (en stage widgets)
window.currentDeals; // Deals en la etapa (en stage widgets)

// Librerías disponibles
axios; // Cliente HTTP
_; // Lodash para manipulación de datos
moment; // Manejo de fechas
```

### Patrón de Código Recomendado

```javascript
(async function () {
  try {
    // 1. Obtener datos del contexto
    const record = window.currentRecord;
    const user = window.currentUser;

    // 2. Validaciones
    if (!record) {
      console.error("No record available");
      return;
    }

    // 3. Lógica principal
    const result = await performAction(record);

    // 4. Renderizar o actualizar UI
    if (result.success) {
      updateUI(result.data);
    }

    // 5. Return HTML si es widget de renderizado
    return generateHTML(result);
  } catch (error) {
    console.error("Error en Custom UI:", error);
    alert("Error: " + error.message);
  }
})();
```

### Mejores Prácticas de Código

#### 1. Usar IIFE (Immediately Invoked Function Expression)

```javascript
// ✅ Correcto
(function () {
  // Tu código aquí
})();

// ❌ Incorrecto - variables globales contaminan el scope
const myVar = "value";
```

#### 2. Manejo de Errores

```javascript
// ✅ Correcto
(async function () {
  try {
    const response = await axios.get("/api/data");
    processData(response.data);
  } catch (error) {
    console.error("Error:", error);
    alert("Operación fallida: " + error.message);
  }
})();
```

#### 3. Validaciones de Datos

```javascript
// ✅ Correcto
(function () {
  const record = window.currentRecord;

  if (!record) {
    console.warn("No record available");
    return "<div>No hay datos disponibles</div>";
  }

  if (!record.email) {
    return "<div>Email no configurado</div>";
  }

  // Continuar con lógica...
})();
```

#### 4. Sanitización de HTML

```javascript
// ✅ Correcto - escapar contenido del usuario
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

const safeName = escapeHtml(record.name);
return `<div>${safeName}</div>`;

// ❌ Incorrecto - vulnerable a XSS
return `<div>${record.name}</div>`;
```

### Ejemplos de Operaciones Comunes

#### Realizar Petición HTTP

```javascript
(async function () {
  try {
    const response = await axios.post("/v2/contact", {
      firstName: "John",
      lastName: "Doe",
      email: "john@example.com",
    });

    console.log("Contacto creado:", response.data);
    return response.data;
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
})();
```

#### Mostrar Modal de Confirmación

```javascript
(async function () {
  const record = window.currentRecord;

  const confirmed = confirm(`¿Desea eliminar "${record.name}"?`);

  if (confirmed) {
    try {
      await axios.delete(`/v2/contact/${record._id}`);
      alert("Registro eliminado");
      window.location.reload();
    } catch (error) {
      alert("Error: " + error.message);
    }
  }
})();
```

#### Navegar a Otra Página

```javascript
(function () {
  const record = window.currentRecord;

  // Navegar a detalle del registro
  window.location.href = `/deal/${record._id}`;

  // O abrir en nueva pestaña
  window.open(`/deal/${record._id}`, "_blank");
})();
```

#### Manipular DOM

```javascript
(function () {
  // Agregar elemento al DOM
  const container = document.getElementById("custom-container");

  const newElement = document.createElement("div");
  newElement.className = "custom-widget";
  newElement.innerHTML = "<h3>Mi Widget</h3>";

  container.appendChild(newElement);

  // Agregar event listener
  newElement.addEventListener("click", function () {
    alert("Widget clicked!");
  });
})();
```

---

## Ejemplos Prácticos

### Ejemplo 1: Dashboard de Métricas en Sidebar

```javascript
const customUi = await CustomUi.create({
  customUiName: "Dashboard de Ventas",
  customUiType: "Stage Widget",
  active: true,
  code: `
    (async function() {
      try {
        // Obtener métricas desde API
        const response = await axios.get('/v2/service/sales-metrics');
        const metrics = response.data;
        
        return \`
          <div style="
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 12px;
            color: white;
            margin: 15px 10px;
          ">
            <h3 style="margin: 0 0 20px 0; font-size: 18px;">📊 Dashboard de Ventas</h3>
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
              <div style="background: rgba(255,255,255,0.2); padding: 15px; border-radius: 8px;">
                <div style="font-size: 12px; opacity: 0.9;">Ventas Hoy</div>
                <div style="font-size: 28px; font-weight: bold; margin-top: 5px;">
                  $\${metrics.todaySales.toLocaleString()}
                </div>
              </div>
              
              <div style="background: rgba(255,255,255,0.2); padding: 15px; border-radius: 8px;">
                <div style="font-size: 12px; opacity: 0.9;">Deals Cerrados</div>
                <div style="font-size: 28px; font-weight: bold; margin-top: 5px;">
                  \${metrics.closedDeals}
                </div>
              </div>
              
              <div style="background: rgba(255,255,255,0.2); padding: 15px; border-radius: 8px;">
                <div style="font-size: 12px; opacity: 0.9;">Tasa Conversión</div>
                <div style="font-size: 28px; font-weight: bold; margin-top: 5px;">
                  \${metrics.conversionRate}%
                </div>
              </div>
              
              <div style="background: rgba(255,255,255,0.2); padding: 15px; border-radius: 8px;">
                <div style="font-size: 12px; opacity: 0.9;">Meta Mensual</div>
                <div style="font-size: 28px; font-weight: bold; margin-top: 5px;">
                  \${metrics.monthlyGoalPercentage}%
                </div>
              </div>
            </div>
          </div>
        \`;
      } catch (error) {
        return '<div style="padding: 20px;">Error cargando métricas</div>';
      }
    })();
  `,
});
```

### Ejemplo 2: Sistema de Notificaciones en Row Action

```javascript
const customUi = await CustomUi.create({
  customUiName: "Enviar Notificación",
  customUiType: "Table Row Action",
  active: true,
  rowAction: {
    modelName: "Deal",
    label: "Notificar",
    icon: "Notification",
    slot: "rowActionsMiddle",
    order: 5,
  },
  code: `
    (async function() {
      const deal = window.currentRecord;
      
      // Mostrar modal de selección
      const message = prompt('Mensaje de notificación:', 
        \`El deal "\${deal.dealName}" requiere tu atención\`);
      
      if (!message) return;
      
      try {
        // Enviar notificación
        await axios.post('/v2/notification', {
          type: 'deal-alert',
          dealId: deal._id,
          message: message,
          recipients: [deal.assignee._id]
        });
        
        alert('✅ Notificación enviada exitosamente');
      } catch (error) {
        alert('❌ Error: ' + error.message);
      }
    })();
  `,
});
```

### Ejemplo 3: Validador de Email en Field Widget

```javascript
const customUi = await CustomUi.create({
  customUiName: "Validador de Email",
  customUiType: "Field Widget",
  active: true,
  fieldWidget: {
    modelName: "Contact",
    fieldName: "email",
  },
  code: `
    (function() {
      const email = window.fieldValue || '';
      const fieldName = window.fieldName;
      
      // Validar formato
      const isValid = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
      
      // Detectar dominio
      const domain = email.split('@')[1] || '';
      const isPopularDomain = ['gmail.com', 'outlook.com', 'yahoo.com'].includes(domain);
      
      return \`
        <div style="position: relative;">
          <input 
            type="email" 
            id="field-\${fieldName}"
            class="form-control \${isValid ? 'is-valid' : email ? 'is-invalid' : ''}"
            value="\${email}"
            placeholder="email@example.com"
            style="padding-right: 100px;"
          />
          
          <div style="
            position: absolute;
            right: 10px;
            top: 50%;
            transform: translateY(-50%);
            display: flex;
            gap: 5px;
            align-items: center;
          ">
            \${isValid ? 
              '<span style="color: #28a745; font-size: 18px;">✓</span>' : 
              email ? '<span style="color: #dc3545; font-size: 18px;">✗</span>' : ''
            }
            
            \${isPopularDomain ? 
              '<span style="font-size: 12px; color: #666;">📧</span>' : ''
            }
          </div>
        </div>
        
        \${!isValid && email ? 
          '<small style="color: #dc3545;">Email inválido</small>' : ''
        }
      \`;
    })();
  `,
});
```

### Ejemplo 4: Timeline en Cell Widget

```javascript
const customUi = await CustomUi.create({
  customUiName: "Timeline de Actividades",
  customUiType: "Table Cell Widget",
  active: true,
  cellWidget: {
    modelName: "Deal",
    fieldName: "activities",
  },
  code: `
    (function() {
      const activities = window.cellValue || [];
      
      if (activities.length === 0) {
        return '<span style="color: #999;">Sin actividades</span>';
      }
      
      // Tomar las últimas 3 actividades
      const recent = activities.slice(-3).reverse();
      
      const html = recent.map(activity => \`
        <div style="
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 0;
          border-bottom: 1px solid #f0f0f0;
        ">
          <div style="
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #007bff;
            flex-shrink: 0;
          "></div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              \${activity.type}
            </div>
            <div style="font-size: 11px; color: #666;">
              \${new Date(activity.createdAt).toLocaleDateString()}
            </div>
          </div>
        </div>
      \`).join('');
      
      return \`
        <div style="width: 200px;">
          \${html}
          \${activities.length > 3 ? 
            \`<div style="font-size: 11px; color: #666; margin-top: 4px;">
              +\${activities.length - 3} más
            </div>\` : ''
          }
        </div>
      \`;
    })();
  `,
});
```

---

## API Reference

### Crear Custom UI

```http
POST /v2/customui
Authorization: Bearer {token}
Content-Type: application/json

{
  "customUiName": "Mi Custom UI",
  "customUiType": "Sidebar",
  "active": true,
  "sideBar": {
    "label": "Link Ejemplo",
    "url": "https://example.com"
  }
}
```

### Obtener Custom UI

```http
GET /v2/customui/:id
Authorization: Bearer {token}
```

### Listar Custom UIs

```http
GET /v2/customui
Authorization: Bearer {token}

# Filtrar por tipo
GET /v2/customui?customUiType=Sidebar

# Filtrar por activos
GET /v2/customui?active=true
```

### Actualizar Custom UI

```http
PATCH /v2/customui/:id
Authorization: Bearer {token}
Content-Type: application/json

{
  "active": true,
  "code": "/* nuevo código */"
}
```

### Eliminar Custom UI

```http
DELETE /v2/customui/:id
Authorization: Bearer {token}
```

### Respuesta de Ejemplo

```json
{
  "_id": "64a8f7b9c3d2e1f4a5b6c7d8",
  "customUiCode": "customUi-abc123",
  "customUiName": "Mi Custom UI",
  "customUiType": "Sidebar",
  "active": true,
  "sideBar": {
    "label": "Link Ejemplo",
    "url": "https://example.com",
    "target": "_blank"
  },
  "code": "",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-15T10:30:00.000Z"
}
```

---

## Mejores Prácticas

### 1. Naming Conventions

```javascript
// ✅ Nombres descriptivos
{
  customUiName: 'Sidebar - Enlace a Documentación',
  customUiName: 'Widget - Progreso de Ventas Mensual',
  customUiName: 'Acción - Exportar Deal a Excel'
}

// ❌ Nombres genéricos
{
  customUiName: 'Custom UI 1',
  customUiName: 'Mi Widget',
  customUiName: 'Test'
}
```

### 2. Organización del Código

```javascript
// ✅ Código organizado y comentado
(async function () {
  // 1. Variables y contexto
  const record = window.currentRecord;
  const user = window.currentUser;

  // 2. Funciones auxiliares
  function formatCurrency(amount) {
    return `$${amount.toLocaleString()}`;
  }

  // 3. Validaciones
  if (!record) return;

  // 4. Lógica principal
  const result = await processData(record);

  // 5. Renderizar
  return generateHTML(result);
})();
```

### 3. Performance

```javascript
// ✅ Cachear datos cuando sea posible
const CACHE_KEY = "sales-metrics";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

(async function () {
  const cached = localStorage.getItem(CACHE_KEY);
  const cacheTime = localStorage.getItem(CACHE_KEY + "_time");

  if (cached && cacheTime && Date.now() - cacheTime < CACHE_TTL) {
    return renderWidget(JSON.parse(cached));
  }

  const data = await axios.get("/v2/metrics");
  localStorage.setItem(CACHE_KEY, JSON.stringify(data.data));
  localStorage.setItem(CACHE_KEY + "_time", Date.now());

  return renderWidget(data.data);
})();
```

### 4. Seguridad

```javascript
// ✅ Validar permisos antes de ejecutar acciones críticas
(async function () {
  const user = window.currentUser;

  // Verificar si el usuario puede eliminar
  if (!user.isAdmin && !user.permissions.includes("DeleteRecord")) {
    alert("No tienes permisos para esta acción");
    return;
  }

  // Continuar con la acción...
})();
```

### 5. Compatibilidad

```javascript
// ✅ Asegurar compatibilidad con diferentes navegadores
(function () {
  // Usar características ampliamente soportadas
  const isSupported = !!(
    window.fetch &&
    Array.prototype.includes &&
    Object.assign
  );

  if (!isSupported) {
    return "<div>Navegador no soportado</div>";
  }

  // Continuar...
})();
```

### 6. Testing

```javascript
// ✅ Incluir modo de prueba
const DEBUG = false; // Cambiar a true para debugging

(async function () {
  if (DEBUG) {
    console.log("Debug mode enabled");
    console.log("Current record:", window.currentRecord);
    console.log("Field value:", window.fieldValue);
  }

  try {
    // Lógica principal
  } catch (error) {
    if (DEBUG) {
      console.error("Detailed error:", error);
    }
    alert("Error: " + error.message);
  }
})();
```

---

## Troubleshooting

### Problema: El Custom UI no aparece

**Causas posibles**:

- `active: false`
- Usuario no tiene permisos
- Configuración incorrecta del tipo
- Código JavaScript con errores

**Solución**:

```javascript
// 1. Verificar que esté activo
const customUi = await CustomUi.findOne({ _id: customUiId });
console.log("Active:", customUi.active);

// 2. Verificar permisos del usuario
const user = await User.findOne({ _id: userId });
console.log("Permissions:", user.permissions);

// 3. Revisar errores en consola del navegador
// Abrir DevTools > Console
```

### Problema: El código JavaScript no se ejecuta

**Causas posibles**:

- Errores de sintaxis
- Variables no definidas
- Promesas no resueltas

**Solución**:

```javascript
// ✅ Asegurar uso correcto de async/await
(async function () {
  try {
    const result = await axios.get("/api/data");
    // ...
  } catch (error) {
    console.error("Error:", error);
  }
})();

// ✅ Verificar que las variables existen
const record = window.currentRecord;
if (!record) {
  console.error("No record available");
  return;
}
```

### Problema: "Cannot read property of undefined"

**Causa**: Acceso a propiedades de objetos no definidos

**Solución**:

```javascript
// ❌ Incorrecto
const email = window.currentRecord.contact.email;

// ✅ Correcto - usar optional chaining
const email = window.currentRecord?.contact?.email || "No email";

// ✅ Correcto - validar antes
if (window.currentRecord && window.currentRecord.contact) {
  const email = window.currentRecord.contact.email;
}
```

### Problema: Custom UI se renderiza mal

**Causa**: HTML inválido o estilos conflictivos

**Solución**:

```javascript
// ✅ Usar estilos inline para evitar conflictos
return `
  <div style="padding: 10px; background: #f8f9fa;">
    <!-- contenido -->
  </div>
`;

// ✅ Escapar HTML si es necesario
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
```

### Problema: Row Action no funciona en algunos registros

**Causa**: Validaciones o permisos específicos por registro

**Solución**:

```javascript
(async function () {
  const record = window.currentRecord;
  const user = window.currentUser;

  // Validar estado del registro
  if (record.status === "locked") {
    alert("Este registro está bloqueado");
    return;
  }

  // Validar ownership
  if (record.createdBy !== user._id && !user.isAdmin) {
    alert("Solo el creador puede realizar esta acción");
    return;
  }

  // Continuar con la acción...
})();
```

### Problema: Performance lenta en tablas grandes

**Causa**: Código pesado ejecutándose en cada celda

**Solución**:

```javascript
// ✅ Optimizar renderizado
(function () {
  const value = window.cellValue;

  // Evitar operaciones pesadas
  // NO hacer peticiones HTTP aquí

  // Usar datos pre-calculados si es posible
  return `<span>${value}</span>`;
})();

// ✅ Cachear resultados
const cache = new Map();

(function () {
  const key = window.cellValue;

  if (cache.has(key)) {
    return cache.get(key);
  }

  const result = expensiveOperation(key);
  cache.set(key, result);

  return result;
})();
```

---

## Conclusión

Los Custom UIs son una herramienta poderosa para personalizar la experiencia de usuario sin modificar el código fuente del sistema. Siguiendo las mejores prácticas y ejemplos de este documento, puedes crear interfaces personalizadas, widgets dinámicos y acciones personalizadas que se integran perfectamente con la aplicación.

### Recursos Adicionales

- Modelo CustomUi: `/app/modules/system/models/CustomUi.js`
- API de Custom UIs: `GET/POST/PATCH/DELETE /v2/customui`
- Documentación de Scripts: `/docs/endpoint-custom-guide.md`
- Sistema de Permisos: `/app/modules/system/models/Permission.js`

### Puntos Clave

1. **7 tipos de Custom UI** para diferentes contextos
2. **Ejecución de JavaScript** en el navegador con acceso a APIs
3. **Widgets renderizables** con HTML/CSS personalizado
4. **Acciones personalizadas** en tablas y formularios
5. **Sistema de permisos** integrado con RBAC
6. **Performance y seguridad** deben ser consideraciones principales
7. **Testing y validación** son esenciales antes de activar en producción

---

**Versión del documento**: 1.0  
**Última actualización**: Marzo 2026  
**Autor**: Sistema SKEM
