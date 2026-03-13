# Consulta de Atributos de Modelos - Documentación Técnica

## Tabla de Contenidos

1. [Introducción](#introducción)
2. [Conceptos Clave](#conceptos-clave)
3. [Métodos de Acceso a Schemas](#métodos-de-acceso-a-schemas)
4. [User.getUserSchema() - Método Principal](#usergetuserschema---método-principal)
5. [API Endpoint: GET /v2/user/me](#api-endpoint-get-v2userme)
6. [API Endpoint: GET /v2/service/getSchema](#api-endpoint-get-v2servicegetschema)
7. [Estructura de Atributos](#estructura-de-atributos)
8. [Propiedades de los Atributos](#propiedades-de-los-atributos)
9. [Filtrado Basado en Permisos](#filtrado-basado-en-permisos)
10. [Ejemplos de Uso](#ejemplos-de-uso)
11. [Casos de Uso Especiales](#casos-de-uso-especiales)
12. [Referencias Adicionales](#referencias-adicionales)

---

## Introducción

Este documento técnico explica cómo consultar y acceder a los atributos (schemas) de los modelos en el backend. Los schemas de los modelos son fundamentales para:

- **Validación de datos**: Conocer los tipos y restricciones de cada campo
- **Generación de formularios dinámicos**: Crear UIs automáticamente basadas en el schema
- **Documentación automática**: Generar documentación de APIs
- **Control de permisos**: Filtrar campos según los permisos del usuario
- **Custom Fields**: Incluir campos personalizados dinámicos

## Conceptos Clave

### Model.attrs

Cada modelo de Mongoose en el sistema tiene una propiedad `attrs` que contiene la definición completa de todos sus atributos:

```javascript
const Contact = u.getModel("Contact");
console.log(Contact.attrs);
// {
//   firstName: { type: String, required: true, displayName: 'First Name', ... },
//   lastName: { type: String, displayName: 'Last Name', ... },
//   email: { type: String, unique: true, ... },
//   ...
// }
```

### Model.keyRoutes

Array que contiene todas las rutas de acceso a los campos del modelo, incluyendo campos anidados:

```javascript
console.log(Contact.keyRoutes);
// ['firstName', 'lastName', 'email', 'address.street', 'address.city', ...]
```

### Schema Types

El sistema soporta diferentes tipos de schemas:

- **attrs**: Definición completa de atributos con todas sus propiedades
- **columns**: Solo las rutas de columnas (keyRoutes)
- **arrays**: Solo campos de tipo array

---

## Métodos de Acceso a Schemas

### 1. Acceso Directo al Modelo

```javascript
// Obtener el modelo
const Model = u.getModel("Contact");

// Acceder a los atributos
const attrs = Model.attrs;
const keyRoutes = Model.keyRoutes;

// Obtener un atributo específico
const emailAttr = Model.attrs.email;
console.log(emailAttr.type); // String
console.log(emailAttr.required); // true/false
console.log(emailAttr.displayName); // "Email"
```

### 2. Método User.getUserSchema()

Este es el método principal para obtener schemas con filtrado de permisos:

```javascript
// En un método del modelo User
const modelSchemas = await User.getUserSchema({ user: currentUser });

console.log(modelSchemas);
// {
//   Contact: {
//     firstName: { type: 'String', required: true, displayName: 'First Name', ... },
//     lastName: { type: 'String', displayName: 'Last Name', ... },
//     ...
//   },
//   Deal: { ... },
//   ...
// }
```

### 3. API Endpoint: /v2/service/getSchema

Para consultas específicas de un modelo:

```javascript
// GET /v2/service/getSchema?modelName=Contact&type=attrs

// Respuesta:
{
  firstName: { type: 'String', required: true, ... },
  lastName: { type: 'String', ... },
  ...
}
```

---

## User.getUserSchema() - Método Principal

### Ubicación

**Archivo**: `/app/modules/system/models/User.js` (líneas 280-373)

### Descripción

`getUserSchema()` es el método principal que devuelve los schemas de todos los modelos accesibles para un usuario, basándose en sus permisos RBAC.

### Firma del Método

```javascript
static async getUserSchema(params) {
  const { user } = params;
  // ...
}
```

### Flujo de Ejecución

```
┌─────────────────────────────────────┐
│  User.getUserSchema({ user })       │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  Obtener permisos del usuario       │
│  - Iterar Permission.models         │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  Para cada modelo encontrado:       │
│  1. Verificar permisos @Resource    │
│  2. Verificar no está en excluded   │
│  3. Iterar Model.keyRoutes          │
│  4. Extraer propiedades de attrs    │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  Construir objeto modelSchemas      │
│  con 30+ propiedades por atributo   │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  Retornar modelSchemas filtrado     │
└─────────────────────────────────────┘
```

### Implementación Completa

```javascript
static async getUserSchema(params) {
  const { user } = params;

  // Lista de modelos excluidos por seguridad
  const excludedModels = [
    'Auth',
    'Integration',
    'Oauth',
    'OauthToken',
    'Secret',
    'Templates',
    'MicrofrontendRoute',
    'MicrofrontendMenu',
    'ZendeskRequest',
    'Notifee',
    'Permission',
    'UserDevice',
    'Subscription',
    'MailingList',
    'Datamapper',
    'Workflow',
    'DatamapperTest',
    'UiSchema',
  ];

  const modelSchemas = {};
  const modelsWithFindPermission = [];

  // Iterar todos los modelos con permisos
  for (const modelName of Permission.models) {
    const Model = u.getModel(modelName);
    if (!Model) continue;

    // Verificar si el modelo está excluido
    if (excludedModels.includes(modelName)) continue;

    // Verificar permisos @Resource.find
    const permissionTag = `@${modelName}.find`;
    const hasPermission = await Permission.check({
      user,
      permissionTag,
      skip: ['@Owner'],
    });

    if (!hasPermission) continue;

    // Agregar a la lista de modelos con permiso
    modelsWithFindPermission.push(modelName);

    // Inicializar schema del modelo
    modelSchemas[modelName] = {};

    // Iterar cada ruta de atributos
    for (const key of Model.keyRoutes) {
      const attr = _.get(Model.attrs, key);
      if (!attr) continue;

      // Extraer todas las propiedades del atributo
      modelSchemas[modelName][key] = {
        type: attr.type?.name || attr.type,
        required: attr.required,
        enum: attr.enum,
        ref: attr.ref,
        default: attr.default,
        unique: attr.unique,
        displayName: attr.displayName,
        avoid: attr.avoid,
        hidden: attr.hidden,
        disabled: attr.disabled,
        ext: attr.ext,
        max: attr.max,
        min: attr.min,
        step: attr.step,
        maxBytes: attr.maxBytes,
        isPublic: attr.isPublic,
        maxFiles: attr.maxFiles,
        uiCom: attr.uiCom,
        thetaGallery: attr.thetaGallery,
        dependsOn: attr.dependsOn,
        quickCreate: attr.quickCreate,
        objectShape: attr.objectShape,
        format: attr.format,
        eg: attr.eg,
        description: attr.description,
        thumbnailPreview: attr.thumbnailPreview,
        primaryKey: attr.primaryKey,
        xquery: attr.xquery,
        htmlToolbar: attr.htmlToolbar,
        isCustomField: attr.isCustomField,
        enableMessageTemplate: attr.enableMessageTemplate,
        syntaxLang: attr.syntaxLang,
        filter: attr.filter,
        label: attr.label,
      };
    }
  }

  return {
    modelSchemas,
    modelsWithFindPermission,
  };
}
```

### Propiedades Extraídas

El método extrae más de 30 propiedades de cada atributo:

| Propiedad               | Tipo    | Descripción                                 |
| ----------------------- | ------- | ------------------------------------------- |
| `type`                  | String  | Tipo del campo (String, Number, Date, etc.) |
| `required`              | Boolean | Si el campo es obligatorio                  |
| `enum`                  | Array   | Valores permitidos                          |
| `ref`                   | String  | Referencia a otro modelo                    |
| `default`               | Any     | Valor por defecto                           |
| `unique`                | Boolean | Si el valor debe ser único                  |
| `displayName`           | String  | Nombre para mostrar en UI                   |
| `avoid`                 | Boolean | Evitar en algunas operaciones               |
| `hidden`                | Boolean | Si está oculto en UI                        |
| `disabled`              | Boolean | Si está deshabilitado                       |
| `ext`                   | Array   | Extensiones de archivo permitidas           |
| `max`                   | Number  | Valor máximo                                |
| `min`                   | Number  | Valor mínimo                                |
| `step`                  | Number  | Incremento en inputs numéricos              |
| `maxBytes`              | Number  | Tamaño máximo en bytes                      |
| `isPublic`              | Boolean | Si es público                               |
| `maxFiles`              | Number  | Número máximo de archivos                   |
| `uiCom`                 | String  | Componente UI a usar                        |
| `thetaGallery`          | Boolean | Usar galería Theta                          |
| `dependsOn`             | String  | Campo del que depende                       |
| `quickCreate`           | String  | Permite creación rápida                     |
| `objectShape`           | Object  | Estructura de objeto anidado                |
| `format`                | String  | Formato especial (email, url, etc.)         |
| `eg`                    | String  | Ejemplo de valor                            |
| `description`           | String  | Descripción del campo                       |
| `thumbnailPreview`      | Boolean | Mostrar thumbnail                           |
| `primaryKey`            | Boolean | Si es clave primaria                        |
| `xquery`                | String  | Query especial                              |
| `htmlToolbar`           | String  | Configuración de toolbar HTML               |
| `isCustomField`         | Boolean | Si es custom field                          |
| `enableMessageTemplate` | Boolean | Habilitar templates                         |
| `syntaxLang`            | String  | Lenguaje de sintaxis                        |
| `filter`                | Object  | Filtros aplicables                          |
| `label`                 | String  | Etiqueta alternativa                        |

---

## API Endpoint: GET /v2/user/me

### Descripción

El endpoint `/v2/user/me` retorna el perfil completo del usuario incluyendo los `modelSchemas`.

### Ubicación

**Archivo**: `/app/modules/system/models/User.js` (líneas 440-480)

### Request

```http
GET /v2/user/me HTTP/1.1
Authorization: Bearer {token}
```

### Response

```javascript
{
  "user": {
    "_id": "...",
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    // ... otros campos del usuario
  },
  "modelSchemas": {
    "Contact": {
      "firstName": {
        "type": "String",
        "required": true,
        "displayName": "First Name",
        ...
      },
      "lastName": {
        "type": "String",
        "displayName": "Last Name",
        ...
      },
      ...
    },
    "Deal": { ... },
    "Company": { ... },
    ...
  },
  "uiSchemas": { ... },
  "modelsWithFindPermission": ["Contact", "Deal", "Company", ...]
}
```

### Implementación

```javascript
static async me(params) {
  const { user } = params;

  // Obtener schemas con permisos
  const { modelSchemas, modelsWithFindPermission } = await User.getUserSchema({ user });

  // Obtener UI schemas
  const uiSchemas = await UiSchema.find({
    account: user.account,
    isActive: true,
  }).lean();

  return {
    user,
    modelSchemas,
    uiSchemas,
    modelsWithFindPermission,
  };
}
```

### Uso en Frontend

```javascript
// React/Vue component
async function loadUserAndSchemas() {
  const response = await fetch("/v2/user/me", {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const data = await response.json();

  // Acceder a schemas
  const contactSchema = data.modelSchemas.Contact;
  const firstNameAttr = contactSchema.firstName;

  console.log("Tipo:", firstNameAttr.type);
  console.log("Requerido:", firstNameAttr.required);
  console.log("Display Name:", firstNameAttr.displayName);
}
```

---

## API Endpoint: GET /v2/service/getSchema

### Descripción

Endpoint especializado para obtener el schema de un modelo específico en diferentes formatos.

### Ubicación

- **Route**: `/app/modules/system/routes/ServiceRoute.js` (líneas 71-103)
- **Controller**: `/app/modules/system/controllers/ServiceController.js` (líneas 20-27)
- **Service**: `/app/lib/services/ServiceUtils.js` (líneas 24-135)

### Request

```http
GET /v2/service/getSchema?modelName=Contact&type=attrs HTTP/1.1
Authorization: Bearer {token}
```

### Parámetros

| Parámetro   | Tipo   | Requerido | Valores                      | Descripción              |
| ----------- | ------ | --------- | ---------------------------- | ------------------------ |
| `modelName` | String | Sí        | Cualquier modelo             | Nombre del modelo        |
| `type`      | String | Sí        | `attrs`, `columns`, `arrays` | Tipo de schema a obtener |

### Tipos de Schema

#### 1. type=attrs

Retorna la definición completa de atributos:

```javascript
// GET /v2/service/getSchema?modelName=Contact&type=attrs

{
  "firstName": {
    "type": "String",
    "required": true,
    "displayName": "First Name",
    ...
  },
  "lastName": {
    "type": "String",
    "displayName": "Last Name",
    ...
  },
  "email": {
    "type": "String",
    "unique": true,
    "format": "email",
    ...
  }
}
```

#### 2. type=columns

Retorna solo las rutas de las columnas (keyRoutes):

```javascript
// GET /v2/service/getSchema?modelName=Contact&type=columns

[
  "firstName",
  "lastName",
  "email",
  "phone",
  "address.street",
  "address.city",
  "address.state",
  "address.zip",
  "company.name",
  "tags",
  "createdAt",
  "updatedAt",
];
```

#### 3. type=arrays

Retorna solo los campos de tipo array:

```javascript
// GET /v2/service/getSchema?modelName=Deal&type=arrays

["proposal.quote.lineItems", "tags", "attachments", "activities"];
```

### Implementación Completa

```javascript
// ServiceUtils.js
getSchema(params) {
  const { modelName, type } = params;

  // Validaciones
  Validator.required({ modelName, type });
  Validator.enum({ type }, ['attrs', 'columns', 'arrays']);

  // Obtener el modelo
  const Model = u.getModel(modelName);
  if (!Model) {
    throw new Err('Not found.', modelName);
  }

  // Verificar que tenga controller (seguridad)
  const hasController = u.getController(modelName);
  if (!hasController) {
    throw new Err('Forbidden. The schema is not accessible.', modelName);
  }

  let output;

  // Retornar según tipo
  if (type === 'attrs') {
    output = _.cloneDeep(Model.attrs);
  }

  if (type === 'columns') {
    output = _.cloneDeep(Model.keyRoutes);
  }

  if (type === 'arrays') {
    output = Model.keyRoutes.filter((route) => {
      const attr = _.get(Model.attrs, route);
      if (!attr) return false;
      return attr.type === Array ||
             Array.isArray(attr.type) ||
             attr.type === 'Array';
    });
  }

  // Casos especiales (Deal, Quote, LineItem)
  if (modelName === 'Deal') {
    // Agregar rutas de Quote
    Quote.keyRoutes.forEach((route) => {
      output.push(`proposal.quote.${route}`);
    });

    // Agregar rutas de LineItem
    LineItem.keyRoutes.forEach((route) => {
      output.push(`proposal.quote.lineItems.${route}`);
    });

    // Filtrar rutas no deseadas
    output = output.filter((item) =>
      !item.startsWith('proposal.template.')
    );
  }

  // Agregar virtual routes
  const virtualRoutes = Report.enums.virtualRoutes[modelName];
  if (virtualRoutes && virtualRoutes.length) {
    virtualRoutes.forEach((route) => {
      output.push(route);
    });
  }

  // Ordenar alfabéticamente
  output = output.sort();

  return output;
}
```

### Uso en Backend

```javascript
// En un controller o service
async function getContactSchema() {
  const schema = await Service.getSchema({
    modelName: "Contact",
    type: "attrs",
  });

  console.log("Schema completo:", schema);

  // Acceder a un atributo específico
  console.log("Email attr:", schema.email);
  console.log("Es required?", schema.email.required);
}
```

### Seguridad

El endpoint verifica:

1. **Modelo existe**: El modelo debe estar registrado
2. **Tiene controller**: Solo modelos con controller son accesibles
3. **No está en excludedModels**: Modelos sensibles están bloqueados

```javascript
const excludedModels = [
  'Auth', 'Integration', 'Oauth', 'OauthToken',
  'Secret', 'Templates', 'Permission', ...
];
```

---

## Estructura de Atributos

### Definición en Model.attrs

Los atributos se definen en el schema de Mongoose con propiedades extendidas:

```javascript
// Ejemplo: Contact.js schema
const contactSchema = new Schema({
  firstName: {
    type: String,
    required: true,
    displayName: "First Name",
    uiCom: "input",
    primaryKey: true,
  },

  email: {
    type: String,
    unique: true,
    format: "email",
    displayName: "Email",
    required: true,
    uiCom: "input",
  },

  phone: {
    type: String,
    displayName: "Phone",
    format: "phone",
    uiCom: "phoneInput",
  },

  status: {
    type: String,
    enum: ["active", "inactive", "pending"],
    default: "pending",
    displayName: "Status",
    uiCom: "select",
  },

  company: {
    type: Schema.Types.ObjectId,
    ref: "Company",
    displayName: "Company",
    uiCom: "reference",
  },

  tags: {
    type: [String],
    displayName: "Tags",
    uiCom: "tags",
  },

  profilePicture: {
    type: Schema.Types.ObjectId,
    ref: "File",
    displayName: "Profile Picture",
    uiCom: "image",
    maxFiles: 1,
    ext: ["jpg", "png", "gif"],
    maxBytes: 5242880, // 5MB
  },

  address: {
    street: {
      type: String,
      displayName: "Street",
    },
    city: {
      type: String,
      displayName: "City",
    },
    state: {
      type: String,
      displayName: "State",
    },
    zip: {
      type: String,
      displayName: "ZIP Code",
    },
  },
});
```

### Acceso a Campos Anidados

```javascript
// Acceder a campos anidados
const Model = u.getModel("Contact");

// Campo anidado
const cityAttr = _.get(Model.attrs, "address.city");
console.log(cityAttr.displayName); // "City"

// Verificar ruta existe
const routes = Model.keyRoutes;
console.log(routes.includes("address.city")); // true
console.log(routes.includes("address.street")); // true
```

---

## Propiedades de los Atributos

### Propiedades Principales

#### type

Define el tipo de datos del campo:

```javascript
{
  type: String; // 'String'
  type: Number; // 'Number'
  type: Date; // 'Date'
  type: Boolean; // 'Boolean'
  type: Schema.Types.ObjectId; // 'ObjectId'
  type: [String]; // Array de strings
  type: Object; // 'Object'
  type: Schema.Types.Mixed; // 'Mixed'
}
```

#### required

Indica si el campo es obligatorio:

```javascript
{
  required: true,
  required: false,
  required: [true, 'Custom error message']
}
```

#### enum

Lista de valores permitidos:

```javascript
{
  enum: ['active', 'inactive', 'pending'],
  enum: ['admin', 'user', 'guest']
}
```

#### ref

Referencia a otro modelo (para relaciones):

```javascript
{
  ref: 'Company',
  ref: 'User',
  ref: 'File'
}
```

#### default

Valor por defecto:

```javascript
{
  default: 'pending',
  default: 0,
  default: Date.now,
  default: () => new Date()
}
```

#### unique

Indica si el valor debe ser único en la colección:

```javascript
{
  unique: true,
  unique: false
}
```

### Propiedades de UI

#### displayName

Nombre para mostrar en interfaces de usuario:

```javascript
{
  displayName: 'First Name',
  displayName: 'Email Address',
  displayName: 'Phone Number'
}
```

#### uiCom

Componente de UI a utilizar:

```javascript
{
  uiCom: 'input',           // Input de texto
  uiCom: 'textarea',        // Área de texto
  uiCom: 'select',          // Select dropdown
  uiCom: 'checkbox',        // Checkbox
  uiCom: 'radio',           // Radio buttons
  uiCom: 'date',            // Date picker
  uiCom: 'datetime',        // Date time picker
  uiCom: 'time',            // Time picker
  uiCom: 'image',           // Image uploader
  uiCom: 'file',            // File uploader
  uiCom: 'reference',       // Reference picker
  uiCom: 'tags',            // Tags input
  uiCom: 'phoneInput',      // Phone input
  uiCom: 'email',           // Email input
  uiCom: 'url',             // URL input
  uiCom: 'richText',        // Rich text editor
  uiCom: 'markdown',        // Markdown editor
  uiCom: 'code',            // Code editor
}
```

#### hidden

Si el campo debe estar oculto en UI:

```javascript
{
  hidden: true,
  hidden: false
}
```

#### disabled

Si el campo debe estar deshabilitado:

```javascript
{
  disabled: true,
  disabled: false
}
```

#### dependsOn

Campo del que depende (para campos condicionales):

```javascript
{
  dependsOn: 'status',
  dependsOn: 'type'
}
```

### Propiedades de Validación

#### max / min

Valores máximo y mínimo para números:

```javascript
{
  max: 100,
  min: 0,
  max: 999999,
  min: 1
}
```

#### maxBytes

Tamaño máximo en bytes para archivos:

```javascript
{
  maxBytes: 5242880,  // 5MB
  maxBytes: 10485760  // 10MB
}
```

#### maxFiles

Número máximo de archivos permitidos:

```javascript
{
  maxFiles: 1,
  maxFiles: 10
}
```

#### ext

Extensiones de archivo permitidas:

```javascript
{
  ext: ['jpg', 'png', 'gif'],
  ext: ['pdf', 'doc', 'docx'],
  ext: ['xlsx', 'csv']
}
```

#### format

Formato esperado del valor:

```javascript
{
  format: 'email',
  format: 'phone',
  format: 'url',
  format: 'date',
  format: 'time',
  format: 'datetime'
}
```

### Propiedades Especiales

#### isCustomField

Indica si es un custom field:

```javascript
{
  isCustomField: true,
  isCustomField: false
}
```

#### primaryKey

Si es la clave primaria para mostrar:

```javascript
{
  primaryKey: true;
}
```

#### isPublic

Si el campo es público (accesible sin autenticación):

```javascript
{
  isPublic: true,
  isPublic: false
}
```

#### filter

Filtros aplicables en queries:

```javascript
{
  filter: {
    type: 'select',
    options: ['option1', 'option2']
  }
}
```

---

## Filtrado Basado en Permisos

### Sistema de Permisos RBAC

El acceso a schemas está controlado por el sistema RBAC (Role-Based Access Control):

```
┌─────────────────────────────────────────┐
│  Usuario solicita schemas               │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│  Verificar permisos del usuario         │
│  - Obtener roles                        │
│  - Obtener permisos asociados           │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│  Para cada modelo:                      │
│  - Verificar @{Model}.find              │
│  - Si no tiene permiso, excluir modelo  │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│  Retornar solo modelos permitidos       │
└─────────────────────────────────────────┘
```

### Tags de Permiso

Los permisos se verifican usando tags:

```javascript
const permissionTag = `@${modelName}.find`;
// Ejemplos:
// @Contact.find
// @Deal.find
// @Company.find
```

### Modelos Excluidos

Algunos modelos están excluidos por seguridad:

```javascript
const excludedModels = [
  "Auth", // Configuración de autenticación
  "Integration", // Integraciones externas
  "Oauth", // Configuración OAuth
  "OauthToken", // Tokens OAuth
  "Secret", // Secretos y credenciales
  "Templates", // Templates internos
  "Permission", // Sistema de permisos
  "UserDevice", // Dispositivos del usuario
  "Subscription", // Suscripciones
  "MicrofrontendRoute", // Rutas de microfrontends
  "MicrofrontendMenu", // Menús de microfrontends
  "ZendeskRequest", // Requests de Zendesk
  "Notifee", // Configuración de notificaciones
  "MailingList", // Listas de correo
  "Datamapper", // Configuración de datamapper
  "Workflow", // Workflows internos
  "DatamapperTest", // Tests de datamapper
  "UiSchema", // Schemas de UI
];
```

### Verificación de Permisos

```javascript
// Verificar permiso para un modelo específico
const permissionTag = `@Contact.find`;
const hasPermission = await Permission.check({
  user: currentUser,
  permissionTag,
  skip: ["@Owner"], // Skip owner check
});

if (hasPermission) {
  // Usuario puede acceder al schema de Contact
  console.log("Permiso concedido");
} else {
  // Usuario no puede acceder
  console.log("Permiso denegado");
}
```

### Ejemplo Completo de Filtrado

```javascript
async function getUserAccessibleSchemas(user) {
  const accessibleSchemas = {};
  const allModels = Object.keys(skem.models);

  for (const modelName of allModels) {
    // Verificar si está excluido
    if (excludedModels.includes(modelName)) {
      continue;
    }

    // Verificar permisos
    const permissionTag = `@${modelName}.find`;
    const hasPermission = await Permission.check({
      user,
      permissionTag,
      skip: ["@Owner"],
    });

    if (!hasPermission) {
      continue;
    }

    // Usuario tiene acceso, agregar schema
    const Model = u.getModel(modelName);
    accessibleSchemas[modelName] = Model.attrs;
  }

  return accessibleSchemas;
}
```

---

## Ejemplos de Uso

### Ejemplo 1: Generar Formulario Dinámico

```javascript
// Frontend: Generar formulario basado en schema

async function generateForm(modelName) {
  // Obtener schema del modelo
  const response = await fetch(
    `/v2/service/getSchema?modelName=${modelName}&type=attrs`,
  );
  const schema = await response.json();

  const formHTML = [];

  // Iterar cada atributo
  for (const [fieldName, attr] of Object.entries(schema)) {
    // Saltar campos ocultos
    if (attr.hidden) continue;

    // Generar input según tipo
    let inputHTML = "";

    if (attr.enum && attr.uiCom === "select") {
      // Select dropdown
      inputHTML = `
        <label>${attr.displayName || fieldName}${
        attr.required ? " *" : ""
      }</label>
        <select name="${fieldName}" ${attr.required ? "required" : ""} ${
        attr.disabled ? "disabled" : ""
      }>
          <option value="">Select...</option>
          ${attr.enum
            .map((val) => `<option value="${val}">${val}</option>`)
            .join("")}
        </select>
      `;
    } else if (attr.type === "Boolean" || attr.uiCom === "checkbox") {
      // Checkbox
      inputHTML = `
        <label>
          <input type="checkbox" name="${fieldName}" ${
        attr.disabled ? "disabled" : ""
      }>
          ${attr.displayName || fieldName}
        </label>
      `;
    } else if (attr.uiCom === "textarea") {
      // Textarea
      inputHTML = `
        <label>${attr.displayName || fieldName}${
        attr.required ? " *" : ""
      }</label>
        <textarea 
          name="${fieldName}" 
          ${attr.required ? "required" : ""} 
          ${attr.disabled ? "disabled" : ""}
          placeholder="${attr.eg || ""}"
        ></textarea>
      `;
    } else if (attr.type === "Date" || attr.uiCom === "date") {
      // Date picker
      inputHTML = `
        <label>${attr.displayName || fieldName}${
        attr.required ? " *" : ""
      }</label>
        <input 
          type="date" 
          name="${fieldName}" 
          ${attr.required ? "required" : ""} 
          ${attr.disabled ? "disabled" : ""}
        >
      `;
    } else {
      // Input de texto por defecto
      inputHTML = `
        <label>${attr.displayName || fieldName}${
        attr.required ? " *" : ""
      }</label>
        <input 
          type="${
            attr.format === "email"
              ? "email"
              : attr.format === "url"
              ? "url"
              : "text"
          }" 
          name="${fieldName}" 
          ${attr.required ? "required" : ""} 
          ${attr.disabled ? "disabled" : ""}
          ${attr.max ? `max="${attr.max}"` : ""}
          ${attr.min ? `min="${attr.min}"` : ""}
          placeholder="${attr.eg || ""}"
        >
      `;
    }

    formHTML.push(`<div class="form-group">${inputHTML}</div>`);
  }

  return `<form>${formHTML.join("")}</form>`;
}

// Uso
const contactForm = await generateForm("Contact");
document.getElementById("formContainer").innerHTML = contactForm;
```

### Ejemplo 2: Validación Dinámica

```javascript
// Backend: Validar datos según schema

async function validateData(modelName, data) {
  const Model = u.getModel(modelName);
  const errors = [];

  // Iterar cada campo en los datos
  for (const [fieldName, value] of Object.entries(data)) {
    const attr = _.get(Model.attrs, fieldName);

    if (!attr) {
      errors.push(`Field ${fieldName} does not exist in model ${modelName}`);
      continue;
    }

    // Validar required
    if (attr.required && !value) {
      errors.push(`Field ${fieldName} is required`);
    }

    // Validar enum
    if (attr.enum && value && !attr.enum.includes(value)) {
      errors.push(`Field ${fieldName} must be one of: ${attr.enum.join(", ")}`);
    }

    // Validar type
    const expectedType = attr.type?.name || attr.type;
    const actualType = typeof value;

    if (expectedType === "String" && actualType !== "string") {
      errors.push(`Field ${fieldName} must be a string`);
    }

    if (expectedType === "Number" && actualType !== "number") {
      errors.push(`Field ${fieldName} must be a number`);
    }

    // Validar max/min para números
    if (expectedType === "Number" && typeof value === "number") {
      if (attr.max !== undefined && value > attr.max) {
        errors.push(`Field ${fieldName} must be <= ${attr.max}`);
      }
      if (attr.min !== undefined && value < attr.min) {
        errors.push(`Field ${fieldName} must be >= ${attr.min}`);
      }
    }

    // Validar unique (requiere query a DB)
    if (attr.unique && value) {
      const exists = await Model.findOne({ [fieldName]: value });
      if (exists) {
        errors.push(`Value ${value} for field ${fieldName} already exists`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// Uso
const result = await validateData("Contact", {
  firstName: "John",
  lastName: "Doe",
  email: "john@example.com",
  status: "invalid-status", // Error: no está en enum
});

console.log(result);
// {
//   valid: false,
//   errors: ['Field status must be one of: active, inactive, pending']
// }
```

### Ejemplo 3: Exportar Schema a Swagger/OpenAPI

```javascript
// Generar definición OpenAPI desde schema

function schemaToOpenAPI(modelName) {
  const Model = u.getModel(modelName);
  const openAPISchema = {
    type: "object",
    properties: {},
    required: [],
  };

  // Iterar atributos
  for (const [fieldName, attr] of Object.entries(Model.attrs)) {
    // Mapear tipo Mongoose a OpenAPI
    let openAPIType = "string";
    let format;

    const mongooseType = attr.type?.name || attr.type;

    switch (mongooseType) {
      case "String":
        openAPIType = "string";
        if (attr.format === "email") format = "email";
        if (attr.format === "url") format = "uri";
        if (attr.format === "date") format = "date";
        if (attr.format === "datetime") format = "date-time";
        break;
      case "Number":
        openAPIType = attr.step && attr.step % 1 !== 0 ? "number" : "integer";
        break;
      case "Boolean":
        openAPIType = "boolean";
        break;
      case "Date":
        openAPIType = "string";
        format = "date-time";
        break;
      case "ObjectId":
        openAPIType = "string";
        format = "objectid";
        break;
      case "Array":
        openAPIType = "array";
        break;
      case "Object":
        openAPIType = "object";
        break;
    }

    const propertyDef = {
      type: openAPIType,
    };

    if (format) {
      propertyDef.format = format;
    }

    if (attr.description) {
      propertyDef.description = attr.description;
    }

    if (attr.enum) {
      propertyDef.enum = attr.enum;
    }

    if (attr.default !== undefined) {
      propertyDef.default = attr.default;
    }

    if (attr.min !== undefined) {
      propertyDef.minimum = attr.min;
    }

    if (attr.max !== undefined) {
      propertyDef.maximum = attr.max;
    }

    if (attr.eg) {
      propertyDef.example = attr.eg;
    }

    openAPISchema.properties[fieldName] = propertyDef;

    // Agregar a required si corresponde
    if (attr.required) {
      openAPISchema.required.push(fieldName);
    }
  }

  return openAPISchema;
}

// Uso
const contactOpenAPI = schemaToOpenAPI("Contact");
console.log(JSON.stringify(contactOpenAPI, null, 2));

// Output:
// {
//   "type": "object",
//   "properties": {
//     "firstName": {
//       "type": "string",
//       "description": "Contact's first name"
//     },
//     "email": {
//       "type": "string",
//       "format": "email"
//     },
//     "status": {
//       "type": "string",
//       "enum": ["active", "inactive", "pending"],
//       "default": "pending"
//     }
//   },
//   "required": ["firstName", "email"]
// }
```

### Ejemplo 4: Crear Tabla Dinámica

```javascript
// React component: Crear tabla con columnas dinámicas

import React, { useEffect, useState } from "react";

function DynamicTable({ modelName }) {
  const [schema, setSchema] = useState(null);
  const [columns, setColumns] = useState([]);
  const [data, setData] = useState([]);

  useEffect(() => {
    loadSchemaAndData();
  }, [modelName]);

  async function loadSchemaAndData() {
    // Cargar schema
    const schemaRes = await fetch(
      `/v2/service/getSchema?modelName=${modelName}&type=attrs`,
    );
    const schemaData = await schemaRes.json();
    setSchema(schemaData);

    // Generar columnas visibles
    const visibleColumns = Object.entries(schemaData)
      .filter(([key, attr]) => !attr.hidden && !attr.avoid)
      .map(([key, attr]) => ({
        key,
        label: attr.displayName || key,
        type: attr.type,
        format: attr.format,
      }));
    setColumns(visibleColumns);

    // Cargar datos
    const dataRes = await fetch(`/v2/${modelName.toLowerCase()}?limit=50`);
    const dataJson = await dataRes.json();
    setData(dataJson.docs || []);
  }

  function renderCell(value, column) {
    if (!value) return "-";

    // Formatear según tipo
    if (column.type === "Date") {
      return new Date(value).toLocaleDateString();
    }

    if (column.type === "Boolean") {
      return value ? "✓" : "✗";
    }

    if (column.format === "email") {
      return <a href={`mailto:${value}`}>{value}</a>;
    }

    if (column.format === "url") {
      return (
        <a href={value} target="_blank">
          {value}
        </a>
      );
    }

    if (Array.isArray(value)) {
      return value.join(", ");
    }

    return String(value);
  }

  if (!schema) {
    return <div>Loading...</div>;
  }

  return (
    <table className="dynamic-table">
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key}>{col.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((row) => (
          <tr key={row._id}>
            {columns.map((col) => (
              <td key={col.key}>{renderCell(row[col.key], col)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default DynamicTable;

// Uso
<DynamicTable modelName="Contact" />;
```

### Ejemplo 5: Búsqueda con Filtros Dinámicos

```javascript
// Generar filtros de búsqueda basados en schema

async function generateSearchFilters(modelName) {
  const response = await fetch(
    `/v2/service/getSchema?modelName=${modelName}&type=attrs`,
  );
  const schema = await response.json();

  const filters = [];

  for (const [fieldName, attr] of Object.entries(schema)) {
    // Solo campos con filter habilitado
    if (!attr.filter || attr.hidden) continue;

    const filter = {
      field: fieldName,
      label: attr.displayName || fieldName,
      type: attr.type,
    };

    // Agregar opciones para enum
    if (attr.enum) {
      filter.filterType = "select";
      filter.options = attr.enum.map((val) => ({
        label: val,
        value: val,
      }));
    } else if (attr.type === "Boolean") {
      filter.filterType = "checkbox";
    } else if (attr.type === "Date") {
      filter.filterType = "dateRange";
    } else if (attr.type === "Number") {
      filter.filterType = "numberRange";
      filter.min = attr.min;
      filter.max = attr.max;
    } else {
      filter.filterType = "text";
    }

    filters.push(filter);
  }

  return filters;
}

// Uso en React
function SearchFilters({ modelName, onFilterChange }) {
  const [filters, setFilters] = useState([]);
  const [values, setValues] = useState({});

  useEffect(() => {
    generateSearchFilters(modelName).then(setFilters);
  }, [modelName]);

  function handleChange(field, value) {
    const newValues = { ...values, [field]: value };
    setValues(newValues);
    onFilterChange(newValues);
  }

  return (
    <div className="search-filters">
      {filters.map((filter) => (
        <div key={filter.field} className="filter-group">
          <label>{filter.label}</label>

          {filter.filterType === "select" && (
            <select
              value={values[filter.field] || ""}
              onChange={(e) => handleChange(filter.field, e.target.value)}
            >
              <option value="">All</option>
              {filter.options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          )}

          {filter.filterType === "text" && (
            <input
              type="text"
              value={values[filter.field] || ""}
              onChange={(e) => handleChange(filter.field, e.target.value)}
              placeholder={`Search by ${filter.label.toLowerCase()}...`}
            />
          )}

          {filter.filterType === "checkbox" && (
            <input
              type="checkbox"
              checked={values[filter.field] || false}
              onChange={(e) => handleChange(filter.field, e.target.checked)}
            />
          )}

          {filter.filterType === "dateRange" && (
            <div>
              <input
                type="date"
                value={values[`${filter.field}_from`] || ""}
                onChange={(e) =>
                  handleChange(`${filter.field}_from`, e.target.value)
                }
                placeholder="From"
              />
              <input
                type="date"
                value={values[`${filter.field}_to`] || ""}
                onChange={(e) =>
                  handleChange(`${filter.field}_to`, e.target.value)
                }
                placeholder="To"
              />
            </div>
          )}

          {filter.filterType === "numberRange" && (
            <div>
              <input
                type="number"
                min={filter.min}
                max={filter.max}
                value={values[`${filter.field}_min`] || ""}
                onChange={(e) =>
                  handleChange(`${filter.field}_min`, e.target.value)
                }
                placeholder="Min"
              />
              <input
                type="number"
                min={filter.min}
                max={filter.max}
                value={values[`${filter.field}_max`] || ""}
                onChange={(e) =>
                  handleChange(`${filter.field}_max`, e.target.value)
                }
                placeholder="Max"
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

---

## Casos de Uso Especiales

### Caso 1: Modelos con Schemas Complejos (Deal)

El modelo `Deal` tiene un schema especial que incluye campos de `Quote` y `LineItem`:

```javascript
// GET /v2/service/getSchema?modelName=Deal&type=columns

[
  // Campos propios de Deal
  "title",
  "status",
  "amount",

  // Campos de Quote embebido
  "proposal.quote.total",
  "proposal.quote.subtotal",
  "proposal.quote.tax",
  "proposal.quote.discount",

  // Campos de LineItems (array)
  "proposal.quote.lineItems.name",
  "proposal.quote.lineItems.quantity",
  "proposal.quote.lineItems.price",
  "proposal.quote.lineItems.total",

  // Excluye template por ser muy pesado
  // "proposal.template.*" está filtrado
];
```

### Caso 2: Custom Fields Dinámicos

Los custom fields se incluyen automáticamente en el schema:

```javascript
// Schema con custom fields
{
  // Campos estándar
  "firstName": {
    "type": "String",
    "required": true,
    "displayName": "First Name"
  },

  // Custom field
  "customFields.favoriteFood": {
    "type": "String",
    "displayName": "Favorite Food",
    "isCustomField": true,
    "uiCom": "input"
  },

  // Otro custom field
  "customFields.loyaltyPoints": {
    "type": "Number",
    "displayName": "Loyalty Points",
    "isCustomField": true,
    "min": 0,
    "max": 10000
  }
}
```

### Caso 3: Virtual Routes para Reportes

Algunos modelos tienen virtual routes adicionales para reportes:

```javascript
// Report.enums.virtualRoutes
{
  Contact: [
    'fullName',               // computed field
    'company.name',           // populated field
    'deals.total',            // aggregate
    'lastActivity.date',      // related data
  ],
  Deal: [
    'assignee.fullName',
    'contact.fullName',
    'daysInPipeline',         // computed
    'lastContact.date',
  ]
}

// Estos se agregan automáticamente al schema
```

### Caso 4: Schemas para Importación/Exportación

Obtener schema optimizado para import/export:

```javascript
async function getImportSchema(modelName) {
  // Obtener schema completo
  const response = await fetch(
    `/v2/service/getSchema?modelName=${modelName}&type=attrs`,
  );
  const fullSchema = await response.json();

  // Filtrar solo campos importables
  const importableFields = {};

  for (const [key, attr] of Object.entries(fullSchema)) {
    // Excluir campos automáticos
    if (key === "_id" || key === "createdAt" || key === "updatedAt") {
      continue;
    }

    // Excluir campos avoid
    if (attr.avoid || attr.disabled) {
      continue;
    }

    // Excluir referencias complejas
    if (attr.ref && !attr.quickCreate) {
      continue;
    }

    importableFields[key] = {
      label: attr.displayName || key,
      type: attr.type,
      required: attr.required,
      enum: attr.enum,
      format: attr.format,
      example: attr.eg,
    };
  }

  return importableFields;
}

// Uso para generar plantilla de import
const importSchema = await getImportSchema("Contact");

// Generar CSV headers
const csvHeaders = Object.entries(importSchema)
  .map(([key, def]) => def.label)
  .join(",");

console.log(csvHeaders);
// "First Name,Last Name,Email,Phone,Status"
```

### Caso 5: Schemas Multi-idioma

Acceder a displayNames en diferentes idiomas:

```javascript
// Los schemas pueden tener traducciones
async function getLocalizedSchema(modelName, locale = "en") {
  const response = await fetch(
    `/v2/service/getSchema?modelName=${modelName}&type=attrs`,
  );
  const schema = await response.json();

  // Cargar traducciones
  const translations = await fetch(`/locales/${locale}.json`);
  const i18n = await translations.json();

  // Aplicar traducciones
  const localizedSchema = {};

  for (const [key, attr] of Object.entries(schema)) {
    localizedSchema[key] = {
      ...attr,
      displayName: i18n[`${modelName}.${key}`] || attr.displayName || key,
      description: i18n[`${modelName}.${key}.description`] || attr.description,
    };
  }

  return localizedSchema;
}

// Uso
const schemaES = await getLocalizedSchema("Contact", "es");
console.log(schemaES.firstName.displayName); // "Nombre"

const schemaEN = await getLocalizedSchema("Contact", "en");
console.log(schemaEN.firstName.displayName); // "First Name"
```

---

## Referencias Adicionales

### Archivos Relacionados

| Archivo                                                | Descripción                           |
| ------------------------------------------------------ | ------------------------------------- |
| `/app/modules/system/models/User.js`                   | Contiene `getUserSchema()` y `me()`   |
| `/app/modules/system/controllers/ServiceController.js` | Controller del endpoint getSchema     |
| `/app/lib/services/ServiceUtils.js`                    | Implementación de Service.getSchema() |
| `/app/modules/system/routes/ServiceRoute.js`           | Definición de rutas de Service        |
| `/app/lib/Core.js`                                     | Carga y procesamiento de modelos      |
| `/app/modules/system/models/Permission.js`             | Sistema de permisos RBAC              |
| `/app/modules/system/models/CustomField.js`            | Gestión de custom fields              |
| `/app/modules/system/models/Cob.js`                    | Custom Objects con getSchemaAttrs()   |
| `/app/modules/system/models/UiSchema.js`               | Schemas de UI personalizados          |

### Utilidades Relacionadas

```javascript
// Utils2.js - Validación y conversión de schemas
u2.validateSchema(schema, data);
u2.convertSchemaTypes(schema);
u2.getSchemaDefaults(schema);

// Core.js - Acceso a modelos
u.getModel(modelName);
u.getController(modelName);

// Permission.js - Verificación de permisos
Permission.check({ user, permissionTag });
Permission.models; // Array de modelos con permisos

// Validator.js - Validaciones
Validator.required({ field });
Validator.enum({ field }, allowedValues);
```

### Endpoints API Relacionados

| Endpoint                | Método | Descripción                        |
| ----------------------- | ------ | ---------------------------------- |
| `/v2/user/me`           | GET    | Perfil de usuario con modelSchemas |
| `/v2/service/getSchema` | GET    | Schema específico de un modelo     |
| `/v2/uischema`          | GET    | UI Schemas personalizados          |
| `/v2/customfield`       | GET    | Custom fields definidos            |
| `/v2/cob`               | GET    | Custom objects (COBs)              |

### Documentos Relacionados

- [Custom Fields y Custom Objects](./custom-fields-y-custom-objects.md) - Documentación sobre campos y objetos personalizados
- API Documentation (Swagger/OpenAPI) - `/openapi` endpoint
- Permission System Documentation - Sistema RBAC

---

## Resumen

### Puntos Clave

1. **Model.attrs** contiene la definición completa de atributos de cada modelo
2. **Model.keyRoutes** contiene las rutas de acceso a todos los campos incluyendo anidados
3. **User.getUserSchema()** es el método principal para obtener schemas con filtrado de permisos
4. **GET /v2/user/me** devuelve schemas para todos los modelos accesibles al usuario
5. **GET /v2/service/getSchema** permite consultar schemas específicos de un modelo
6. Los schemas incluyen 30+ propiedades por atributo (type, required, displayName, etc.)
7. El acceso está controlado por el sistema RBAC basado en permisos `@{Model}.find`
8. Algunos modelos están excluidos por seguridad (Auth, Secret, Permission, etc.)
9. Los schemas se usan para:
   - Validación de datos
   - Generación de formularios dinámicos
   - Documentación automática de APIs
   - Control de permisos
   - Importación/exportación de datos

### Flujo Recomendado para Acceder a Schemas

```
Frontend necesita schema
        │
        ▼
¿Necesita todos los modelos?
        │
    ┌───┴───┐
   Sí       No
    │        │
    ▼        ▼
GET /v2/   GET /v2/service/getSchema
user/me    ?modelName=X&type=attrs
    │        │
    └───┬────┘
        ▼
  Cachear schemas
        │
        ▼
  Usar en aplicación
```

---

**Fin del documento**

_Para más información sobre custom fields y custom objects, consultar el documento [custom-fields-y-custom-objects.md](./custom-fields-y-custom-objects.md)_
