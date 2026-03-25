# Documento Técnico: Custom Fields y Custom Objects

## Tabla de Contenidos

1. [Introducción](#introducción)
2. [Custom Fields](#custom-fields)
3. [Custom Objects (COBs)](#custom-objects-cobs)
4. [Ejemplos Prácticos](#ejemplos-prácticos)
5. [API Reference](#api-reference)
6. [Validaciones y Restricciones](#validaciones-y-restricciones)
7. [Proceso de Backend](#proceso-de-backend)

---

## Introducción

El sistema permite extender los modelos existentes y crear nuevos objetos personalizados de forma dinámica sin necesidad de modificar el código fuente. Esto se logra a través de dos mecanismos principales:

- **Custom Fields**: Permiten agregar campos personalizados a modelos existentes
- **Custom Objects (COBs)**: Permiten crear modelos completamente nuevos

Ambos mecanismos utilizan MongoDB y Mongoose para gestionar los esquemas de forma dinámica.

---

## Custom Fields

### ¿Qué son los Custom Fields?

Los Custom Fields permiten extender modelos existentes (User, Contact, Deal, etc.) agregando nuevos atributos o modificando atributos existentes sin alterar el código de los modelos base.

### Ubicación del Modelo

**Archivo**: `/app/modules/system/models/CustomField.js`

### Estructura del Modelo CustomField

```javascript
const attrs = {
  objectAssigned: {
    type: String,
    required: true,
    unique: true, // Solo puede haber un CustomField por modelo
    enum: skem.enums.modelNames,
    description: "Modelo donde se aplicarán los custom fields",
    example: "User",
  },
  customFields: {
    type: Schema.Types.Mixed,
    description:
      "Campos anidados bajo la propiedad customFields (e.g., Deal.customFields.color)",
  },
  overrides: {
    type: Schema.Types.Mixed,
    description:
      "Sobreescribe atributos existentes o crea nuevos campos a nivel raíz del schema",
  },
  active: Boolean,
  status: String, // Resultado del proceso de validación
};
```

### Tipos de Custom Fields

#### 1. **customFields** (Campos anidados)

Crea campos bajo la propiedad `customFields` del modelo. Útil para mantener los campos personalizados organizados y separados de los campos base.

**Estructura de ruta**: `Model.customFields.nombreCampo`

**Ejemplo**:

```json
{
  "objectAssigned": "Contact",
  "customFields": {
    "color": {
      "isCustomField": true,
      "type": "string",
      "description": "Color favorito",
      "example": "blue",
      "faker": "color.human"
    },
    "size": {
      "isCustomField": true,
      "type": "string",
      "enum": ["small", "medium", "large"],
      "description": "Tamaño preferido",
      "faker": "custom.randItem",
      "fakerArgs": [["small", "medium", "large"]]
    },
    "assignee": {
      "isCustomField": true,
      "type": "objectid",
      "ref": "User",
      "description": "Usuario asignado"
    },
    "meta": {
      "isCustomField": true,
      "type": "mixed",
      "description": "Metadatos adicionales"
    }
  }
}
```

**Uso en el código**:

```javascript
// Crear contacto con custom fields
const contact = await Contact.create({
  firstName: "Juan",
  lastName: "Pérez",
  customFields: {
    color: "blue",
    size: "medium",
    assignee: userId,
  },
});

// Acceder a los campos
console.log(contact.customFields.color); // 'blue'
```

#### 2. **overrides** (Sobreescritura y nuevos campos raíz)

Permite dos funcionalidades:

- **Sobreescribir** atributos existentes del modelo (ej: hacer requerido un campo opcional)
- **Crear** nuevos campos a nivel raíz del schema (no bajo customFields)

**Estructura de ruta**: `Model.nombreCampo`

**Ejemplo**:

```json
{
  "objectAssigned": "Deal",
  "overrides": {
    "lastName": {
      "isCustomField": true,
      "required": true, // Sobreescribe el campo existente lastName
      "description": "Apellido del contacto (requerido)"
    },
    "tipoEvento": {
      "isCustomField": true,
      "type": "string", // Crea nuevo campo a nivel raíz
      "enum": ["Evento", "Alojamiento", "Evento y Alojamiento"],
      "description": "Tipo de evento"
    },
    "fechaHoraIngreso": {
      "isCustomField": true,
      "type": "date",
      "uiCom": "DateTime",
      "description": "Fecha y hora de ingreso"
    }
  }
}
```

**Uso en el código**:

```javascript
// Crear deal con overrides
const deal = await Deal.create({
  dealName: "Conferencia 2024",
  lastName: "García", // Ahora es requerido
  tipoEvento: "Evento", // Nuevo campo raíz
  fechaHoraIngreso: new Date(), // Nuevo campo raíz
});

// Acceder a los campos
console.log(deal.tipoEvento); // 'Evento'
console.log(deal.fechaHoraIngreso); // Date object
```

### Propiedades Disponibles para Custom Fields

```javascript
{
  isCustomField: true,           // ✅ REQUERIDO para identificar el campo
  type: 'string',                // ✅ REQUERIDO: string, number, date, boolean, objectid, mixed, array, etc.
  required: true,                // Hace el campo obligatorio
  unique: true,                  // Valor único en la colección
  default: 'valor',              // Valor por defecto
  enum: ['val1', 'val2'],        // Lista de valores permitidos
  min: 0,                        // Valor mínimo (numbers)
  max: 100,                      // Valor máximo (numbers)
  minlength: 5,                  // Longitud mínima (strings)
  maxlength: 50,                 // Longitud máxima (strings)
  ref: 'ModelName',              // Referencia a otro modelo (para ObjectId)
  description: 'Descripción',    // Descripción del campo
  example: 'ejemplo',            // Ejemplo de valor
  faker: 'color.human',          // Generador de datos faker
  fakerArgs: [['a', 'b']],       // Argumentos para faker
  uiCom: 'DateTime',             // Componente UI personalizado
  dependsOn: {...},              // Lógica condicional para mostrar campo
  textIndex: true,               // Índice de texto para búsquedas
  avoid: 'always',               // Evitar incluir en respuestas
  // Y muchas más propiedades estándar de Mongoose
}
```

### Tipos de Datos Soportados

```javascript
// Tipos básicos
type: "string";
type: "number";
type: "boolean";
type: "date";
type: "buffer";

// Tipos especiales
type: "objectid"; // Referencias a otros modelos
type: "mixed"; // Cualquier tipo de dato
type: "decimal128"; // Números decimales de alta precisión

// Tipos colección
type: "array";
type: "map";

// Arrays tipados
type: ["string"]; // Array de strings
type: [{ type: "objectid", ref: "User" }]; // Array de referencias
```

### Validación de Nombres de Atributos

El sistema valida que los nombres de atributos cumplan con estas reglas:

```javascript
// ✅ Válidos
"miCampo";
"campo_1";
"$specialField";
"_privateField";

// ❌ Inválidos
"mi-campo"; // No se permiten guiones
"1campo"; // No puede empezar con número
"campo con espacios"; // No se permiten espacios
"break"; // Palabra reservada de JavaScript
"for"; // Palabra reservada de JavaScript
"class"; // Palabra reservada de JavaScript
```

**Palabras Reservadas** (no se pueden usar):

```
break, case, catch, class, const, continue, debugger, default, delete,
do, else, export, extends, finally, for, function, if, import, in,
instanceof, let, new, return, super, switch, this, throw, try, typeof,
var, void, while, with, yield
```

---

## Custom Objects (COBs)

### ¿Qué son los Custom Objects?

Los Custom Objects (COBs) permiten crear modelos completamente nuevos de forma dinámica. Son ideales para crear entidades de negocio específicas sin tener que modificar el código fuente.

### Ubicación del Modelo

**Archivo**: `/app/modules/system/models/Cob.js`

### Estructura del Modelo Cob

```javascript
const attrs = {
  modelName: {
    type: String,
    required: true,
    unique: true,
    description: "Nombre del Custom Object",
    example: "Pet",
    // Se convierte automáticamente a PascalCase singular
  },
  active: Boolean,
  unset: {
    methods: [String], // Métodos a desactivar
    permissions: [String], // Permisos a desactivar
  },
  // ... resto de campos dinámicos
};

const config = {
  strict: false, // Permite campos adicionales dinámicos
};
```

### Campos Reservados

Los siguientes campos son **reservados** y no pueden usarse como atributos del COB:

```javascript
const RESERVED_FIELDS = [
  "_id",
  "__v",
  "modelName",
  "active",
  "unset",
  "createdAt",
  "updatedAt",
  "createdBy",
  "updatedBy",
];
```

### Nombres de Modelo Reservados

Estos nombres **NO** pueden usarse como nombre de COB porque están reservados por el sistema:

```javascript
const RESERVED_MODEL_NAMES = [
  // Utilidades globales
  "u",
  "u2",
  "logger",
  "skem",
  "Db",
  "Core",
  "playground",
  "_",
  "lodash",
  "mongoose",
  "Test",
  "Calc",
  "Err",
  "Res",
  "Validator",
  "Dict",
  "Cache",
  "Attrs",
  "Msg",
];
```

Además, no se puede usar el nombre de ningún modelo existente (User, Contact, Deal, etc.).

### Transformación Automática del Nombre

El sistema transforma automáticamente el nombre del modelo:

```javascript
// Ejemplos de transformación
"mis motos"    → "MiMoto"      // Singular, PascalCase
"My Models"    → "MyModel"     // Singular, PascalCase
"pet"          → "Pet"         // PascalCase
"CARS"         → "Car"         // Singular, PascalCase
```

### Creación de un Custom Object

#### Ejemplo Básico: Modelo "Pet"

```json
{
  "modelName": "Pet",
  "active": true,
  "petName": {
    "type": "string",
    "required": true,
    "displayName": true,
    "textIndex": true,
    "description": "Nombre de la mascota"
  },
  "species": {
    "type": "string",
    "enum": ["Dog", "Cat", "Bird", "Fish", "Other"],
    "required": true,
    "description": "Especie de la mascota"
  },
  "breed": {
    "type": "string",
    "description": "Raza de la mascota"
  },
  "birthDate": {
    "type": "date",
    "description": "Fecha de nacimiento"
  },
  "owner": {
    "type": "objectid",
    "ref": "User",
    "required": true,
    "description": "Propietario de la mascota"
  },
  "vaccinations": {
    "type": "array",
    "items": {
      "name": { "type": "string" },
      "date": { "type": "date" },
      "nextDue": { "type": "date" }
    },
    "description": "Historial de vacunación"
  }
}
```

#### Ejemplo Intermedio: Modelo "Vehicle"

```json
{
  "modelName": "Vehicle",
  "active": true,
  "vin": {
    "type": "string",
    "required": true,
    "unique": true,
    "displayName": true,
    "description": "Número de identificación del vehículo"
  },
  "make": {
    "type": "string",
    "required": true,
    "description": "Marca del vehículo"
  },
  "model": {
    "type": "string",
    "required": true,
    "description": "Modelo del vehículo"
  },
  "year": {
    "type": "number",
    "required": true,
    "min": 1900,
    "max": 2100,
    "description": "Año de fabricación"
  },
  "color": {
    "type": "string",
    "description": "Color del vehículo"
  },
  "mileage": {
    "type": "number",
    "min": 0,
    "description": "Kilometraje"
  },
  "owner": {
    "type": "objectid",
    "ref": "Contact",
    "description": "Propietario del vehículo"
  },
  "maintenanceHistory": {
    "type": "array",
    "items": {
      "date": { "type": "date" },
      "type": { "type": "string" },
      "cost": { "type": "number" },
      "notes": { "type": "string" }
    },
    "description": "Historial de mantenimiento"
  }
}
```

#### Ejemplo Avanzado: Modelo "Project"

```json
{
  "modelName": "Project",
  "active": true,
  "unset": {
    "methods": ["delete"],
    "permissions": ["DeleteRecord"]
  },
  "projectCode": {
    "type": "string",
    "required": true,
    "unique": true,
    "displayName": true,
    "textIndex": true,
    "description": "Código único del proyecto"
  },
  "projectName": {
    "type": "string",
    "required": true,
    "textIndex": true,
    "description": "Nombre del proyecto"
  },
  "description": {
    "type": "string",
    "description": "Descripción detallada"
  },
  "status": {
    "type": "string",
    "enum": ["Planning", "In Progress", "On Hold", "Completed", "Cancelled"],
    "default": "Planning",
    "required": true,
    "description": "Estado del proyecto"
  },
  "priority": {
    "type": "string",
    "enum": ["Low", "Medium", "High", "Critical"],
    "default": "Medium",
    "description": "Prioridad del proyecto"
  },
  "startDate": {
    "type": "date",
    "description": "Fecha de inicio"
  },
  "endDate": {
    "type": "date",
    "description": "Fecha de finalización"
  },
  "estimatedBudget": {
    "type": "number",
    "min": 0,
    "description": "Presupuesto estimado"
  },
  "actualCost": {
    "type": "number",
    "min": 0,
    "description": "Costo real"
  },
  "projectManager": {
    "type": "objectid",
    "ref": "User",
    "required": true,
    "description": "Gerente del proyecto"
  },
  "team": {
    "type": ["objectid"],
    "ref": "User",
    "description": "Equipo de trabajo"
  },
  "client": {
    "type": "objectid",
    "ref": "Company",
    "description": "Cliente del proyecto"
  },
  "tags": {
    "type": ["string"],
    "description": "Etiquetas del proyecto"
  },
  "milestones": {
    "type": "array",
    "items": {
      "name": { "type": "string" },
      "dueDate": { "type": "date" },
      "completed": { "type": "boolean" },
      "completedDate": { "type": "date" }
    },
    "description": "Hitos del proyecto"
  }
}
```

---

## Ejemplos Prácticos

### Custom Fields: Extender el Modelo User

```javascript
// 1. Crear el CustomField
const customField = await CustomField.create({
  objectAssigned: "User",
  customFields: {
    employeeId: {
      isCustomField: true,
      type: "string",
      required: true,
      unique: true,
      description: "ID de empleado",
    },
    department: {
      isCustomField: true,
      type: "string",
      enum: ["Engineering", "Sales", "Marketing", "HR", "Finance"],
      description: "Departamento",
    },
    hireDate: {
      isCustomField: true,
      type: "date",
      description: "Fecha de contratación",
    },
    salary: {
      isCustomField: true,
      type: "number",
      min: 0,
      avoid: "always", // No exponer en APIs
      description: "Salario",
    },
  },
});

// 2. Reiniciar el servidor (en producción) o esperar sync (en test)

// 3. Usar los nuevos campos
const user = await User.create({
  firstName: "Ana",
  lastName: "López",
  email: "ana@example.com",
  customFields: {
    employeeId: "EMP001",
    department: "Engineering",
    hireDate: new Date("2024-01-15"),
    salary: 75000,
  },
});

// 4. Consultar con los nuevos campos
const engineers = await User.find({
  "customFields.department": "Engineering",
});
```

### Custom Fields: Sobreescribir Campos del Modelo Deal

```javascript
// 1. Crear CustomField con overrides
const dealCustomField = await CustomField.create({
  objectAssigned: "Deal",
  overrides: {
    // Sobreescribir campo existente
    amount: {
      isCustomField: true,
      required: true, // Hacer obligatorio
      min: 1000, // Monto mínimo
      description: "Monto del negocio (mínimo $1000)",
    },
    // Agregar nuevos campos a nivel raíz
    contractType: {
      isCustomField: true,
      type: "string",
      enum: ["Monthly", "Annual", "One-time"],
      required: true,
      description: "Tipo de contrato",
    },
    paymentTerms: {
      isCustomField: true,
      type: "string",
      enum: ["Net 30", "Net 60", "Upfront", "Milestone"],
      description: "Términos de pago",
    },
  },
});

// 2. Usar los campos modificados
const deal = await Deal.create({
  dealName: "Contrato Anual XYZ",
  amount: 50000, // Ahora es requerido y mínimo 1000
  contractType: "Annual", // Nuevo campo raíz
  paymentTerms: "Net 60", // Nuevo campo raíz
});
```

### Custom Object: Crear y Usar un Modelo Pet

```javascript
// 1. Crear el Custom Object
const petCob = await Cob.create({
  modelName: "Pet",
  active: true,
  petName: {
    type: "string",
    required: true,
    displayName: true,
  },
  species: {
    type: "string",
    enum: ["Dog", "Cat", "Bird"],
    required: true,
  },
  owner: {
    type: "objectid",
    ref: "User",
  },
});

// 2. Reiniciar el servidor

// 3. El modelo Pet ahora está disponible globalmente
const pet = await Pet.create({
  petName: "Rex",
  species: "Dog",
  owner: userId,
});

// 4. Usar como cualquier otro modelo
const pets = await Pet.find({ species: "Dog" }).populate("owner").limit(10);

// 5. Acceder vía API REST
// GET /v2/pet
// GET /v2/pet/:id
// POST /v2/pet
// PATCH /v2/pet/:id
// DELETE /v2/pet/:id
```

---

## API Reference

### Custom Fields

#### Crear Custom Field

```http
POST /v2/customfield
Authorization: Bearer {token}
Content-Type: application/json

{
  "objectAssigned": "Contact",
  "customFields": {
    "preferredLanguage": {
      "isCustomField": true,
      "type": "string",
      "enum": ["en", "es", "fr", "de"]
    }
  }
}
```

#### Obtener Custom Field

```http
GET /v2/customfield/:id
Authorization: Bearer {token}
```

#### Listar Custom Fields

```http
GET /v2/customfield
Authorization: Bearer {token}
```

#### Actualizar Custom Field

```http
PATCH /v2/customfield/:id
Authorization: Bearer {token}
Content-Type: application/json

{
  "customFields": {
    "preferredLanguage": {
      "isCustomField": true,
      "type": "string",
      "enum": ["en", "es", "fr", "de", "pt", "it"]
    }
  }
}
```

#### Eliminar Custom Field

```http
DELETE /v2/customfield/:id
Authorization: Bearer {token}
```

### Custom Objects (COBs)

#### Crear Custom Object

```http
POST /v2/cob
Authorization: Bearer {token}
Content-Type: application/json

{
  "modelName": "Pet",
  "active": true,
  "petName": {
    "type": "string",
    "required": true
  },
  "species": {
    "type": "string",
    "enum": ["Dog", "Cat", "Bird"]
  }
}
```

#### Obtener Custom Object

```http
GET /v2/cob/:id
Authorization: Bearer {token}
```

#### Listar Custom Objects

```http
GET /v2/cob
Authorization: Bearer {token}
```

#### Actualizar Custom Object

```http
PATCH /v2/cob/:id
Authorization: Bearer {token}
Content-Type: application/json

{
  "petName": {
    "type": "string",
    "required": true,
    "textIndex": true
  }
}
```

#### Eliminar Custom Object

```http
DELETE /v2/cob/:id
Authorization: Bearer {token}
```

---

## Validaciones y Restricciones

### Custom Fields

#### Validaciones Aplicadas

1. **Modelo debe existir**: El `objectAssigned` debe ser un modelo válido del sistema
2. **Único por modelo**: Solo puede haber un CustomField por modelo (unique: true en objectAssigned)
3. **Campo isCustomField requerido**: Todos los campos deben tener `isCustomField: true`
4. **Tipo requerido para customFields**: Los campos bajo `customFields` deben especificar `type`
5. **Tipo requerido para nuevos campos en overrides**: Los nuevos campos en `overrides` deben especificar `type`
6. **Validación de nombres**: Los nombres de atributos deben cumplir con las reglas JavaScript
7. **Sin palabras reservadas**: No se pueden usar palabras reservadas de JavaScript
8. **Al menos un tipo**: Debe especificarse al menos `customFields` o `overrides`
9. **Validación de schema**: El schema completo se valida con Mongoose antes de aplicar

#### Respuestas de Validación

```javascript
// ❌ Error: Modelo no encontrado
{
  "error": "Not found.",
  "field": "objectAssigned"
}

// ❌ Error: Tipo no especificado
{
  "error": "The type is required in customFields.",
  "field": "customFields.color"
}

// ❌ Error: Nombre inválido
{
  "error": "Invalid attribute name.",
  "invalidKey": "mi-campo"
}

// ❌ Error: Palabra reservada
{
  "error": "Conflicts with a reserved JavaScript keyword in attribute name.",
  "invalidKey": "class"
}

// ✅ Éxito
{
  "_id": "...",
  "objectAssigned": "User",
  "customFields": {...},
  "active": true,
  "status": "Success: 'User' Custom fields loaded successfully."
}
```

### Custom Objects (COBs)

#### Validaciones Aplicadas

1. **Nombre único**: El `modelName` debe ser único en el sistema
2. **Nombre válido**: Debe cumplir con las reglas de JavaScript para identificadores
3. **No usar nombres reservados**: No se pueden usar nombres de la lista RESERVED_MODEL_NAMES
4. **No duplicar modelos**: No se puede usar el nombre de un modelo existente
5. **Schema válido**: Todos los atributos deben tener una estructura Mongoose válida
6. **No usar campos reservados**: No se pueden usar los campos de RESERVED_FIELDS como atributos

#### Respuestas de Validación

```javascript
// ❌ Error: Nombre reservado
{
  "error": "The model name 'User' is reserved by the system and cannot be used as a Custom Object name.",
  "statusCode": 400
}

// ❌ Error: Modelo duplicado
{
  "error": "The model name 'Contact' is already used by an existing model and cannot be used as a Custom Object name.",
  "statusCode": 400
}

// ❌ Error: Schema inválido
{
  "error": "Path mismatch for key.",
  "val": "petName"
}

// ✅ Éxito
{
  "_id": "...",
  "modelName": "Pet",
  "active": true,
  "petName": {...},
  "species": {...}
}
```

---

## Proceso de Backend

### Flujo de Creación de Custom Fields

```
1. Usuario hace POST /v2/customfield
   ↓
2. CustomField.afterValidate(doc)
   ├─ Verificar que el modelo existe
   ├─ Procesar customFields
   │  ├─ Buscar campos con isCustomField: true
   │  ├─ Validar nombres de atributos
   │  ├─ Validar que tengan type definido
   │  └─ Limpiar y reorganizar el objeto customFields
   ├─ Procesar overrides
   │  ├─ Buscar campos con isCustomField: true
   │  ├─ Validar nombres de atributos
   │  ├─ Para campos existentes: heredar tipo
   │  ├─ Para campos nuevos: validar que tengan type
   │  └─ Limpiar y reorganizar el objeto overrides
   ├─ Validar que haya al menos customFields o overrides
   └─ Validar schemas con u2.validateSchema()
   ↓
3. Guardar en DB
   ↓
4. CustomField.afterCreateOrUpdate()
   └─ u.publishRestart('CustomField updated')
   ↓
5. Reinicio del servidor (en producción)
   ↓
6. Core.loadModels()
   ├─ Cargar customFields desde DB
   ├─ Para cada modelo con customFields:
   │  ├─ Aplicar customFields bajo attrs.customFields
   │  ├─ Aplicar custom overrides a nivel raíz
   │  ├─ Convertir tipos: u2.convertSchemaTypes()
   │  ├─ Crear Schema de Mongoose
   │  └─ Actualizar status del CustomField
   └─ Registrar modelo con mongoose.model()
   ↓
7. Modelo disponible con nuevos campos
```

### Flujo de Creación de Custom Objects

```
1. Usuario hace POST /v2/cob
   ↓
2. Procesamiento del modelName
   └─ setter transforma a PascalCase singular
      "mis motos" → "MiMoto"
   ↓
3. Cob.afterValidate(doc)
   ├─ Verificar que modelName no esté reservado
   ├─ Verificar que no exista un modelo con ese nombre
   ├─ Extraer schemaAttrs con getSchemaAttrs()
   │  └─ Excluir RESERVED_FIELDS del schema
   └─ Validar schema con u2.validateSchema()
   ↓
4. Guardar en DB
   ↓
5. Cob.afterCreateOrUpdate(doc)
   └─ u.publishRestart('Cob updated')
   ↓
6. Reinicio del servidor (en producción)
   ↓
7. Core.loadModels()
   ├─ Cargar cobs desde DB
   ├─ Para cada COB:
   │  ├─ Extraer schemaAttrs con getSchemaAttrs()
   │  ├─ Convertir tipos: u2.convertSchemaTypes()
   │  ├─ Crear Schema de Mongoose
   │  └─ Registrar modelo con mongoose.model()
   └─ Agregar a skem.enums.modelNames
   ↓
8. COB disponible como modelo global
   └─ Accesible vía: global[modelName]
   └─ API REST automática: /v2/{modelname}
```

### Proceso de Conversión de Tipos

El sistema convierte tipos string a tipos Mongoose usando `u2.convertSchemaTypes()`:

```javascript
// Mapeo de tipos
const typeMapping = {
  'string' → String,
  'number' → Number,
  'date' → Date,
  'boolean' → Boolean,
  'objectid' → Schema.Types.ObjectId,
  'mixed' → Schema.Types.Mixed,
  'array' → Array,
  'map' → Map,
  ['string'] → [String],  // Array de strings
  // etc...
};

// Ejemplo de conversión
// Antes:
{
  petName: {
    type: 'string',
    required: true
  }
}

// Después:
{
  petName: {
    type: String,
    required: true
  }
}
```

### Reinicio del Servidor

En **producción**, los cambios en CustomFields y COBs requieren reiniciar el servidor:

```javascript
// Después de crear/actualizar/eliminar
await u.publishRestart("CustomField updated");
// o
await u.publishRestart("Cob deleted");
```

En **modo test**, los schemas se actualizan automáticamente sin reiniciar:

```javascript
if (u.isTest()) {
  // Actualizar schema en caliente
  const schema = new Schema(schemaAttrs, {
    collection: modelName.toLowerCase(),
  });
  mongoose.model(modelName, schema);
}
```

---

## Mejores Prácticas

### Custom Fields

1. **Organización**: Usa `customFields` para mantener los campos personalizados organizados
2. **Overrides consciente**: Usa `overrides` solo cuando necesites modificar campos existentes o crear campos a nivel raíz
3. **Documentación**: Siempre incluye `description` en tus campos
4. **Validación**: Usa `enum`, `min`, `max` para validar datos
5. **Referencias**: Usa `ref` para relacionar con otros modelos
6. **Privacidad**: Usa `avoid: 'always'` para campos sensibles
7. **Nombres claros**: Usa nombres descriptivos en camelCase

### Custom Objects

1. **Nombres singulares**: El sistema convierte automáticamente a singular, pero es mejor usar singular desde el inicio
2. **PascalCase**: Usa PascalCase para nombres de modelo: "Pet", "Vehicle", "ProjectTask"
3. **displayName**: Marca un campo como `displayName: true` para identificar el registro
4. **textIndex**: Usa `textIndex: true` en campos de búsqueda
5. **Referencias**: Aprovecha las referencias con `ref` para relacionar modelos
6. **Validaciones**: Define `required`, `enum`, `min`, `max` según sea necesario
7. **unset**: Usa `unset.methods` y `unset.permissions` para personalizar el comportamiento

### Seguridad

1. **Permisos**: Los CustomFields y COBs heredan el sistema de permisos RBAC
2. **Validación**: Todos los schemas son validados antes de aplicarse
3. **Nombres seguros**: Se validan nombres contra palabras reservadas
4. **Aislamiento**: Los CustomFields están aislados por `objectAssigned` (unique)

---

## Testing

### Ejemplo de Test para Custom Fields

```javascript
describe("CustomField API", () => {
  let bearer;

  it("Should create custom field for User", async () => {
    const response = await request(app)
      .post("/v2/customfield")
      .set("Authorization", bearer)
      .send({
        objectAssigned: "User",
        customFields: {
          employeeId: {
            isCustomField: true,
            type: "string",
            required: true,
          },
        },
      });

    expect(response.statusCode).toBe(201);
    expect(response.body.objectAssigned).toBe("User");
  });

  it("Should use custom field in User model", async () => {
    const user = await User.create({
      firstName: "Test",
      lastName: "User",
      email: "test@example.com",
      customFields: {
        employeeId: "EMP123",
      },
    });

    expect(user.customFields.employeeId).toBe("EMP123");
  });
});
```

### Ejemplo de Test para Custom Objects

```javascript
describe("COB API", () => {
  let bearer;

  it("Should create Pet COB", async () => {
    const response = await request(app)
      .post("/v2/cob")
      .set("Authorization", bearer)
      .send({
        modelName: "Pet",
        active: true,
        petName: {
          type: "string",
          required: true,
        },
      });

    expect(response.statusCode).toBe(201);
    expect(response.body.modelName).toBe("Pet");
  });

  it("Should create Pet instance", async () => {
    const pet = await Pet.create({
      petName: "Rex",
    });

    expect(pet.petName).toBe("Rex");
    expect(global.Pet).toBeDefined();
  });
});
```

---

## Troubleshooting

### Problema: "Model not found"

**Causa**: El modelo especificado en `objectAssigned` no existe

**Solución**: Verifica que el nombre del modelo sea exacto (case-sensitive) y que el modelo esté registrado en el sistema

```javascript
// ❌ Incorrecto
{
  objectAssigned: "user";
} // debe ser 'User'

// ✅ Correcto
{
  objectAssigned: "User";
}
```

### Problema: "The type is required"

**Causa**: Falta especificar el tipo en un campo de `customFields` o en un campo nuevo de `overrides`

**Solución**: Agrega la propiedad `type` a todos los campos

```javascript
// ❌ Incorrecto
customFields: {
  color: {
    isCustomField: true
    // falta type
  }
}

// ✅ Correcto
customFields: {
  color: {
    isCustomField: true,
    type: 'string'
  }
}
```

### Problema: "Invalid attribute name"

**Causa**: El nombre del atributo contiene caracteres no permitidos

**Solución**: Usa solo letras, números, underscore y $. Debe empezar con letra, \_ o $

```javascript
// ❌ Incorrecto
{ "my-field": {...} }
{ "1field": {...} }

// ✅ Correcto
{ "myField": {...} }
{ "_field1": {...} }
```

### Problema: "Reserved keyword"

**Causa**: Intentas usar una palabra reservada de JavaScript como nombre de atributo

**Solución**: Elige otro nombre que no sea una palabra reservada

```javascript
// ❌ Incorrecto
{ "class": {...} }
{ "return": {...} }

// ✅ Correcto
{ "className": {...} }
{ "returnDate": {...} }
```

### Problema: Custom Fields no se aplican después de crearlos

**Causa**: El servidor no se ha reiniciado

**Solución**: Reinicia el servidor o espera el reinicio automático (en producción)

```bash
# Desarrollo
npm restart

# Producción
# El sistema publica un evento de reinicio automáticamente
```

### Problema: "Model name is reserved"

**Causa**: Intentas crear un COB con un nombre reservado o que ya existe

**Solución**: Elige un nombre único que no esté en RESERVED_MODEL_NAMES ni en los modelos existentes

```javascript
// ❌ Incorrecto
{
  modelName: "User";
} // Ya existe
{
  modelName: "skem";
} // Reservado

// ✅ Correcto
{
  modelName: "Pet";
}
{
  modelName: "Vehicle";
}
```

---

## Conclusión

Los Custom Fields y Custom Objects son herramientas poderosas para extender y personalizar el sistema sin modificar el código fuente. Siguiendo las guías y mejores prácticas de este documento, puedes crear soluciones flexibles y mantenibles para necesidades de negocio específicas.

### Recursos Adicionales

- Código fuente CustomField: `/app/modules/system/models/CustomField.js`
- Código fuente COB: `/app/modules/system/models/Cob.js`
- Tests CustomField: `/app/test/models/CustomField.test.js`
- Utilidades de validación: `/app/lib/Utils2.js`
- Core de carga de modelos: `/app/lib/Core.js`

### Contacto y Soporte

Para preguntas o problemas con Custom Fields y Custom Objects, contacta al equipo de desarrollo.

---

**Versión del documento**: 1.0  
**Última actualización**: Marzo 2026  
**Autor**: Sistema SKEM
