const fs = require('fs');
const path = require('path');
const ProlibuApi = require('../../lib/vendors/prolibu/ProlibuApi');

/**
 * Reserved JavaScript keywords — cannot be used as custom field names.
 */
const JS_RESERVED_KEYWORDS = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'export', 'extends', 'finally',
    'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new',
    'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var',
    'void', 'while', 'with', 'yield',
]);

/**
 * Reserved fields that cannot be used in Custom Objects.
 */
const COB_RESERVED_FIELDS = new Set([
    '_id', '__v', 'modelName', 'active', 'unset',
    'createdAt', 'updatedAt', 'createdBy', 'updatedBy',
]);

/**
 * Valid types for custom fields.
 */
const VALID_TYPES = new Set([
    'string', 'number', 'boolean', 'date', 'buffer',
    'objectid', 'mixed', 'decimal128', 'array', 'map',
]);

/**
 * Validate a field name for use as a custom field attribute.
 * @param {string} name
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateFieldName(name) {
    if (!name || typeof name !== 'string') {
        return { valid: false, reason: 'Field name must be a non-empty string' };
    }
    if (JS_RESERVED_KEYWORDS.has(name)) {
        return { valid: false, reason: `"${name}" is a reserved JavaScript keyword` };
    }
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
        return { valid: false, reason: `"${name}" is not a valid JavaScript identifier` };
    }
    return { valid: true };
}

/**
 * SchemaSetup — create custom fields on existing models and custom objects (COBs) in Prolibu.
 *
 * This module wraps the Prolibu API to provide a clean interface for:
 * - Adding custom fields to existing Prolibu models (User, Contact, Deal, etc.)
 * - Overriding existing fields on models (making optional fields required, etc.)
 * - Creating entirely new custom objects (COBs)
 * - Applying a `prolibu_setup.json` configuration in batch
 *
 * @example
 * const setup = new SchemaSetup({ domain: 'dev10.prolibu.com', apiKey: 'xxx' });
 *
 * // Add custom fields to Contact
 * await setup.createCustomFields('Contact', {
 *   color: { type: 'string', description: 'Favorite color' },
 *   size:  { type: 'string', enum: ['S', 'M', 'L'] },
 * });
 *
 * // Create a custom object
 * await setup.createCustomObject({
 *   modelName: 'Pet',
 *   petName: { type: 'string', required: true, displayName: true },
 *   species: { type: 'string', enum: ['Dog', 'Cat', 'Bird'] },
 * });
 *
 * // Apply prolibu_setup.json
 * await setup.applySetupFromFile('./prolibu_setup.json');
 */
class SchemaSetup {
    /**
     * @param {object} options
     * @param {string}  options.domain  - Prolibu domain (e.g. dev10.prolibu.com)
     * @param {string}  options.apiKey  - Prolibu API key
     * @param {boolean} [options.dryRun=false] - If true, no writes are performed
     */
    constructor({ domain, apiKey, dryRun = false }) {
        this.domain = domain;
        this.apiKey = apiKey;
        this.dryRun = dryRun;
        this.api = new ProlibuApi({ domain, apiKey });
    }

    // ────────────────────────────────────────────────────────────
    //  Custom Fields — extend existing models
    // ────────────────────────────────────────────────────────────

    /**
     * List all existing CustomField records.
     * @returns {Promise<object[]>}
     */
    async getCustomFields() {
        const res = await this.api.find('CustomField');
        return res?.data || res?.results || (Array.isArray(res) ? res : []);
    }

    /**
     * Get the CustomField record for a specific model.
     * Since Prolibu enforces one CustomField per model (unique objectAssigned),
     * this returns a single object or null.
     *
     * @param {string} modelName  - e.g. 'Contact', 'Deal', 'User'
     * @returns {Promise<object|null>}
     */
    async getCustomFieldForModel(modelName) {
        const all = await this.getCustomFields();
        return all.find((cf) => cf.objectAssigned === modelName) || null;
    }

    /**
     * Create or update custom fields on an existing Prolibu model.
     *
     * Fields are added under the `customFields` property of the model
     * (e.g. Contact.customFields.color).
     *
     * If a CustomField record already exists for this model, it merges the new
     * fields into the existing ones (PATCH). Otherwise, it creates a new record.
     *
     * @param {string} modelName - Target model (e.g. 'Contact', 'Deal', 'User')
     * @param {object} fields    - Key-value map of field definitions
     * @param {object} [options]
     * @param {boolean} [options.merge=true] - If true, merge with existing fields; if false, replace
     *
     * @returns {Promise<{ success: boolean, record?: object, error?: string }>}
     *
     * @example
     * await setup.createCustomFields('Contact', {
     *   color:    { type: 'string', description: 'Favorite color' },
     *   priority: { type: 'number', min: 1, max: 5 },
     *   assignee: { type: 'objectid', ref: 'User' },
     * });
     */
    async createCustomFields(modelName, fields, { merge = true } = {}) {
        // Validate all field names
        for (const name of Object.keys(fields)) {
            const check = validateFieldName(name);
            if (!check.valid) {
                return { success: false, error: `Invalid field name "${name}": ${check.reason}` };
            }
        }

        // Validate types
        for (const [name, def] of Object.entries(fields)) {
            if (!def.type) {
                return { success: false, error: `Field "${name}" is missing required property "type"` };
            }
            const baseType = Array.isArray(def.type) ? def.type[0] : def.type;
            if (typeof baseType === 'string' && !VALID_TYPES.has(baseType.toLowerCase())) {
                return { success: false, error: `Field "${name}" has invalid type "${def.type}". Valid types: ${[...VALID_TYPES].join(', ')}` };
            }
        }

        // Ensure isCustomField: true on every field
        const normalizedFields = {};
        for (const [name, def] of Object.entries(fields)) {
            normalizedFields[name] = { isCustomField: true, ...def };
        }

        if (this.dryRun) {
            console.log(`[dry-run] Would create custom fields on "${modelName}":`, Object.keys(normalizedFields).join(', '));
            return { success: true, dryRun: true };
        }

        try {
            const existing = await this.getCustomFieldForModel(modelName);

            if (existing) {
                // Merge or replace existing fields
                const updatedFields = merge
                    ? { ...existing.customFields, ...normalizedFields }
                    : normalizedFields;

                const result = await this.api.update('CustomField', existing._id, {
                    customFields: updatedFields,
                });
                console.log(`✅ Custom fields updated on "${modelName}": ${Object.keys(normalizedFields).join(', ')}`);
                return { success: true, record: result, action: 'updated' };
            }

            // Create new CustomField record
            const result = await this.api.create('CustomField', {
                objectAssigned: modelName,
                customFields: normalizedFields,
            });
            console.log(`✅ Custom fields created on "${modelName}": ${Object.keys(normalizedFields).join(', ')}`);
            return { success: true, record: result, action: 'created' };
        } catch (err) {
            const msg = err?.response?.data?.message || err?.response?.data?.error || err.message || String(err);
            console.error(`❌ Failed to create custom fields on "${modelName}": ${msg}`);
            return { success: false, error: msg };
        }
    }

    /**
     * Add overrides to an existing Prolibu model.
     *
     * Overrides can:
     * - Modify properties of existing fields (e.g. make a field required)
     * - Create new fields at the root level of the schema (not under customFields)
     *
     * @param {string} modelName  - Target model (e.g. 'Deal', 'Contact')
     * @param {object} overrides  - Key-value map of field overrides
     * @param {object} [options]
     * @param {boolean} [options.merge=true] - If true, merge with existing overrides
     *
     * @returns {Promise<{ success: boolean, record?: object, error?: string }>}
     *
     * @example
     * await setup.addOverrides('Deal', {
     *   amount:       { required: true, min: 1000 },        // modify existing field
     *   contractType: { type: 'string', enum: ['Monthly', 'Annual'] },  // new root field
     * });
     */
    async addOverrides(modelName, overrides, { merge = true } = {}) {
        // Validate field names
        for (const name of Object.keys(overrides)) {
            const check = validateFieldName(name);
            if (!check.valid) {
                return { success: false, error: `Invalid field name "${name}": ${check.reason}` };
            }
        }

        // Ensure isCustomField: true
        const normalizedOverrides = {};
        for (const [name, def] of Object.entries(overrides)) {
            normalizedOverrides[name] = { isCustomField: true, ...def };
        }

        if (this.dryRun) {
            console.log(`[dry-run] Would add overrides on "${modelName}":`, Object.keys(normalizedOverrides).join(', '));
            return { success: true, dryRun: true };
        }

        try {
            const existing = await this.getCustomFieldForModel(modelName);

            if (existing) {
                const updatedOverrides = merge
                    ? { ...existing.overrides, ...normalizedOverrides }
                    : normalizedOverrides;

                const result = await this.api.update('CustomField', existing._id, {
                    overrides: updatedOverrides,
                });
                console.log(`✅ Overrides updated on "${modelName}": ${Object.keys(normalizedOverrides).join(', ')}`);
                return { success: true, record: result, action: 'updated' };
            }

            const result = await this.api.create('CustomField', {
                objectAssigned: modelName,
                overrides: normalizedOverrides,
            });
            console.log(`✅ Overrides created on "${modelName}": ${Object.keys(normalizedOverrides).join(', ')}`);
            return { success: true, record: result, action: 'created' };
        } catch (err) {
            const msg = err?.response?.data?.message || err?.response?.data?.error || err.message || String(err);
            console.error(`❌ Failed to add overrides on "${modelName}": ${msg}`);
            return { success: false, error: msg };
        }
    }

    // ────────────────────────────────────────────────────────────
    //  Custom Objects (COBs) — create new models
    // ────────────────────────────────────────────────────────────

    /**
     * List all existing Custom Objects (COBs).
     * @returns {Promise<object[]>}
     */
    async getCustomObjects() {
        const res = await this.api.find('Cob');
        return res?.data || res?.results || (Array.isArray(res) ? res : []);
    }

    /**
     * Get a Custom Object by its model name.
     * @param {string} modelName - e.g. 'Pet', 'Vehicle'
     * @returns {Promise<object|null>}
     */
    async getCustomObject(modelName) {
        const all = await this.getCustomObjects();
        return all.find((cob) => cob.modelName === modelName) || null;
    }

    /**
     * Create a new Custom Object (COB) in Prolibu.
     *
     * A COB is a fully dynamic model with its own API routes, CRUD, and permissions.
     * After creation, the Prolibu server needs to restart for the model to take effect.
     *
     * @param {object} definition - The COB definition
     * @param {string} definition.modelName - Name of the model (PascalCase, singular)
     * @param {boolean} [definition.active=true] - Whether the COB is active
     * @param {object} [definition.unset] - Methods/permissions to disable
     * @param {...object} definition.<fieldName> - Field definitions (type, required, etc.)
     *
     * @returns {Promise<{ success: boolean, record?: object, error?: string }>}
     *
     * @example
     * await setup.createCustomObject({
     *   modelName: 'Pet',
     *   active: true,
     *   petName:  { type: 'string', required: true, displayName: true },
     *   species:  { type: 'string', enum: ['Dog', 'Cat', 'Bird'] },
     *   owner:    { type: 'objectid', ref: 'User' },
     * });
     */
    async createCustomObject(definition) {
        if (!definition || !definition.modelName) {
            return { success: false, error: 'modelName is required in the COB definition' };
        }

        const { modelName } = definition;

        // Validate field names (skip reserved system properties)
        const systemProps = new Set(['modelName', 'active', 'unset']);
        for (const name of Object.keys(definition)) {
            if (systemProps.has(name)) continue;
            if (COB_RESERVED_FIELDS.has(name)) {
                return { success: false, error: `"${name}" is a reserved field and cannot be used in a Custom Object` };
            }
            const check = validateFieldName(name);
            if (!check.valid) {
                return { success: false, error: `Invalid field name "${name}": ${check.reason}` };
            }
        }

        if (this.dryRun) {
            const fieldNames = Object.keys(definition).filter((k) => !systemProps.has(k));
            console.log(`[dry-run] Would create Custom Object "${modelName}" with fields: ${fieldNames.join(', ')}`);
            return { success: true, dryRun: true };
        }

        try {
            // Check if COB already exists
            const existing = await this.getCustomObject(modelName);
            if (existing) {
                // Update existing COB
                const { modelName: _, ...updateData } = definition;
                const result = await this.api.update('Cob', existing._id, updateData);
                console.log(`✅ Custom Object "${modelName}" updated`);
                return { success: true, record: result, action: 'updated' };
            }

            // Set default active value
            if (definition.active === undefined) {
                definition.active = true;
            }

            const result = await this.api.create('Cob', definition);
            console.log(`✅ Custom Object "${modelName}" created`);
            return { success: true, record: result, action: 'created' };
        } catch (err) {
            const msg = err?.response?.data?.message || err?.response?.data?.error || err.message || String(err);
            console.error(`❌ Failed to create Custom Object "${modelName}": ${msg}`);
            return { success: false, error: msg };
        }
    }

    // ────────────────────────────────────────────────────────────
    //  Batch apply — prolibu_setup.json
    // ────────────────────────────────────────────────────────────

    /**
     * Apply a setup configuration containing custom objects and custom fields.
     *
     * The setup config typically comes from `prolibu_setup.json` generated by the
     * review UI phase.
     *
     * Supported formats:
     *
     * **Format A — "prolibu_setup.json" (from review UI)**
     * ```json
     * {
     *   "customObjects": [
     *     { "prolibuEntity": "Pet", "label": "Pet", "sourceSObject": "Pet__c", "action": "create" }
     *   ],
     *   "customFields": [
     *     { "prolibuEntity": "Contact", "apiName": "color", "label": "Color", "type": "string", "sourceSField": "Color__c" }
     *   ]
     * }
     * ```
     *
     * **Format B — "full definition" (direct API payloads)**
     * ```json
     * {
     *   "customObjects": [
     *     { "modelName": "Pet", "active": true, "petName": { "type": "string", "required": true } }
     *   ],
     *   "customFields": [
     *     { "objectAssigned": "Contact", "customFields": { "color": { "type": "string" } } }
     *   ]
     * }
     * ```
     *
     * @param {object} setupConfig - The setup configuration
     * @returns {Promise<{ customObjects: object[], customFields: object[], errors: string[] }>}
     */
    async applySetup(setupConfig) {
        const report = {
            customObjects: [],
            customFields: [],
            errors: [],
        };

        if (!setupConfig) {
            report.errors.push('Setup config is null or undefined');
            return report;
        }

        // ── Custom Objects ──────────────────────────────────────
        const cobs = setupConfig.customObjects || [];
        for (const cobDef of cobs) {
            try {
                let definition;

                if (cobDef.modelName) {
                    // Format B — direct API payload
                    definition = cobDef;
                } else if (cobDef.prolibuEntity) {
                    // Format A — lightweight from review UI
                    definition = {
                        modelName: cobDef.prolibuEntity,
                        active: true,
                    };
                    // If additional field definitions are provided, include them
                    if (cobDef.fields) {
                        Object.assign(definition, cobDef.fields);
                    }
                } else {
                    report.errors.push(`Custom object entry is missing "modelName" or "prolibuEntity": ${JSON.stringify(cobDef)}`);
                    continue;
                }

                const result = await this.createCustomObject(definition);
                if (result.success) {
                    report.customObjects.push({ modelName: definition.modelName, ...result });
                } else {
                    report.errors.push(`COB "${definition.modelName}": ${result.error}`);
                }
            } catch (err) {
                report.errors.push(`COB error: ${err.message}`);
            }
        }

        // ── Custom Fields ───────────────────────────────────────
        const cfs = setupConfig.customFields || [];

        // Group by target model for batch operations
        const fieldsByModel = {};
        for (const cfDef of cfs) {
            if (cfDef.objectAssigned) {
                // Format B — direct API payload
                const model = cfDef.objectAssigned;
                if (!fieldsByModel[model]) fieldsByModel[model] = { customFields: {}, overrides: {} };
                if (cfDef.customFields) {
                    Object.assign(fieldsByModel[model].customFields, cfDef.customFields);
                }
                if (cfDef.overrides) {
                    Object.assign(fieldsByModel[model].overrides, cfDef.overrides);
                }
            } else if (cfDef.prolibuEntity) {
                // Format A — from review UI (individual fields)
                const model = cfDef.prolibuEntity;
                if (!fieldsByModel[model]) fieldsByModel[model] = { customFields: {}, overrides: {} };
                const fieldName = cfDef.apiName || cfDef.label?.replace(/\s+/g, '_').toLowerCase();
                if (!fieldName) {
                    report.errors.push(`Custom field entry is missing "apiName": ${JSON.stringify(cfDef)}`);
                    continue;
                }
                fieldsByModel[model].customFields[fieldName] = {
                    type: cfDef.type || 'string',
                    description: cfDef.label || fieldName,
                    ...(cfDef.enum ? { enum: cfDef.enum } : {}),
                    ...(cfDef.required ? { required: true } : {}),
                    ...(cfDef.ref ? { ref: cfDef.ref } : {}),
                };
            } else {
                report.errors.push(`Custom field entry is missing "objectAssigned" or "prolibuEntity": ${JSON.stringify(cfDef)}`);
            }
        }

        // Apply grouped fields per model
        for (const [modelName, defs] of Object.entries(fieldsByModel)) {
            try {
                if (Object.keys(defs.customFields).length > 0) {
                    const result = await this.createCustomFields(modelName, defs.customFields);
                    if (result.success) {
                        report.customFields.push({
                            modelName,
                            fields: Object.keys(defs.customFields),
                            section: 'customFields',
                            ...result,
                        });
                    } else {
                        report.errors.push(`Custom fields on "${modelName}": ${result.error}`);
                    }
                }

                if (Object.keys(defs.overrides).length > 0) {
                    const result = await this.addOverrides(modelName, defs.overrides);
                    if (result.success) {
                        report.customFields.push({
                            modelName,
                            fields: Object.keys(defs.overrides),
                            section: 'overrides',
                            ...result,
                        });
                    } else {
                        report.errors.push(`Overrides on "${modelName}": ${result.error}`);
                    }
                }
            } catch (err) {
                report.errors.push(`Fields on "${modelName}": ${err.message}`);
            }
        }

        return report;
    }

    /**
     * Load and apply a prolibu_setup.json file.
     *
     * @param {string} filePath - Absolute path to the JSON file
     * @returns {Promise<{ customObjects: object[], customFields: object[], errors: string[] }>}
     */
    async applySetupFromFile(filePath) {
        if (!fs.existsSync(filePath)) {
            return { customObjects: [], customFields: [], errors: [`File not found: ${filePath}`] };
        }

        let setupConfig;
        try {
            setupConfig = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (err) {
            return { customObjects: [], customFields: [], errors: [`Failed to parse ${filePath}: ${err.message}`] };
        }

        console.log(`📄 Applying setup from ${path.basename(filePath)}...`);
        return this.applySetup(setupConfig);
    }

    /**
     * Print a human-readable summary of an applySetup report.
     * @param {object} report - The report returned by applySetup()
     */
    static printReport(report) {
        console.log('');
        console.log('═══ Schema Setup Report ═══');

        if (report.customObjects.length > 0) {
            console.log('');
            console.log('Custom Objects:');
            for (const co of report.customObjects) {
                const icon = co.action === 'created' ? '🆕' : '🔄';
                console.log(`  ${icon} ${co.modelName} — ${co.action}`);
            }
        }

        if (report.customFields.length > 0) {
            console.log('');
            console.log('Custom Fields:');
            for (const cf of report.customFields) {
                const icon = cf.action === 'created' ? '🆕' : '🔄';
                const section = cf.section === 'overrides' ? ' (overrides)' : '';
                console.log(`  ${icon} ${cf.modelName}${section}: ${cf.fields.join(', ')}`);
            }
        }

        if (report.errors.length > 0) {
            console.log('');
            console.log('Errors:');
            for (const e of report.errors) {
                console.log(`  ❌ ${e}`);
            }
        }

        if (report.customObjects.length === 0 && report.customFields.length === 0 && report.errors.length === 0) {
            console.log('  (nothing to apply)');
        }

        console.log('');
    }
}

module.exports = SchemaSetup;
