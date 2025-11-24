# AI Agent Context for Prolibu CLI

This document provides complete context for an AI agent to effectively work on developing sites and scripts for the Prolibu v2 platform.

## 🎯 Purpose

When working with this project, **read this document first** to get all necessary context about:
- How to consume the Prolibu v2 API
- Authentication and access patterns
- CRUD operations with any model
- Development best practices
- UI/UX standards
- Search and filter patterns

---

## 🔐 Authentication

### API Key Storage in Sites
The API Key is stored in the browser's **localStorage** with the key `"apiKey"`:

```javascript
// Save (WITHOUT Bearer prefix)
localStorage.setItem('apiKey', 'xxx-xxx-xxx');

// Get
const apiKey = localStorage.getItem('apiKey');

// Delete (logout)
localStorage.removeItem('apiKey');
```

**⚠️ IMPORTANT:** The apiKey is stored **WITHOUT** the `Bearer` prefix. Add it only when making requests.

### User Info Storage
After validating the apiKey with `/v2/user/me`, store the user info in localStorage:

```javascript
// Save user info
const user = await getUserInfo();
localStorage.setItem('me', JSON.stringify(user));

// Get user info
const me = JSON.parse(localStorage.getItem('me'));
```

### Authentication Flow

#### 1. For Prolibu domains (*.prolibu.com)
Redirect to official auth:
```javascript
const currentDomain = window.location.hostname;
const isProlibuDomain = currentDomain.endsWith('.prolibu.com');

if (isProlibuDomain && !localStorage.getItem('apiKey')) {
    const siteUrl = window.location.href;
    window.location.href = `https://${DOMAIN}/v2/auth/signin?redirect=${encodeURIComponent(siteUrl)}`;
}
```

#### 2. For localhost or other domains
Show local login form:

```javascript
// POST /v2/auth/signin
const response = await fetch(`https://${DOMAIN}/v2/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
        email: 'user@example.com',
        password: 'password123'
    })
});

const data = await response.json();
// Save apiKey WITHOUT Bearer prefix
const apiKey = data.token || data.apiKey;
localStorage.setItem('apiKey', apiKey);
```

#### 3. API Key Validation
Always validate apiKey on load:

```javascript
const apiKey = localStorage.getItem('apiKey');
if (!apiKey) {
    // Show login
    return;
}

// Validate with /v2/user/me
const response = await fetch(`https://${DOMAIN}/v2/user/me`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }  // Add Bearer here
});

if (!response.ok) {
    // Invalid apiKey - clear and show login
    localStorage.removeItem('apiKey');
    localStorage.removeItem('me');
    showLoginForm();
    return;
}

const user = await response.json();
// Save user info
localStorage.setItem('me', JSON.stringify(user));
// Continue with app
```

---

## 📡 Prolibu v2 API

### Base URL
```
https://{domain}/v2
```

Examples:
- `https://dev10.prolibu.com/v2`
- `https://suite.prolibu.com/v2`

### OpenAPI Specification (Optional)
**NOT necessary** to fetch OpenAPI on frontend. Use it only if you need to validate complex schemas:

```javascript
const response = await fetch(`https://${DOMAIN}/v2/openapi/specification/`);
const openapi = await response.json();
```

### Main Endpoints

#### GET /v2/user/me
Get authenticated user information:

```javascript
const apiKey = localStorage.getItem('apiKey');
const response = await fetch(`https://${DOMAIN}/v2/user/me`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }  // Add Bearer prefix
});

const user = await response.json();
// Save to localStorage
localStorage.setItem('me', JSON.stringify(user));
```

**Response:**
```json
{
  "id": "user-id",
  "email": "user@example.com",
  "name": "User Name",
  "role": "admin",
  "schemas": [
    {
      "name": "Contact",
      "fields": [...]
    },
    {
      "name": "Deal",
      "fields": [...]
    }
  ]
}
```

**⚠️ Important:** Available schemas **depend on user role**.

#### GET /v2/{Model}
List records of any model (Contact, Deal, Task, etc.):

```javascript
const apiKey = localStorage.getItem('apiKey');

// Without pagination
const response = await fetch(`https://${DOMAIN}/v2/{Model}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
});

// With pagination (recommended)
const limit = 40;
const offset = 0;
const response = await fetch(`https://${DOMAIN}/v2/{Model}?limit=${limit}&offset=${offset}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
});

const data = await response.json();
```

**Response with pagination:**
```json
{
  "results": [...], // Array of records
  "total": 150      // Total records count
}
```

#### POST /v2/{Model}
Create a new record:

```javascript
const apiKey = localStorage.getItem('apiKey');
const response = await fetch(`https://${DOMAIN}/v2/{Model}`, {
    method: 'POST',
    headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        // Model-specific fields
        field1: 'value1',
        field2: 'value2'
    })
});

if (!response.ok) throw new Error(`Error ${response.status}`);
const newRecord = await response.json();
```

#### PATCH /v2/{Model}/{id}
Update existing record (partial update):

```javascript
const apiKey = localStorage.getItem('apiKey');
const response = await fetch(`https://${DOMAIN}/v2/{Model}/${recordId}`, {
    method: 'PATCH',
    headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        // Only fields to update
        field1: 'newValue'
    })
});

if (!response.ok) throw new Error(`Error ${response.status}`);
const updatedRecord = await response.json();
```

**⚠️ Important:** Use `PATCH` for partial updates, not `PUT`.

#### DELETE /v2/{Model}/{id}
Delete a record:

```javascript
const apiKey = localStorage.getItem('apiKey');
const response = await fetch(`https://${DOMAIN}/v2/{Model}/${recordId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${apiKey}` }
});

if (!response.ok) throw new Error(`Error ${response.status}`);
```

#### GET /v2/{Model}/search
Search records with filters:

```javascript
const apiKey = localStorage.getItem('apiKey');
const url = new URL(`https://${DOMAIN}/v2/{Model}/search`);
url.searchParams.set('page', '1');
url.searchParams.set('limit', '20');
url.searchParams.set('searchTerm', 'search text');
url.searchParams.set('term', 'search text');
url.searchParams.set('select', 'field1 field2 field3');
url.searchParams.set('sort', '-createdAt');

const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
});

const data = await response.json();
const results = data.results || data.data || [];
```

#### Advanced Query with xquery
Filter records using MongoDB-like queries:

```javascript
const apiKey = localStorage.getItem('apiKey');
const url = new URL(`https://${DOMAIN}/v2/{Model}/`);
url.searchParams.set('page', '1');
url.searchParams.set('limit', '40');
url.searchParams.set('xquery', JSON.stringify({
    fieldName: { $in: ['value1', 'value2'] }
}));
url.searchParams.set('sort', '-createdAt');

const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
});

const data = await response.json();
```

---

## 🎨 UI/UX Standards (Prolibu v2 Style)

### Color Palette
- **Main background:** `#f5f5f5` (light gray)
- **Cards/Containers:** `#ffffff` (white)
- **Primary color:** `#667eea` (blue/purple)
- **Secondary color:** `#764ba2` (dark purple)
- **Borders:** `#e0e0e0`
- **Primary text:** `#333333`
- **Secondary text:** `#666666`
- **Tertiary text:** `#999999`

### Status Badges
```css
/* Status: To Do */
background: #cce5ff;
color: #004085;

/* Status: Done */
background: #d4edda;
color: #155724;

/* Status: QA */
background: #fff3cd;
color: #856404;

/* Status: Critical */
background: #f8d7da;
color: #721c24;
```

### Main Layout
```html
<!-- Fixed header -->
<div class="header">
    <h1>Title</h1>
    <div class="header-actions">
        <span class="user-info">👤 User</span>
        <button class="btn btn-logout">Logout</button>
    </div>
</div>

<!-- Main container -->
<div class="container">
    <!-- Toolbar with info -->
    <div class="toolbar">
        <div>150 records</div>
    </div>
    
    <!-- Table -->
    <div class="table-container">
        <table>...</table>
    </div>
    
    <!-- Pagination -->
    <div class="pagination">...</div>
</div>

<!-- FAB to create -->
<button class="fab">+</button>
```

### Required CSS Styles

```css
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f5f5f5;
    margin: 0;
}

.header {
    background: white;
    border-bottom: 1px solid #e0e0e0;
    padding: 12px 24px;
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px;
}

.table-container {
    background: white;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

table {
    width: 100%;
    border-collapse: collapse;
}

thead {
    background: #fafafa;
    border-bottom: 2px solid #e0e0e0;
}

th {
    padding: 12px 16px;
    text-align: left;
    font-weight: 600;
    font-size: 0.85em;
    color: #666;
    text-transform: uppercase;
}

tbody tr {
    border-bottom: 1px solid #f0f0f0;
    transition: background 0.15s;
}

tbody tr:hover {
    background: #fafafa;
}

td {
    padding: 16px;
    color: #333;
    font-size: 0.95em;
}

.fab {
    position: fixed;
    bottom: 32px;
    right: 32px;
    width: 56px;
    height: 56px;
    background: #667eea;
    border-radius: 50%;
    border: none;
    color: white;
    font-size: 24px;
    cursor: pointer;
    box-shadow: 0 4px 8px rgba(0,0,0,0.2);
}
```

---

## 🌐 Multilanguage

Implement support for Spanish and English:

```javascript
const lang = navigator.language.startsWith('es') ? 'es' : 'en';
const i18n = {
    es: {
        records: 'Registros',
        login: 'Iniciar Sesión',
        email: 'Email',
        password: 'Contraseña',
        logout: 'Cerrar Sesión',
        loading: 'Cargando...',
        noRecords: 'No hay registros',
        newRecord: 'Nuevo Registro',
        search: 'Buscar',
        title: 'Título',
        description: 'Descripción',
        status: 'Estado',
        create: 'Crear',
        cancel: 'Cancelar',
        save: 'Guardar',
        delete: 'Eliminar'
    },
    en: {
        records: 'Records',
        login: 'Sign In',
        email: 'Email',
        password: 'Password',
        logout: 'Logout',
        loading: 'Loading...',
        noRecords: 'No records',
        newRecord: 'New Record',
        search: 'Search',
        title: 'Title',
        description: 'Description',
        status: 'Status',
        create: 'Create',
        cancel: 'Cancel',
        save: 'Save',
        delete: 'Delete'
    }
};
const t = i18n[lang];

// Usage
document.title = t.records;
```

---

## 📄 Pagination

Implement pagination according to Prolibu standard:

```javascript
let currentPage = 1;
let totalPages = 1;

async function loadData(page = 1) {
    const limit = 40; // Records per page
    const offset = (page - 1) * limit;
    const apiKey = localStorage.getItem('apiKey');
    
    const response = await fetch(
        `https://${DOMAIN}/v2/{Model}?limit=${limit}&offset=${offset}`,
        { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    
    const data = await response.json();
    
    const items = data.results || data.data || [];
    const total = data.total || items.length;
    
    totalPages = Math.ceil(total / limit);
    currentPage = page;
    
    renderData(items, total);
}

function renderPagination() {
    return `
        <div class="pagination">
            <button 
                ${currentPage === 1 ? 'disabled' : ''} 
                onclick="loadData(${currentPage - 1})"
            >
                ← Previous
            </button>
            <span>${currentPage} / ${totalPages}</span>
            <button 
                ${currentPage === totalPages ? 'disabled' : ''} 
                onclick="loadData(${currentPage + 1})"
            >
                Next →
            </button>
        </div>
    `;
}
```

---

## 🛠️ Best Practices

### 1. Error Handling
```javascript
const apiKey = localStorage.getItem('apiKey');

try {
    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    
    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || `Error ${response.status}`);
    }
    
    const data = await response.json();
    return data;
    
} catch (error) {
    console.error('API Error:', error);
    // Show error to user
    alert('Error: ' + error.message);
}
```

### 2. Response Validation
```javascript
// Ensure it's an array
const items = Array.isArray(data) ? data : (data.results || data.data || []);

// Validate optional fields
const name = record.name || record.title || record.firstName || '-';
const date = record.createdAt ? new Date(record.createdAt).toLocaleDateString() : '-';

// Safe nested property access
const assignee = record.assignee?.firstName || record.assignee?.name || '-';
const company = record.company?.companyName || record.company || '-';
```

### 3. Loading States
```javascript
function showLoading() {
    document.getElementById('app').innerHTML = `
        <div class="loading">Loading...</div>
    `;
}

function showError(message) {
    document.getElementById('app').innerHTML = `
        <div class="container">
            <div class="error">${message}</div>
        </div>
    `;
}
```

### 4. Modals
```javascript
function showModal(title, content) {
    return `
        <div id="modal" class="modal show">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>${title}</h2>
                    <button class="modal-close" onclick="closeModal()">×</button>
                </div>
                ${content}
            </div>
        </div>
    `;
}

function closeModal() {
    document.getElementById('modal').classList.remove('show');
}
```

---

## 🤖 Recommended Workflow for AI Agent

When asked to create a site:

### 1. Initialization
```javascript
// Global variables
const DOMAIN = 'dev10.prolibu.com'; // Adjust according to domain
let currentUser = null;
let currentApiKey = null;
let currentPage = 1;
let totalPages = 1;

// Multilanguage
const lang = navigator.language.startsWith('es') ? 'es' : 'en';
const t = i18n[lang];
```

### 2. Authentication
```javascript
async function initializeAPIContext() {
    const apiKey = localStorage.getItem('apiKey');
    if (!apiKey) return null;
    
    // Check if we have cached user info
    const cachedMe = localStorage.getItem('me');
    if (cachedMe) {
        try {
            const user = JSON.parse(cachedMe);
            return { user, apiKey };
        } catch (e) {
            localStorage.removeItem('me');
        }
    }
    
    // Fetch user info
    const response = await fetch(`https://${DOMAIN}/v2/user/me`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    
    if (!response.ok) {
        localStorage.removeItem('apiKey');
        localStorage.removeItem('me');
        return null;
    }
    
    const user = await response.json();
    localStorage.setItem('me', JSON.stringify(user));
    return { user, apiKey };
}
```

### 3. Data Loading
```javascript
async function loadData(page = 1) {
    const limit = 40;
    const offset = (page - 1) * limit;
    const apiKey = localStorage.getItem('apiKey');
    
    const response = await fetch(
        `https://${DOMAIN}/v2/{Model}?limit=${limit}&offset=${offset}`,
        { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    
    const data = await response.json();
    const items = data.results || [];
    const total = data.total || 0;
    
    renderUI(items, total);
}
```

### 4. Rendering
```javascript
function renderUI(items, total) {
    const app = document.getElementById('app');
    const me = JSON.parse(localStorage.getItem('me'));
    
    app.innerHTML = `
        <div class="header">
            <h1>${t.title}</h1>
            <div class="header-actions">
                <span class="user-info">👤 ${me.name || me.email}</span>
                <button class="btn btn-logout" onclick="logout()">
                    ${t.logout}
                </button>
            </div>
        </div>
        
        <div class="container">
            <!-- Toolbar -->
            <div class="toolbar">
                <div>${total} records</div>
            </div>
            
            <!-- Table -->
            <div class="table-container">
                ${renderTable(items)}
            </div>
            
            <!-- Pagination -->
            ${renderPagination()}
        </div>
        
        <!-- FAB -->
        <button class="fab" onclick="showCreateModal()">+</button>
        
        <!-- Modal -->
        ${renderModal()}
    `;
}
```

### 5. CRUD Operations
```javascript
// CREATE
async function createItem(data) {
    const apiKey = localStorage.getItem('apiKey');
    const response = await fetch(`https://${DOMAIN}/v2/{Model}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    });
    
    if (response.ok) {
        closeModal();
        loadData(currentPage);
    }
}

// UPDATE
async function updateItem(id, data) {
    const apiKey = localStorage.getItem('apiKey');
    const response = await fetch(`https://${DOMAIN}/v2/{Model}/${id}`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    });
    
    if (!response.ok) throw new Error(`Error ${response.status}`);
    return await response.json();
}

// DELETE
async function deleteItem(id) {
    if (confirm('Delete?')) {
        const apiKey = localStorage.getItem('apiKey');
        await fetch(`https://${DOMAIN}/v2/{Model}/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        loadData(currentPage);
    }
}

// LOGOUT
function logout() {
    localStorage.removeItem('apiKey');
    localStorage.removeItem('me');
    location.reload();
}
```

---

## ✅ Checklist before Generating a Site

- [ ] Implement authentication (localStorage + validation)
- [ ] Handle Prolibu domains vs localhost
- [ ] Use Prolibu v2 UI styles (gray background, white header, table)
- [ ] Implement pagination (limit + offset)
- [ ] Multilanguage (es/en)
- [ ] FAB button to create
- [ ] Modal for forms
- [ ] Robust error handling
- [ ] Loading states
- [ ] API response validation
- [ ] **DO NOT** fetch OpenAPI on frontend (unnecessary)
- [ ] Store apiKey **WITHOUT** "Bearer" prefix
- [ ] Add "Bearer" prefix when making requests
- [ ] Store user info in localStorage key "me"
- [ ] Use **PATCH** for updates, not PUT
- [ ] Use `/search` endpoint for searching with filters
- [ ] Use `xquery` parameter for advanced filtering
- [ ] Functional logout (clear localStorage)

---

## 📝 Example Sites

See implemented examples:

### Basic CRUD Site
```
/accounts/dev10.prolibu.com/task/public/index.html
```
- ✅ Complete authentication
- ✅ Prolibu v2 UI style
- ✅ Pagination with limit/offset
- ✅ Responsive table
- ✅ FAB to create records
- ✅ Modal with form
- ✅ Multilanguage
- ✅ Full CRUD

### Multi-Step Wizard
```
/accounts/dev10.prolibu.com/deal-stage-updater/public/index.html
```
- ✅ Contact search with `/search` endpoint
- ✅ Advanced filtering with `xquery`
- ✅ Bulk updates with PATCH
- ✅ Step-by-step workflow
- ✅ Multiple record selection

---

**Last update:** November 2025  
**Prolibu CLI Version:** 2.0.0  
**API Version:** v2

## 📡 API de Prolibu v2

### Base URL
```
https://{domain}/v2
```

Ejemplos:
- `https://dev10.prolibu.com/v2`
- `https://suite.prolibu.com/v2`

### OpenAPI Specification (Opcional)
**NO es necesario** obtener el OpenAPI en el frontend. Solo úsalo si necesitas validar schemas complejos:

```javascript
const response = await fetch(`https://${DOMAIN}/v2/openapi/specification/`);
const openapi = await response.json();
```

### Endpoints Principales

#### GET /v2/user/me
Obtener información del usuario autenticado:

```javascript
const response = await fetch(`https://${DOMAIN}/v2/user/me`, {
    headers: { 'Authorization': apiKey }
});

const user = await response.json();
```

**Respuesta:**
```json
{
  "id": "user-id",
  "email": "user@example.com",
  "name": "User Name",
  "role": "admin",
  "schemas": [
    {
      "name": "Contact",
      "fields": [...]
    },
    {
      "name": "Task",
      "fields": [...]
    }
  ]
}
```

**⚠️ Importante:** Los schemas disponibles **dependen del role del usuario**.

#### GET /v2/{Model}
Listar registros de cualquier modelo:

```javascript
// Sin paginación
const response = await fetch(`https://${DOMAIN}/v2/Task`, {
    headers: { 'Authorization': apiKey }
});

// Con paginación (recomendado)
const limit = 40;
const offset = 0;
const response = await fetch(`https://${DOMAIN}/v2/Task?limit=${limit}&offset=${offset}`, {
    headers: { 'Authorization': apiKey }
});

const data = await response.json();
```

**Respuesta con paginación:**
```json
{
  "results": [...], // Array de registros
  "total": 150      // Total de registros
}
```

#### POST /v2/{Model}
Crear un nuevo registro:

```javascript
const response = await fetch(`https://${DOMAIN}/v2/Task`, {
    method: 'POST',
    headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        title: 'Nueva tarea',
        description: 'Descripción',
        status: 'To Do'
    })
});

const newTask = await response.json();
```

#### PUT /v2/{Model}/{id}
Actualizar un registro existente:

```javascript
const response = await fetch(`https://${DOMAIN}/v2/Task/${taskId}`, {
    method: 'PUT',
    headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        status: 'Done'
    })
});
```

#### DELETE /v2/{Model}/{id}
Eliminar un registro:

```javascript
const response = await fetch(`https://${DOMAIN}/v2/Task/${taskId}`, {
    method: 'DELETE',
    headers: { 'Authorization': apiKey }
});
```

---

## 🎨 Estándares de UI/UX (Estilo Prolibu v2)

### Paleta de Colores
- **Background principal:** `#f5f5f5` (gris claro)
- **Cards/Containers:** `#ffffff` (blanco)
- **Primary color:** `#667eea` (azul/morado)
- **Secondary color:** `#764ba2` (morado oscuro)
- **Bordes:** `#e0e0e0`
- **Texto principal:** `#333333`
- **Texto secundario:** `#666666`
- **Texto terciario:** `#999999`

### Estados con Badges
```javascript
// Estado: To Do
background: #cce5ff;
color: #004085;

// Estado: Done
background: #d4edda;
color: #155724;

// Estado: QA
background: #fff3cd;
color: #856404;

// Estado: Critical
background: #f8d7da;
color: #721c24;
```

### Layout Principal
```html
<!-- Header fijo -->
<div class="header">
    <h1>Título</h1>
    <div class="header-actions">
        <span class="user-info">👤 Usuario</span>
        <button class="btn btn-logout">Cerrar Sesión</button>
    </div>
</div>

<!-- Container principal -->
<div class="container">
    <!-- Toolbar con info -->
    <div class="toolbar">
        <div>150 registros</div>
    </div>
    
    <!-- Tabla -->
    <div class="table-container">
        <table>...</table>
    </div>
    
    <!-- Paginación -->
    <div class="pagination">...</div>
</div>

<!-- FAB para crear -->
<button class="fab">+</button>
```

### Estilos CSS Requeridos

```css
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f5f5f5;
    margin: 0;
}

.header {
    background: white;
    border-bottom: 1px solid #e0e0e0;
    padding: 12px 24px;
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px;
}

.table-container {
    background: white;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

table {
    width: 100%;
    border-collapse: collapse;
}

thead {
    background: #fafafa;
    border-bottom: 2px solid #e0e0e0;
}

th {
    padding: 12px 16px;
    text-align: left;
    font-weight: 600;
    font-size: 0.85em;
    color: #666;
    text-transform: uppercase;
}

tbody tr {
    border-bottom: 1px solid #f0f0f0;
    transition: background 0.15s;
}

tbody tr:hover {
    background: #fafafa;
}

td {
    padding: 16px;
    color: #333;
    font-size: 0.95em;
}

.fab {
    position: fixed;
    bottom: 32px;
    right: 32px;
    width: 56px;
    height: 56px;
    background: #667eea;
    border-radius: 50%;
    border: none;
    color: white;
    font-size: 24px;
    cursor: pointer;
    box-shadow: 0 4px 8px rgba(0,0,0,0.2);
}
```

---

## 🌐 Multilenguaje

Implementar soporte para español e inglés:

```javascript
const lang = navigator.language.startsWith('es') ? 'es' : 'en';
const i18n = {
    es: {
        tasks: 'Tareas',
        login: 'Iniciar Sesión',
        email: 'Email',
        password: 'Contraseña',
        logout: 'Cerrar Sesión',
        loading: 'Cargando...',
        noTasks: 'No hay tareas',
        newTask: 'Nueva Tarea',
        title: 'Título',
        description: 'Descripción',
        status: 'Estado',
        create: 'Crear',
        cancel: 'Cancelar'
    },
    en: {
        tasks: 'Tasks',
        login: 'Sign In',
        email: 'Email',
        password: 'Password',
        logout: 'Logout',
        loading: 'Loading...',
        noTasks: 'No tasks',
        newTask: 'New Task',
        title: 'Title',
        description: 'Description',
        status: 'Status',
        create: 'Create',
        cancel: 'Cancel'
    }
};
const t = i18n[lang];

// Uso
document.title = t.tasks;
```

---

## 📄 Paginación

Implementar paginación según el estándar de Prolibu:

```javascript
let currentPage = 1;
let totalPages = 1;

async function loadData(page = 1) {
    const limit = 40; // Registros por página
    const offset = (page - 1) * limit;
    
    const response = await fetch(
        `https://${DOMAIN}/v2/Task?limit=${limit}&offset=${offset}`,
        { headers: { 'Authorization': apiKey } }
    );
    
    const data = await response.json();
    
    const items = data.results || data.data || [];
    const total = data.total || items.length;
    
    totalPages = Math.ceil(total / limit);
    currentPage = page;
    
    renderData(items, total);
}

function renderPagination() {
    return `
        <div class="pagination">
            <button 
                ${currentPage === 1 ? 'disabled' : ''} 
                onclick="loadData(${currentPage - 1})"
            >
                ← Anterior
            </button>
            <span>${currentPage} / ${totalPages}</span>
            <button 
                ${currentPage === totalPages ? 'disabled' : ''} 
                onclick="loadData(${currentPage + 1})"
            >
                Siguiente →
            </button>
        </div>
    `;
}
```

---

## 🛠️ Mejores Prácticas

### 1. Manejo de Errores
```javascript
try {
    const response = await fetch(url, options);
    
    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || `Error ${response.status}`);
    }
    
    const data = await response.json();
    return data;
    
} catch (error) {
    console.error('API Error:', error);
    // Mostrar error al usuario
    alert('Error: ' + error.message);
}
```

### 2. Validación de Respuestas
```javascript
// Asegurar que es un array
const items = Array.isArray(data) ? data : (data.results || data.data || []);

// Validar campos opcionales
const title = task.title || task.name || '-';
const date = task.createdAt ? new Date(task.createdAt).toLocaleDateString() : '-';
```

### 3. Estados de Carga
```javascript
function showLoading() {
    document.getElementById('app').innerHTML = `
        <div class="loading">Cargando...</div>
    `;
}

function showError(message) {
    document.getElementById('app').innerHTML = `
        <div class="container">
            <div class="error">${message}</div>
        </div>
    `;
}
```

### 4. Modales
```javascript
function showModal(title, content) {
    return `
        <div id="modal" class="modal show">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>${title}</h2>
                    <button class="modal-close" onclick="closeModal()">×</button>
                </div>
                ${content}
            </div>
        </div>
    `;
}

function closeModal() {
    document.getElementById('modal').classList.remove('show');
}
```

---

## 🤖 Workflow Recomendado para AI Agent

Cuando te pidan crear un site:

### 1. Inicialización
```javascript
// Variables globales
const DOMAIN = 'dev10.prolibu.com'; // Ajustar según el dominio
let currentUser = null;
let currentApiKey = null;
let currentPage = 1;
let totalPages = 1;

// Multilenguaje
const lang = navigator.language.startsWith('es') ? 'es' : 'en';
const t = i18n[lang];
```

### 2. Autenticación
```javascript
async function initializeAPIContext() {
    const apiKey = localStorage.getItem('apiKey');
    if (!apiKey) return null;
    
    const response = await fetch(`https://${DOMAIN}/v2/user/me`, {
        headers: { 'Authorization': apiKey }
    });
    
    if (!response.ok) {
        localStorage.removeItem('apiKey');
        return null;
    }
    
    const user = await response.json();
    return { user, apiKey };
}
```

### 3. Carga de Datos
```javascript
async function loadData(page = 1) {
    const limit = 40;
    const offset = (page - 1) * limit;
    
    const response = await fetch(
        `https://${DOMAIN}/v2/{Model}?limit=${limit}&offset=${offset}`,
        { headers: { 'Authorization': currentApiKey } }
    );
    
    const data = await response.json();
    const items = data.results || [];
    const total = data.total || 0;
    
    renderUI(items, total);
}
```

### 4. Renderizado
```javascript
function renderUI(items, total) {
    const app = document.getElementById('app');
    
    app.innerHTML = `
        <div class="header">
            <h1>${t.title}</h1>
            <div class="header-actions">
                <span class="user-info">👤 ${currentUser.name}</span>
                <button class="btn btn-logout" onclick="logout()">
                    ${t.logout}
                </button>
            </div>
        </div>
        
        <div class="container">
            <!-- Toolbar -->
            <div class="toolbar">
                <div>${total} registros</div>
            </div>
            
            <!-- Tabla -->
            <div class="table-container">
                ${renderTable(items)}
            </div>
            
            <!-- Paginación -->
            ${renderPagination()}
        </div>
        
        <!-- FAB -->
        <button class="fab" onclick="showCreateModal()">+</button>
        
        <!-- Modal -->
        ${renderModal()}
    `;
}
```

### 5. CRUD Operations
```javascript
// CREATE
async function createItem(data) {
    const response = await fetch(`https://${DOMAIN}/v2/{Model}`, {
        method: 'POST',
        headers: {
            'Authorization': currentApiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    });
    
    if (response.ok) {
        closeModal();
        loadData(currentPage);
    }
}

// UPDATE
async function updateItem(id, data) {
    await fetch(`https://${DOMAIN}/v2/{Model}/${id}`, {
        method: 'PUT',
        headers: {
            'Authorization': currentApiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    });
}

// DELETE
async function deleteItem(id) {
    if (confirm('¿Eliminar?')) {
        await fetch(`https://${DOMAIN}/v2/{Model}/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': currentApiKey }
        });
        loadData(currentPage);
    }
}
```

---

## ✅ Checklist antes de Generar un Site

- [ ] Implementar autenticación (localStorage + validación)
- [ ] Manejar dominios Prolibu vs localhost
- [ ] Usar estilos UI Prolibu v2 (fondo gris, header blanco, tabla)
- [ ] Implementar paginación (limit + offset)
- [ ] Multilenguaje (es/en)
- [ ] Botón FAB para crear
- [ ] Modal para formularios
- [ ] Manejo de errores robusto
- [ ] Estados de carga
- [ ] Validación de respuestas del API
- [ ] **NO** obtener OpenAPI en el frontend (innecesario)
- [ ] Usar `apiKey` directamente (ya incluye "Bearer")
- [ ] Logout funcional (limpiar localStorage)

---

## 📝 Ejemplo Completo: Site de Tareas

Ver el site implementado en:
```
/accounts/dev10.prolibu.com/task/public/index.html
```

Este site incluye:
- ✅ Autenticación completa
- ✅ UI estilo Prolibu v2
- ✅ Paginación con limit/offset
- ✅ Tabla responsive
- ✅ FAB para crear tareas
- ✅ Modal con formulario
- ✅ Multilenguaje
- ✅ CRUD completo

---

**Última actualización:** Noviembre 2025  
**Versión Prolibu CLI:** 2.0.0  
**API Version:** v2
