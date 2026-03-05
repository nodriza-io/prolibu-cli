# Salesforce 110% Migration Checklist

Objetivo: Migrar una instancia de Salesforce completamente customizada a nuestro CRM sin que el usuario perciba pérdida de funcionalidad, datos o procesos.

---

# 1. Discovery & Analysis

- Inventariar todos los **Objects (standard y custom)**
- Mapear **Fields, Types, Picklists**
- Analizar **Relationships**
- Exportar **Metadata completa**
- Identificar **Automations y Triggers**
- Inventariar **Integraciones externas**
- Mapear **Permisos y roles**

Deliverable:

- Salesforce System Blueprint

---

# 2. Data Migration

Migrar todos los datos manteniendo relaciones.

Incluye:

- Accounts
- Contacts
- Leads
- Opportunities
- Activities
- Cases
- Campaigns
- Products
- Pricebooks
- Custom Objects
- Attachments
- Files
- Notes
- Field History

Requisitos:

- Mapping `salesforce_id → new_id`
- Reconstrucción de relaciones
- Migración incremental opcional

---

# 3. Metadata Migration

Recrear la estructura del sistema.

Migrar:

- Custom Objects
- Custom Fields
- Picklists
- Record Types
- Field Defaults
- Validation Rules
- Formula Fields
- Rollup Fields

Objetivo:
Reproducir el **Data Model completo**.

---

# 4. Automation Migration

Recrear la lógica del negocio.

Migrar:

- Flows
- Workflow Rules
- Process Builder
- Apex Triggers
- Email Alerts
- Field Updates
- Scheduled Jobs

Objetivo:
Mantener **comportamiento automático idéntico**.

---

# 5. Security & Permissions

Replicar el modelo de seguridad.

Migrar:

- Users
- Roles
- Profiles
- Permission Sets
- Permission Set Groups
- Object Permissions
- Field Level Security
- Sharing Rules

Objetivo:
Mantener **control de acceso idéntico**.

---

# 6. UI & UX Parity

Recrear la experiencia de usuario.

Migrar:

- Apps
- Navigation
- Tabs
- Page Layouts
- Lightning Pages
- Related Lists
- Custom Components

Objetivo:
Que el usuario **reconozca su sistema inmediatamente**.

---

# 7. Reports & Analytics

Reproducir los insights del negocio.

Migrar:

- Reports
- Report Types
- Dashboards
- Filters
- Aggregations
- Scheduled Reports

Objetivo:
No perder visibilidad del negocio.

---

# 8. Integrations

Reconectar el ecosistema.

Migrar o recrear:

- REST APIs
- Webhooks
- Zapier / Middleware
- ERP integrations
- Marketing tools
- Data Sync jobs

Objetivo:
Evitar ruptura de flujos externos.

---

# 9. Historical Context (Critical)

Migrar datos que preservan contexto.

Incluye:

- Activity Timeline
- Email Threads
- Field History
- Notes
- Attachments
- Audit Logs

Objetivo:
Que el usuario **sienta continuidad total**.

---

# 10. Validation & Parallel Run

Antes del corte final.

- Validación de datos
- Comparación de reportes
- QA de automatizaciones
- Pruebas de permisos
- Parallel run opcional

---

# 11. Go-Live

- Migración final de delta
- Cambio de sistema activo
- Verificación de integraciones
- Monitoreo de errores

---

# Success Criteria (110% Migration)

El cliente:

- encuentra sus datos
- reconoce sus procesos
- ve los mismos reportes
- mantiene sus permisos
- conserva su historial
- no pierde integraciones

Resultado:
**Migración invisible para el usuario.**
