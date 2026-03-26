# Especificación de Datos de Prolibu para Integración con Salesforce

## Propósito del Documento

Este documento describe la estructura de datos de **Prolibu** para que un agente que conoce **Salesforce** (Opportunities, Quotes, Line Items) pueda crear un parser/transformer que convierta los datos de Salesforce al formato esperado por Prolibu.

---

## Diferencia Clave: Arquitectura de Datos

### Salesforce (Origen)

- **3 objetos separados e independientes:**
  - `Opportunity` (Deal/Negocio)
  - `Quote` (Cotización asociada a Opportunity)
  - `QuoteLineItem` (Productos/servicios individuales de Quote)

### Prolibu (Destino)

- **1 objeto único:**
  - `Deal` que contiene todo en una estructura embebida/anidada
  - El quote está dentro de `deal.proposal.quote`
  - Los line items están dentro de `deal.proposal.quote.lineItems[]`

---

## Estructura del Modelo Deal en Prolibu

### 1. Deal Básico (sin Quote/Propuesta)

Un Deal básico es simplemente una oportunidad de venta sin cotización asociada.

#### Campos Principales del Deal

```javascript
{
  // === IDENTIFICACIÓN ===
  dealCode: String,              // Código único (auto-generado: "DEA-XXXXX")
  dealName: String,              // Nombre del deal (REQUERIDO)

  // === RELACIONES ===
  contact: ObjectId,             // Referencia al Contact (cliente/prospecto)
  company: ObjectId,             // Referencia a Company (auto-calculado desde contact)

  // === FECHAS ===
  closeDate: Date,               // Fecha estimada de cierre

  // === CATEGORIZACIÓN Y ASIGNACIÓN ===
  stage: ObjectId,               // Etapa del pipeline (ej: Prospecting, Proposal, Negotiation, Closed Won)
  stageMovedAt: Date,            // Fecha del último cambio de etapa (auto-calculado)
  stageMovedMethod: String,      // Enum: ['By User', 'By Client', 'API']

  priority: String,              // Enum: ['Low', 'Medium', 'High', 'Critical']
  group: ObjectId,               // Grupo/equipo asignado
  assignee: ObjectId,            // Usuario responsable
  collaborators: [ObjectId],     // Usuarios colaboradores

  // === ORIGEN Y CAMPAÑA ===
  source: {
    type: String,                // Enum: ['Website', 'Referral', 'Cold Call', 'Social Media', etc.]
    details: String              // Detalles adicionales
  },
  adCampaign: ObjectId,          // Campaña publicitaria de origen

  // === INFORMACIÓN ADICIONAL ===
  observations: String,          // Notas/observaciones generales (TextArea)
  tags: [String],                // Etiquetas para categorización

  // === TRACKING ===
  tracking: {
    createdAt: Date,
    updatedAt: Date,
    createdBy: ObjectId,
    updatedBy: ObjectId
  },

  // === METADATOS ===
  meta: Mixed,                   // Datos adicionales flexibles

  // === DEAL PERDIDO ===
  denied: {
    reason: String,              // Motivo de pérdida
    details: String              // Detalles adicionales
  }
}
```

#### Ejemplo de Deal Básico

```json
{
  "dealName": "Acme Corp - CRM Implementation",
  "contact": "507f1f77bcf86cd799439011",
  "closeDate": "2026-06-30T00:00:00.000Z",
  "stage": "76a6f41079d81268f83fede2",
  "priority": "High",
  "source": {
    "type": "Referral",
    "details": "Referred by John Doe"
  },
  "observations": "Customer interested in enterprise package",
  "tags": ["enterprise", "high-value"]
}
```

---

### 2. Deal con Quote (Cotización/Propuesta)

Cuando un Deal incluye una cotización/propuesta, se habilita el objeto `proposal` anidado.

#### Estructura de proposal en Deal

```javascript
{
  // ... campos básicos de Deal (ver sección 1) ...

  // === PROPUESTA/COTIZACIÓN ===
  proposal: {

    // === ACTIVACIÓN ===
    enabled: Boolean,            // true para habilitar la propuesta (REQUERIDO para tener quote)

    // === INFORMACIÓN BÁSICA ===
    title: String,               // Título de la propuesta

    // === COTIZACIÓN (QUOTE) ===
    quote: {                     // Ver estructura completa en sección 3
      quoteCurrency: String,     // Moneda del quote (ej: 'USD', 'COP', 'EUR')
      lineItems: [Object],       // Array de line items (ver sección 4)
      // ... más campos de quote (ver sección 3)
    },

    // === PLANTILLA Y CONTENIDO ===
    template: {
      layout: ObjectId,          // Ref a ContentTemplate (plantilla de diseño)
      layoutHtml: String,        // HTML pre-renderizado de la plantilla
      snippetHtml: String,       // HTML de snippets incluidos
      customContent: Mixed,      // Contenido personalizado del editor
      customContentHtml: String, // HTML del contenido personalizado
      assets: [ObjectId],        // Referencias a Files (imágenes, etc.)
      defaultFont: String,       // Fuente principal
      secondaryFont: String,     // Fuente secundaria
      embeddedFonts: [ObjectId], // Fuentes embebidas
      language: String           // Idioma (ej: 'en', 'es')
    },

    // === ARCHIVOS ADJUNTOS ===
    attachments: [ObjectId],     // Referencias a Files adjuntos

    // === FECHAS ===
    createdAt: Date,             // Fecha de creación de la propuesta
    lastSentAt: Date,            // Fecha del último envío al cliente
    expirationDate: Date,        // Fecha de vencimiento de la propuesta
    unpublishedDate: Date,       // Fecha en que deja de ser accesible

    // === MÉTRICAS ===
    formulationTime: Number      // Tiempo acumulado de edición (en ms)
  },

  // === VERSIONES DE LA PROPUESTA ===
  proposalVersions: {
    refs: [ObjectId],            // Referencias a ProposalVersion
    details: [{
      id: String,
      versionName: String,
      visibleToClient: Boolean,
      isAutoGenerated: Boolean,
      createdAt: Date,
      creator: String,
      sha256: String
    }],
    restorationPoint: ObjectId   // Versión de respaldo
  },

  // === THUMBNAIL ===
  thumbnail: ObjectId,           // Preview de la propuesta (File)

  // === WIZARD ===
  proposalWizard: ObjectId,      // ProposalWizard usado para crear este deal

  // === FACTURAS RELACIONADAS ===
  invoices: [ObjectId]           // Referencias a Invoice generadas desde este deal
}
```

#### Ejemplo de Deal con Quote (sin line items aún)

```json
{
  "dealName": "Acme Corp - CRM Implementation",
  "contact": "507f1f77bcf86cd799439011",
  "closeDate": "2026-06-30T00:00:00.000Z",
  "stage": "76a6f41079d81268f83fede3",
  "proposal": {
    "enabled": true,
    "title": "CRM Implementation Proposal for Acme Corp",
    "quote": {
      "quoteCurrency": "USD",
      "lineItems": []
    },
    "expirationDate": "2026-04-30T00:00:00.000Z"
  }
}
```

---

### 3. Estructura Completa del Quote

El `quote` es un objeto embebido dentro de `deal.proposal.quote` que contiene toda la información de precios, descuentos, impuestos y line items.

#### Campos del Quote

```javascript
{
  // === IDENTIFICACIÓN (opcionales) ===
  quoteCode: String,             // Código único (auto-generado: "QTE-XXXXX")
  quoteName: String,             // Nombre del quote
  quoteDescription: String,      // Descripción detallada
  quoteMode: String,             // Enum: ['Events'] - modo especial de quote

  // === MONEDA Y CAMBIO ===
  quoteCurrency: String,         // Moneda principal del quote (REQUERIDO) ej: 'USD', 'COP', 'EUR'
  setCustomExchangeRates: Boolean, // Usar tasas de cambio personalizadas
  exchangeRates: {               // Tasas de cambio vs la moneda del quote
    USD: Number,                 // Ejemplo: si quoteCurrency es COP, aquí va cuántos COP = 1 USD
    EUR: Number,
    // ... otras monedas
  },

  // === FECHAS ===
  startDate: Date,               // Fecha de inicio de vigencia
  endDate: Date,                 // Fecha de fin de vigencia

  // === VALORES GLOBALES (aplicados a line items que no los definan) ===
  unitMultiplier: Number,        // Multiplicador de cantidad (ej: si vendemos días y el multiplier es 8 horas)
  numberOfPayments: Number,      // Número de pagos/cuotas
  upfrontPaymentRate: Number,    // Porcentaje de pago inicial (0-1, ej: 0.3 = 30%)

  // === NOTAS ===
  additionalNotes: [String],     // Notas adicionales en formato HTML

  // === DESCUENTOS SENSIBLES AL TIEMPO ===
  timeSensitiveDiscounts: {
    enabled: Boolean,            // Habilitar descuento que decrece con el tiempo
    strategy: String,            // Enum: ['Real-Time', 'Limited-Time']
    startFrom: Date,             // Inicio del período de descuento
    endAt: Date,                 // Fin del período de descuento
    numberOfNotifications: Number, // Cantidad de notificaciones enviadas (max 5)
    lostDiscountAmount: Number,  // Monto de descuento perdido (auto-calculado)
    remainingDiscountAmount: Number, // Monto de descuento restante (auto-calculado)
    discountAppliedAt: Date,     // Fecha en que se aplicó (auto-calculado)
    finalized: Boolean           // Si el descuento ya finalizó (auto-calculado)
  },

  // === DESCUENTOS SENSIBLES A UBICACIÓN ===
  locationSensitiveDiscounts: {
    enabled: Boolean,            // Habilitar descuento basado en geolocalización
    latitude: Number,            // Latitud del punto de referencia
    longitude: Number,           // Longitud del punto de referencia
    radius: Number,              // Radio en metros para aplicar descuento
    lostDiscountAmount: Number   // Monto perdido si no está en ubicación (auto-calculado)
  },

  // === LINE ITEMS ===
  lineItems: [                   // Array de productos/servicios (ver sección 4)
    {
      // ... estructura de line item (ver sección 4)
    }
  ],

  // === PLAN DE PAGOS ===
  paymentPlan: {
    enabled: Boolean,            // Habilitar plan de pagos
    interestRate: Number,        // Tasa de interés (0-1, ej: 0.05 = 5%)
    titleTemplate: String,       // Plantilla para título de pagos (ej: "Payment {{number}}")
    paymentInterval: {
      unit: String,              // Enum: ['Day', 'Week', 'Month', 'Year']
      value: Number              // Intervalo (ej: 1 = cada 1 mes)
    },
    payments: [                  // Array de pagos
      {
        number: Number,          // Número de pago
        title: String,           // Título del pago
        dueDate: Date,           // Fecha de vencimiento
        total: Number            // Monto del pago
      }
    ]
  },

  // === TOTALES (TODOS AUTO-CALCULADOS) ===
  subTotal: Number,              // Suma de precios antes de descuentos e impuestos
  discountAmount: Number,        // Monto total de descuentos
  discountRate: Number,          // Porcentaje total de descuento (0-1)
  netTotal: Number,              // Total después de descuentos, antes de impuestos
  taxAmount: Number,             // Monto total de impuestos
  taxRate: Number,               // Porcentaje total de impuestos (0-1)
  total: Number,                 // TOTAL FINAL (netTotal + taxAmount)
  convertedTotal: Number,        // Total convertido a moneda global del sistema

  // === FLAGS (AUTO-CALCULADOS) ===
  hasProductRules: Boolean,      // Si tiene reglas de productos aplicadas
  hasDiscountSchedules: Boolean, // Si tiene schedules de descuento aplicados

  // === ANOTACIONES ===
  annotations: {
    internalNotes: [String],     // Notas internas (no visibles al cliente)
    specialNotes: [String]       // Notas especiales (visibles al cliente)
  },

  // === EXCEPCIONES COMERCIALES ===
  commercialException: Mixed,    // Información de excepciones comerciales aprobadas

  // === PERMISOS ===
  allowEveryone: {
    view: Boolean,               // Todos pueden ver (default: true)
    edit: Boolean,               // Todos pueden editar
    delete: Boolean              // Todos pueden eliminar
  }
}
```

#### Ejemplo de Quote Completo (sin line items aún)

```json
{
  "quoteCurrency": "USD",
  "startDate": "2026-04-01T00:00:00.000Z",
  "endDate": "2026-12-31T00:00:00.000Z",
  "unitMultiplier": 1,
  "numberOfPayments": 3,
  "upfrontPaymentRate": 0.3,
  "additionalNotes": [
    "<p>Implementation includes training for up to 10 users.</p>"
  ],
  "lineItems": [],
  "paymentPlan": {
    "enabled": true,
    "titleTemplate": "Payment {{number}}",
    "paymentInterval": {
      "unit": "Month",
      "value": 1
    },
    "payments": []
  }
}
```

---

### 4. Estructura de Line Items

Los `lineItems` son objetos dentro del array `deal.proposal.quote.lineItems[]`. Cada line item representa un producto o servicio individual en la cotización.

#### Campos de Line Item

```javascript
{
  // === IDENTIFICACIÓN ===
  lineId: ObjectId,              // ID único del line item (_id de Mongoose)
  uuid: String,                  // UUID alternativo (auto-generado)

  // === PRODUCTO ===
  productName: String,           // Nombre del producto/servicio (REQUERIDO para display)
  publicProductName: String,     // Nombre público (si difiere del interno)
  productCode: String,           // Código del producto (ej: "PRO-12345")
  description: String,           // Descripción rica del producto (puede ser HTML)

  // === CANTIDAD ===
  quantity: Number,              // Cantidad solicitada (REQUERIDO, min: 1, default: 1)
  unitMultiplier: Number,        // Multiplicador (ej: días x 8 horas)
  netQuantity: Number,           // quantity × unitMultiplier (auto-calculado)
  unitMultiplierName: String,    // Nombre de la unidad multiplicada (ej: "hours")
  unitMultiplierStep: Number,    // Incremento del multiplicador

  // === PRECIOS BASE ===
  currency: String,              // Moneda del line item (puede diferir del quote)
  exchangeRate: Number,          // Tasa de cambio a quoteCurrency (auto-calculado)
  price: Number,                 // Precio unitario original (REQUERIDO)
  cost: Number,                  // Costo unitario (para cálculos de margen)

  // === DESCUENTOS ===
  discountRate: Number,          // Descuento en porcentaje (0-1, ej: 0.15 = 15%)
  discountAmount: Number,        // Descuento en monto absoluto
  specialPrice: Number,          // Precio después del descuento manual
  systemDiscountAmount: Number,  // Descuento del sistema (auto-calculado)
  originalDiscountAmount: Number, // Descuento original antes de ajustes (auto-calculado)
  originalDiscountRate: Number,  // Descuento original en porcentaje (auto-calculado)

  // === IMPUESTOS ===
  taxes: [ObjectId],             // Referencias a Tax objects

  // === FECHAS ===
  startDate: Date,               // Fecha de inicio del servicio/producto
  endDate: Date,                 // Fecha de fin del servicio/producto

  // === PAGOS ===
  numberOfPayments: Number,      // Número de cuotas para este line item
  upfrontPaymentRate: Number,    // Porcentaje de pago inicial (0-1)

  // === CATEGORIZACIÓN ===
  productGroup: ObjectId,        // Grupo del producto (ref: ProductGroup)
  productFamily: ObjectId,       // Familia del producto (ref: ProductFamily)
  productCategories: [ObjectId], // Categorías (ref: ProductCategory)

  // === NOTAS ===
  specialNotes: [String],        // Notas especiales visibles al cliente
  internalNotes: [String],       // Notas internas (no visibles al cliente)

  // === SNIPPETS Y CONTENIDO ===
  snippets: [ObjectId],          // ContentTemplates asociados

  // === PRECIOS CALCULADOS POR UNIDAD (AUTO-CALCULADOS) ===
  netUnitPrice: Number,          // Precio unitario después de descuentos, antes de impuestos
  netUnitDiscountAmount: Number, // Descuento por unidad
  netUnitDiscountRate: Number,   // Porcentaje de descuento por unidad
  netUnitTaxAmount: Number,      // Impuesto por unidad
  netUnitTaxRate: Number,        // Porcentaje de impuesto por unidad

  // === TOTALES (AUTO-CALCULADOS) ===
  subTotal: Number,              // price × netQuantity (antes de descuentos e impuestos)
  netTotal: Number,              // Después de descuentos, antes de impuestos
  netTotalDiscountAmount: Number, // Total de descuentos aplicados
  netTotalDiscountRate: Number,  // Porcentaje total de descuento
  netTotalTaxAmount: Number,     // Total de impuestos
  netTotalTaxRate: Number,       // Porcentaje total de impuestos
  total: Number,                 // TOTAL FINAL del line item

  // === MARKUP ===
  markupRate: Number,            // Margen de ganancia: (price - cost) / cost (auto-calculado)

  // === PRICING ESPECIAL ===
  pricingMethod: String,         // Enum: ['List', 'Percent Of Total']
  percentOfTotal: Number,        // Si pricingMethod es 'Percent Of Total' (0-1)
  percentOfTotalBase: String,    // Enum: ['subTotal', 'netTotal', 'total'] - base para el cálculo
  percentOfTotalProductTargets: [ObjectId], // Productos objetivo para %
  percentOfTotalProductFamilyTargets: [ObjectId], // Familias objetivo para %
  excludeFromPercentOfTotal: Boolean, // Excluir de cálculos de % de total

  // === REGLAS Y SCHEDULES ===
  rules: [ObjectId],             // ProductRules aplicadas
  discountSchedules: [ObjectId], // DiscountSchedules aplicados

  // === PRODUCTOS INCLUIDOS ===
  includedProducts: [ObjectId],  // Productos que este item incluye automáticamente
  includedLineIds: [ObjectId],   // lineIds de items incluidos por este (auto-calculado)

  // === FLAGS ===
  isFloorPrice: Boolean,         // Si el precio es mínimo permitido (auto-calculado)
  isVirtual: Boolean,            // Si es un item virtual o real (auto-calculado)

  // === EVENTOS DE CALENDARIO ===
  calendarEvents: [ObjectId],    // CalendarEvents asociados (para servicios con fechas)

  // === JERARQUÍA ===
  parent: String,                // ID del line item padre (para items agrupados)

  // === FACTURACIÓN ===
  assignedPercentage: Number,    // % del line item incluido en factura (0-100, default: 100)

  // === REFERENCIAS ===
  pricebook: ObjectId,           // Pricebook de donde viene (ref: Pricebook)
  pricebookEntry: ObjectId,      // PricebookEntry específico (ref: PricebookEntry)
  pricebookEntryCode: String,    // Código de la entrada del pricebook

  // === METADATOS ===
  meta: Mixed                    // Información adicional flexible
}
```

#### Ejemplo de Line Item Completo

```json
{
  "productName": "CRM Enterprise License",
  "productCode": "PRO-CRM-ENT-001",
  "description": "<p>Full-featured CRM with unlimited users and advanced analytics</p>",
  "quantity": 1,
  "currency": "USD",
  "price": 15000,
  "cost": 8000,
  "discountRate": 0.1,
  "taxes": ["507f1f77bcf86cd799439012"],
  "startDate": "2026-05-01T00:00:00.000Z",
  "endDate": "2027-04-30T00:00:00.000Z",
  "specialNotes": ["Includes 1 year of premium support"],
  "internalNotes": ["Customer is a tier 1 partner - approved for 10% discount"]
}
```

#### Ejemplo de Múltiples Line Items

```json
{
  "lineItems": [
    {
      "productName": "CRM Enterprise License",
      "productCode": "PRO-CRM-ENT-001",
      "quantity": 1,
      "currency": "USD",
      "price": 15000,
      "discountRate": 0.1
    },
    {
      "productName": "Implementation Services",
      "productCode": "SRV-IMPL-001",
      "quantity": 40,
      "unitMultiplier": 8,
      "unitMultiplierName": "hours",
      "currency": "USD",
      "price": 150,
      "description": "Professional implementation services - charged per day"
    },
    {
      "productName": "Training Package",
      "productCode": "SRV-TRAIN-001",
      "quantity": 10,
      "currency": "USD",
      "price": 500,
      "specialNotes": ["On-site training for up to 10 users"]
    }
  ]
}
```

---

## Flujo de Cálculo Automático en Prolibu

Prolibu calcula automáticamente muchos campos cuando se crea o actualiza un Deal con Quote. Estos son los principales:

### Cálculos Automáticos del Quote

1. **exchangeRates**: Se obtienen de tasas de cambio globales o personalizadas
2. **subTotal**: Suma de todos los `lineItems[].subTotal`
3. **discountAmount**: Suma de todos los descuentos de line items
4. **netTotal**: subTotal - discountAmount
5. **taxAmount**: Suma de todos los `lineItems[].netTotalTaxAmount`
6. **total**: netTotal + taxAmount
7. **convertedTotal**: total × tasa de cambio a moneda global del sistema
8. **hasProductRules**: true si algún line item tiene rules aplicadas
9. **hasDiscountSchedules**: true si algún line item tiene schedules aplicados

### Cálculos Automáticos del Line Item

1. **netQuantity**: quantity × (unitMultiplier || 1)
2. **exchangeRate**: Tasa de cambio desde `currency` a `quoteCurrency`
3. **specialPrice**: price - discountAmount (o price × (1 - discountRate))
4. **netUnitPrice**: Precio unitario después de todos los descuentos, antes de impuestos
5. **subTotal**: price × netQuantity
6. **netTotal**: specialPrice × netQuantity (después de descuentos)
7. **netTotalTaxAmount**: netTotal × suma de porcentajes de `taxes`
8. **total**: netTotal + netTotalTaxAmount
9. **markupRate**: (price - cost) / cost

---

## Campos Requeridos por Nivel

### Para crear un Deal Básico:

```json
{
  "dealName": "..." // OBLIGATORIO
}
```

### Para crear un Deal con Quote (sin line items):

```json
{
  "dealName": "...", // OBLIGATORIO
  "proposal": {
    "enabled": true, // OBLIGATORIO para tener quote
    "quote": {
      "quoteCurrency": "USD" // OBLIGATORIO
    }
  }
}
```

### Para crear un Deal con Quote y Line Items:

```json
{
  "dealName": "...", // OBLIGATORIO
  "proposal": {
    "enabled": true, // OBLIGATORIO
    "quote": {
      "quoteCurrency": "USD", // OBLIGATORIO
      "lineItems": [
        {
          "productName": "...", // OBLIGATORIO (para mostrar)
          "quantity": 1, // OBLIGATORIO
          "price": 100, // OBLIGATORIO
          "currency": "USD" // Recomendado (usa quoteCurrency si no se provee)
        }
      ]
    }
  }
}
```

---

## Endpoint para Calcular Quote

Prolibu tiene un endpoint especial para calcular todos los totales de un quote antes de guardarlo:

```
PUT /v2/quote/calculate
Authorization: Bearer <token>
Content-Type: application/json

{
  "quoteCurrency": "USD",
  "lineItems": [...]
}
```

**Respuesta**: El mismo quote con todos los campos calculados (totales, descuentos, impuestos, etc.)

---

## Endpoint para Crear Deal con Quote

```
POST /v2/deal/
Authorization: Bearer <token>
Content-Type: application/json

{
  "dealName": "...",
  "contact": "<contactId>",
  "proposal": {
    "enabled": true,
    "title": "...",
    "quote": {
      "quoteCurrency": "USD",
      "lineItems": [...]
    }
  }
}
```

---

## Consideraciones de Mapeo desde Salesforce

### Mapeo de Moneda

- Salesforce `CurrencyIsoCode` → Prolibu `quoteCurrency`
- Cada `QuoteLineItem.CurrencyIsoCode` → Prolibu `lineItems[].currency`

### Mapeo de Fechas

- Salesforce `Opportunity.CloseDate` → Prolibu `deal.closeDate`
- Salesforce `Quote.ExpirationDate` → Prolibu `deal.proposal.expirationDate`
- Salesforce `QuoteLineItem.ServiceDate` → Prolibu `lineItems[].startDate`

### Mapeo de Precios y Cantidades

- Salesforce `QuoteLineItem.Quantity` → Prolibu `lineItems[].quantity`
- Salesforce `QuoteLineItem.UnitPrice` → Prolibu `lineItems[].price`
- Salesforce `QuoteLineItem.Discount` → Prolibu `lineItems[].discountRate` (convertir a decimal: 15% → 0.15)

### Mapeo de Totales

- **IMPORTANTE**: Los totales en Prolibu son auto-calculados. NO se deben mapear directamente.
- Salesforce `Quote.TotalPrice` se ignorará; Prolibu lo calculará desde los line items.
- Salesforce `QuoteLineItem.TotalPrice` se ignorará; Prolibu lo calculará desde quantity × price - descuentos + impuestos.

### Mapeo de Impuestos

- Salesforce `QuoteLineItem.TaxCode` → Buscar en Prolibu el ObjectId del Tax correspondiente → `lineItems[].taxes[]`
- Si Salesforce tiene `Tax` o `TaxRate`, crear/buscar el equivalente en Prolibu primero

### Mapeo de Productos

- Salesforce `Product2.Name` → Prolibu `lineItems[].productName`
- Salesforce `Product2.ProductCode` → Prolibu `lineItems[].productCode`
- Salesforce `Product2.Description` → Prolibu `lineItems[].description`

### Mapeo de Contacto/Cuenta

- Salesforce `Opportunity.ContactId` → Prolibu `deal.contact` (buscar Contact en Prolibu por email o ID externo)
- Salesforce `Opportunity.AccountId` → Buscar Company en Prolibu y asignarlo a `deal.company` (aunque Prolibu lo puede auto-calcular desde contact)

### Mapeo de Stage/Etapa

- Salesforce `Opportunity.StageName` → Buscar/mapear a ObjectId de Stage en Prolibu → `deal.stage`
- Salesforce `Opportunity.Probability` → Puede usarse para inferir la etapa en Prolibu

### Mapeo de Campos Personalizados

- Salesforce Custom Fields → Prolibu `deal.meta` (objeto flexible para datos adicionales)

---

## Estructura JSON Completa de Ejemplo

### Deal con Quote y Multiple Line Items

```json
{
  "dealName": "Acme Corp - Enterprise CRM Implementation",
  "contact": "507f1f77bcf86cd799439011",
  "closeDate": "2026-08-31T00:00:00.000Z",
  "stage": "76a6f41079d81268f83fede3",
  "priority": "High",
  "source": {
    "type": "Referral",
    "details": "Referred by partner TechCorp"
  },
  "observations": "Large enterprise deal. Customer wants on-premise deployment.",
  "tags": ["enterprise", "on-premise", "high-value"],
  "proposal": {
    "enabled": true,
    "title": "Enterprise CRM Implementation Proposal",
    "quote": {
      "quoteCurrency": "USD",
      "startDate": "2026-05-01T00:00:00.000Z",
      "endDate": "2027-04-30T00:00:00.000Z",
      "additionalNotes": [
        "<p>This proposal includes enterprise licenses, implementation, and training.</p>",
        "<p>Support is included for the first year.</p>"
      ],
      "lineItems": [
        {
          "productName": "CRM Enterprise License",
          "productCode": "PRO-CRM-ENT-001",
          "description": "<p>Full-featured CRM with unlimited users, advanced analytics, and API access</p>",
          "quantity": 1,
          "currency": "USD",
          "price": 25000,
          "cost": 12000,
          "discountRate": 0.15,
          "taxes": ["507f1f77bcf86cd799439012"],
          "startDate": "2026-05-01T00:00:00.000Z",
          "endDate": "2027-04-30T00:00:00.000Z",
          "specialNotes": ["Annual license with premium support"],
          "internalNotes": ["Tier 1 partner discount applied - 15%"]
        },
        {
          "productName": "Implementation Services",
          "productCode": "SRV-IMPL-CRM-001",
          "description": "<p>Professional CRM implementation services including data migration, configuration, and customization</p>",
          "quantity": 60,
          "unitMultiplier": 8,
          "unitMultiplierName": "hours",
          "currency": "USD",
          "price": 150,
          "cost": 80,
          "taxes": ["507f1f77bcf86cd799439012"],
          "startDate": "2026-05-15T00:00:00.000Z",
          "endDate": "2026-07-15T00:00:00.000Z",
          "specialNotes": ["60 days of implementation at 8 hours per day"],
          "internalNotes": ["Senior consultants assigned to this project"]
        },
        {
          "productName": "On-Site Training Package",
          "productCode": "SRV-TRAIN-ONSITE-001",
          "description": "<p>Comprehensive on-site training for administrators and end users</p>",
          "quantity": 3,
          "currency": "USD",
          "price": 2000,
          "cost": 800,
          "taxes": ["507f1f77bcf86cd799439012"],
          "startDate": "2026-07-20T00:00:00.000Z",
          "specialNotes": [
            "3 days of on-site training for up to 20 users per session"
          ],
          "internalNotes": ["Travel expenses to be billed separately"]
        },
        {
          "productName": "Data Migration Service",
          "productCode": "SRV-DATA-MIG-001",
          "description": "<p>Migration of existing customer data from legacy CRM system</p>",
          "quantity": 1,
          "currency": "USD",
          "price": 5000,
          "cost": 2500,
          "discountAmount": 500,
          "taxes": ["507f1f77bcf86cd799439012"],
          "specialNotes": ["Includes migration of up to 100,000 records"],
          "internalNotes": ["Complex migration - legacy Salesforce system"]
        }
      ],
      "paymentPlan": {
        "enabled": true,
        "titleTemplate": "Payment {{number}} - {{dueDate}}",
        "paymentInterval": {
          "unit": "Month",
          "value": 1
        },
        "payments": []
      }
    },
    "expirationDate": "2026-05-31T00:00:00.000Z",
    "template": {
      "language": "en"
    }
  }
}
```

---

## Notas Importantes para el Agente de Salesforce

1. **No mapees totales directamente**: Prolibu calculará automáticamente todos los totales (subTotal, netTotal, total, etc.) tanto a nivel de quote como de line items. Solo provee los campos base (price, quantity, discounts, taxes).

2. **Convierte porcentajes**: Salesforce puede usar porcentajes como números enteros (15 para 15%), pero Prolibu usa decimales (0.15 para 15%).

3. **Maneja múltiples monedas**: Prolibu soporta line items en diferentes monedas dentro del mismo quote. El sistema convertirá automáticamente usando las tasas de cambio.

4. **Busca referencias primero**: Antes de crear un Deal con Quote, asegúrate de que existan:

   - Contact (mapear desde Salesforce Contact)
   - Stage (mapear desde Salesforce Opportunity Stage)
   - Tax (mapear desde Salesforce Tax/TaxRate)

5. **Usa el endpoint de calculate**: Antes de hacer POST del deal, puedes usar `PUT /v2/quote/calculate` para ver cómo quedarán los totales calculados.

6. **Maneja campos opcionales con cuidado**: Muchos campos son opcionales en Prolibu. Si Salesforce no tiene el dato, simplemente no incluyas el campo (no envíes null o undefined).

7. **Arrays vacíos vs undefined**: Para arrays como `lineItems`, `taxes`, `tags`, etc., envía array vacío `[]` si no hay datos, en lugar de omitir el campo.

8. **ObjectIds**: Los ObjectIds de Mongoose son strings hexadecimales de 24 caracteres. Si mapeaste IDs de Salesforce a Prolibu, usa esos ObjectIds; si no, omite campos como `contact`, `stage`, etc., y asígnalos manualmente después.

9. **Fechas en formato ISO**: Todas las fechas deben estar en formato ISO 8601 (ej: "2026-05-31T00:00:00.000Z").

10. **HTML en campos de texto rico**: Campos como `description`, `observations`, `additionalNotes` pueden contener HTML. Si Salesforce tiene texto plano, envuélvelo en `<p>` tags.

---

## Preguntas que Debes Poder Responder

Como agente de Salesforce creando el transformer, deberás resolver:

1. **¿Cómo mapear `Opportunity.Id` de Salesforce a Prolibu?**

   - Opción 1: Guardar en `deal.meta.salesforceOpportunityId`
   - Opción 2: Crear un mapping table externo

2. **¿Cómo mapear `Quote.Id` de Salesforce a Prolibu?**

   - Similar al anterior, en `deal.meta.salesforceQuoteId`

3. **¿Cómo mapear `QuoteLineItem.Id` de Salesforce a Prolibu?**

   - Guardar en `lineItems[].meta.salesforceLineItemId`

4. **¿Qué hacer si un Contact de Salesforce no existe en Prolibu?**

   - Opción 1: Crear el Contact primero
   - Opción 2: Omitir el campo `contact` y asignarlo manualmente después
   - Opción 3: Usar un Contact genérico de "Importación"

5. **¿Cómo mapear Stages de Salesforce a Prolibu?**

   - Crear un mapping manual: `{"Prospecting" => "76a6f41079d81268f83fede1", ...}`
   - O buscar por nombre en Prolibu: `GET /v2/stage?stageName=Prospecting`

6. **¿Cómo manejar Line Items con diferentes Tax Rates?**

   - Buscar/crear el Tax en Prolibu y guardar su ObjectId en `lineItems[].taxes[]`
   - Si no existe, omitir o crear Tax primero

7. **¿Qué hacer con campos personalizados de Salesforce?**

   - Guardarlos en `deal.meta.customFields` o `lineItems[].meta.customFields`

8. **¿Cómo manejar Quotes con Status "Draft" vs "Presented"?**

   - Mapear a `deal.stage` apropiado en Prolibu
   - O guardar en `deal.meta.salesforceQuoteStatus`

9. **¿Los descuentos de Salesforce son a nivel de Quote o Line Item?**

   - Si es a nivel de Quote, aplicar el mismo `discountRate` a todos los line items
   - Si es a nivel de Line Item, mapear individualmente

10. **¿Cómo manejar Products de Salesforce que no existen en Prolibu?**
    - Opción 1: Crear el Product en Prolibu primero
    - Opción 2: Crear line items "virtuales" con solo `productName`, `price`, `quantity` (sin referencia a Product)

---

## Contacto y Soporte

Si tienes dudas sobre algún campo específico o necesitas más detalles sobre cómo Prolibu calcula ciertos valores, consulta:

- Modelo Deal: `/app/modules/sales/models/Deal.js`
- Modelo Quote: `/app/modules/pricing/models/Quote.js`
- Line Item Attrs: `/app/attrs/LineItemAttrs.js`
- Tests de Deal: `/app/test/models/Deal.test.js`

---

**Fin del documento de especificación.**
