# Salesforce Migration — Guía por Fases (Back → Front)

Objetivo: Migrar una instancia de Salesforce completamente customizada de forma ordenada, faseando desde la capa de datos e infraestructura hasta llegar a la experiencia del usuario, minimizando riesgo y permitiendo validación incremental en cada etapa.

---

## Principio de orden

```
Fase 1 → Discovery
Fase 2 → Data (backend puro)
Fase 3 → Metadata / Schema
Fase 4 → Business Logic
Fase 5 → Seguridad y Permisos
Fase 6 → Integraciones Externas
Fase 7 → Contexto Histórico
Fase 8 → Front-End / UI-UX
Fase 9 → Reports y Analytics
Fase 10 → Validación y Go-Live
```

Cada fase tiene su propio gate de validación. No se avanza a la siguiente sin aprobar la anterior.

---

## Fase 1 — Discovery & Blueprint

**Objetivo:** Conocer todo antes de tocar nada.

### Tareas

- Inventariar todos los Objects (standard y custom)
- Mapear Fields, Types y Picklists
- Documentar Relationships entre objetos
- Exportar Metadata completa (via SF CLI o API)
- Identificar Automations, Flows, Triggers y Workflows
- Inventariar Integraciones externas activas
- Mapear Permisos, Roles y Profiles
- Contar volumen de registros por objeto

### Deliverable

- **Salesforce System Blueprint** — documento vivo que guía todas las fases siguientes.

### Gate de validación

- Blueprint aprobado por el cliente
- No hay ambigüedades en relaciones ni en objetos críticos

---

## Fase 2 — Migración de Datos (Backend)

**Objetivo:** Llevar todos los registros al nuevo sistema preservando relaciones. El usuario aún no opera en el nuevo sistema.

### Orden de migración

1. **Objetos base (sin dependencias)**

   - Accounts
   - Products / Pricebooks
   - Campaigns

2. **Objetos con dependencias de nivel 1**

   - Contacts (depende de Accounts)
   - Leads (independiente pero referencia Campaigns)
   - Opportunities (depende de Accounts)
   - Cases (depende de Accounts y Contacts)

3. **Objetos con dependencias de nivel 2+**

   - Activities (depende de Contacts, Leads, Opportunities)
   - Custom Objects (según mapa de relaciones del Blueprint)

4. **Datos adjuntos**
   - Attachments
   - Files
   - Notes

### Requisitos técnicos

- Tabla de mapping `salesforce_id → new_id` generada y persistida desde el inicio
- Reconstrucción de relaciones usando el mapping
- Soporte de migración incremental (delta) para el corte final
- Validación de conteo de registros por objeto post-migración

### Gate de validación

- Conteo de registros coincide entre origen y destino
- Relaciones verificadas en muestra representativa
- Tabla de ID mapping completa y sin nulos

---

## Fase 3 — Metadata / Schema Migration

**Objetivo:** Recrear el Data Model completo en el destino. Sin esto la lógica de negocio no puede funcionar.

### Tareas

- Crear Custom Objects
- Crear Custom Fields (con tipos correctos)
- Crear y mapear Picklists
- Configurar Record Types
- Replicar Field Defaults
- Migrar Validation Rules
- Migrar Formula Fields
- Migrar Rollup Fields

### Nota

Esta fase puede ejecutarse en paralelo con la Fase 2, siempre que el schema de destino esté listo antes de que los datos lo necesiten.

### Gate de validación

- Todos los campos del Blueprint existen en destino
- Tipos de dato correctos (no hay truncamientos ni conversiones silenciosas)
- Validation Rules probadas con casos positivos y negativos

---

## Fase 4 — Business Logic (Automations)

**Objetivo:** Reproducir el comportamiento automático del sistema. Esta es la fase de mayor riesgo técnico.

### Orden sugerido

1. **Field Updates** — los más simples, sin efectos secundarios grandes
2. **Email Alerts** — verificables de forma aislada
3. **Workflow Rules** — lógica declarativa
4. **Process Builder / Flows** — lógica de mayor complejidad
5. **Apex Triggers** — lógica imperativa, requiere desarrollo
6. **Scheduled Jobs** — activar al final, una vez validado el resto

### Requisitos

- Cada automation documentada en el Blueprint con su comportamiento esperado
- Suite de test cases por automation (input → expected output)
- Los triggers deben ejecutarse en entorno de staging antes de producción

### Gate de validación

- Cada automation probada con sus test cases
- No hay efectos secundarios no esperados (loops, duplicados, etc.)
- Scheduled Jobs verificados en staging con datos reales

---

## Fase 5 — Seguridad y Permisos

**Objetivo:** Replicar el modelo de acceso exactamente. Un error aquí es un problema de compliance.

### Tareas

- Crear Users (sin activar acceso al nuevo sistema aún)
- Replicar Roles y jerarquía
- Migrar Profiles con sus configuraciones base
- Migrar Permission Sets y Permission Set Groups
- Configurar Object Permissions por perfil
- Configurar Field Level Security
- Replicar Sharing Rules

### Gate de validación

- Matriz de permisos verificada contra el Blueprint
- Pruebas de acceso por rol (mínimo 3 perfiles críticos)
- Field Level Security verificada para campos sensibles

---

## Fase 6 — Integraciones Externas

**Objetivo:** Reconectar el ecosistema sin romper flujos en producción.

### Estrategia

Migrar primero integraciones de solo lectura, luego las de escritura.

1. **Integraciones de lectura** (reportes externos, BI tools)
2. **Webhooks salientes** (notificaciones, triggers externos)
3. **Zapier / Middleware** (automatizaciones de terceros)
4. **Data Sync jobs** (sincronización bidireccional)
5. **ERP integrations** (mayor impacto, validar en staging)
6. **Marketing tools** (Mailchimp, HubSpot, etc.)

### Requisitos

- Credenciales del nuevo sistema disponibles por integración
- Entorno de staging con endpoints reales para pruebas
- Plan de rollback por integración

### Gate de validación

- Cada integración probada con payload real
- No hay duplicación de registros en ninguna dirección
- Integraciones críticas probadas en paralelo (SF activo + nuevo sistema activo)

---

## Fase 7 — Contexto Histórico

**Objetivo:** Que el usuario sienta continuidad total. Esta fase es crítica para la percepción del usuario.

### Datos a migrar

- Activity Timeline (llamadas, reuniones, tareas)
- Email Threads (historial de correos vinculados)
- Field History (auditoría de cambios de valor)
- Notes (notas libres vinculadas a registros)
- Attachments y Files ya migrados en Fase 2 (verificar vínculos)
- Audit Logs (si el destino los soporta)

### Consideraciones

- El historial no necesita ser interactivo, pero sí visible
- Los emails pueden migrar como registros de actividad si no hay soporte nativo
- Field History puede ser costosa de migrar completa — acordar con el cliente el período mínimo aceptable (ej. últimos 2 años)

### Gate de validación

- Registro de muestra verificado con su historial completo
- Fechas y autores preservados
- Cliente aprueba la visualización del historial

---

## Fase 8 — Front-End / UI-UX

**Objetivo:** Que el usuario reconozca su sistema al primer vistazo. Es la fase más visible para el cliente.

### Tareas

- Configurar Apps y navegación principal
- Replicar Tabs y orden de navegación
- Migrar Page Layouts por Record Type
- Configurar Lightning Pages equivalentes
- Configurar Related Lists por objeto
- Recrear Custom Components (si el destino los soporta)
- Revisar etiquetas y traducciones

### Estrategia

Tomar capturas de pantalla de las vistas más usadas en Salesforce y usarlas como referencia directa para la configuración del destino.

### Gate de validación

- Revisión side-by-side con el cliente de las vistas principales
- Flujos de trabajo comunes probados end-to-end por el usuario clave
- No hay campos faltantes en ningún layout crítico

---

## Fase 9 — Reports & Analytics

**Objetivo:** Restaurar la visibilidad del negocio. Sin reportes el equipo de management no puede operar.

### Orden sugerido

1. **Reports simples** (listados, sin aggregaciones complejas)
2. **Reports con filtros y agrupaciones**
3. **Report Types custom**
4. **Dashboards** (dependen de los reports)
5. **Scheduled Reports** (activar al final)

### Gate de validación

- Los 5 reportes más usados producen el mismo resultado en origen y destino
- Dashboards revisados con el cliente
- Scheduled Reports verificados con un ciclo completo antes del Go-Live

---

## Fase 10 — Validación Final y Go-Live

**Objetivo:** Corte limpio y sin sorpresas.

### Pre-corte

- Migración final de delta (registros creados/modificados desde la Fase 2)
- Validación de conteos finales por objeto
- Comparación de reportes clave entre sistemas
- QA de automatizaciones críticas con datos reales
- Pruebas de permisos por rol
- Verificación de todas las integraciones activas
- Confirmación de contexto histórico visible

### Parallel Run (recomendado)

Durante 1-2 semanas antes del corte, operar ambos sistemas en paralelo:

- Salesforce como sistema oficial de registro
- Nuevo sistema como sistema de validación
- Equipo clave reporta discrepancias diariamente

### Go-Live

1. Migración final de delta
2. Congelar Salesforce (modo lectura o baja)
3. Activar nuevo sistema como oficial
4. Verificar integraciones apuntando al nuevo sistema
5. Comunicar al equipo
6. Monitoreo intensivo las primeras 48 horas

### Post Go-Live

- Disponibilidad de Salesforce en lectura por 30 días (rollback de datos si es necesario)
- Soporte prioritario al equipo durante la primera semana
- Retrospectiva a los 30 días

---

## Resumen de fases y dependencias

| Fase | Nombre                 | Depende de | Riesgo  |
| ---- | ---------------------- | ---------- | ------- |
| 1    | Discovery & Blueprint  | —          | Bajo    |
| 2    | Data Migration         | 1          | Alto    |
| 3    | Metadata / Schema      | 1          | Medio   |
| 4    | Business Logic         | 3          | Alto    |
| 5    | Seguridad y Permisos   | 1          | Alto    |
| 6    | Integraciones Externas | 2, 4       | Alto    |
| 7    | Contexto Histórico     | 2          | Medio   |
| 8    | Front-End / UI-UX      | 3, 5       | Medio   |
| 9    | Reports & Analytics    | 2, 3       | Medio   |
| 10   | Validación y Go-Live   | Todas      | Crítico |
