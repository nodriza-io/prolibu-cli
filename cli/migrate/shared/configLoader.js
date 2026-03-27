'use strict';

const fs = require('fs');
const path = require('path');

const ACCOUNTS_DIR = path.join(process.cwd(), 'accounts');
const ADAPTERS_DIR = path.join(__dirname, '..', 'adapters');
const GLOBAL_TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

const CONFIG_FILES = ['schema.json', 'mappings.json', 'pipelines.json', 'transforms.json'];

// ─── Path helpers ──────────────────────────────────────────────

function domainDir(domain, crm) {
    return path.join(ACCOUNTS_DIR, domain, 'migrations', crm);
}

function crmTemplatesDir(crm) {
    return path.join(ADAPTERS_DIR, crm, 'templates');
}

function resolveConfigPath(domain, crm, filename) {
    // 1. Domain-level config (highest priority)
    const domainPath = path.join(domainDir(domain, crm), filename);
    if (fs.existsSync(domainPath)) {
        return { path: domainPath, isTemplate: false };
    }
    // 2. CRM-specific template (e.g. adapters/salesforce/templates/)
    const crmPath = path.join(crmTemplatesDir(crm), filename);
    if (fs.existsSync(crmPath)) {
        return { path: crmPath, isTemplate: true };
    }
    // 3. Global fallback template
    const globalPath = path.join(GLOBAL_TEMPLATES_DIR, filename);
    if (fs.existsSync(globalPath)) {
        return { path: globalPath, isTemplate: true };
    }
    return { path: null, isTemplate: false };
}

// ─── Raw loader ────────────────────────────────────────────────

/**
 * Read and parse a JSON file. Returns null if not found.
 * @param {string} filePath
 * @returns {object|null}
 */
function readConfig(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
}

/**
 * Write an object as JSON to a file, creating dirs as needed.
 * @param {string} filePath
 * @param {object} data
 */
function writeConfig(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Domain-level loaders (with template fallback) ─────────────

/**
 * Load schema.json for a domain/crm.
 * Falls back to template if domain-specific file doesn't exist.
 * @returns {{ data: object, source: string, isTemplate: boolean }}
 */
function loadSchema(domain, crm) {
    const resolved = resolveConfigPath(domain, crm, 'schema.json');
    const data = readConfig(resolved.path);
    validateSchema(data, resolved.path);
    return { data, source: resolved.path, isTemplate: resolved.isTemplate };
}

/**
 * Load mappings.json for a domain/crm.
 * @returns {{ data: object, source: string, isTemplate: boolean }}
 */
function loadMappings(domain, crm) {
    const resolved = resolveConfigPath(domain, crm, 'mappings.json');
    const data = readConfig(resolved.path);
    validateMappings(data, resolved.path);
    return { data, source: resolved.path, isTemplate: resolved.isTemplate };
}

/**
 * Load pipelines.json for a domain/crm.
 * @returns {{ data: object, source: string, isTemplate: boolean }}
 */
function loadPipelines(domain, crm) {
    const resolved = resolveConfigPath(domain, crm, 'pipelines.json');
    const data = readConfig(resolved.path);
    validatePipelines(data, resolved.path);
    return { data, source: resolved.path, isTemplate: resolved.isTemplate };
}

/**
 * Load transforms.json for a domain/crm.
 * @returns {{ data: object, source: string, isTemplate: boolean }}
 */
function loadTransforms(domain, crm) {
    const resolved = resolveConfigPath(domain, crm, 'transforms.json');
    const data = readConfig(resolved.path);
    return { data, source: resolved.path, isTemplate: resolved.isTemplate };
}

/**
 * Load ALL four config files at once.
 * @returns {{ schema, mappings, pipelines, transforms }}
 */
function loadAll(domain, crm) {
    return {
        schema: loadSchema(domain, crm),
        mappings: loadMappings(domain, crm),
        pipelines: loadPipelines(domain, crm),
        transforms: loadTransforms(domain, crm),
    };
}

// ─── Validators ────────────────────────────────────────────────

function validateSchema(data, filePath) {
    if (!data) throw new ConfigError('schema.json not found', filePath);
    if (!data.entities || typeof data.entities !== 'object') {
        throw new ConfigError('schema.json must have an "entities" object', filePath);
    }
    for (const [key, entity] of Object.entries(data.entities)) {
        if (!entity.source) throw new ConfigError(`Entity "${key}" missing required "source" field`, filePath);
        if (!entity.target) throw new ConfigError(`Entity "${key}" missing required "target" field`, filePath);
    }
}

function validateMappings(data, filePath) {
    if (!data) throw new ConfigError('mappings.json not found', filePath);
    if (!data.entities || typeof data.entities !== 'object') {
        throw new ConfigError('mappings.json must have an "entities" object', filePath);
    }
    for (const [key, entity] of Object.entries(data.entities)) {
        if (!Array.isArray(entity.fields)) {
            throw new ConfigError(`Entity "${key}" in mappings.json must have a "fields" array`, filePath);
        }
        for (const field of entity.fields) {
            if (!field.from) throw new ConfigError(`Entity "${key}" has a field mapping missing "from"`, filePath);
            if (!field.to) throw new ConfigError(`Entity "${key}" has a field mapping missing "to"`, filePath);
        }
    }
}

function validatePipelines(data, filePath) {
    if (!data) throw new ConfigError('pipelines.json not found', filePath);
    if (!data.pipeline) throw new ConfigError('pipelines.json must have a "pipeline" section', filePath);
    if (!Array.isArray(data.pipeline.order) || !data.pipeline.order.length) {
        throw new ConfigError('pipeline.order must be a non-empty array', filePath);
    }
    // Check for duplicates in order
    const seen = new Set();
    for (const entity of data.pipeline.order) {
        if (seen.has(entity)) {
            console.warn(`⚠️  Duplicate entity "${entity}" in pipeline.order (${filePath})`);
        }
        seen.add(entity);
    }
    // Check for duplicates within flow steps
    if (Array.isArray(data.pipeline.flow)) {
        const flowSeen = new Set();
        for (const step of data.pipeline.flow) {
            for (const entity of step.entities || []) {
                if (flowSeen.has(entity)) {
                    console.warn(`⚠️  Duplicate entity "${entity}" across flow steps (${filePath})`);
                }
                flowSeen.add(entity);
            }
        }
    }
}

// ─── Custom error ──────────────────────────────────────────────

class ConfigError extends Error {
    constructor(message, filePath) {
        super(`Config Error: ${message}${filePath ? ` (${filePath})` : ''}`);
        this.name = 'ConfigError';
        this.filePath = filePath;
    }
}

// ─── Derived helpers (convenience for the engine) ──────────────

/**
 * Build ENTITY_DEFINITIONS-compatible structure from JSON config.
 *
 * @param {string} domain
 * @param {string} crm
 * @returns {{ entityDefinitions: object, entityOrder: string[], batchSize: number }}
 */
function buildEngineConfig(domain, crm) {
    const { schema, mappings, pipelines, transforms } = loadAll(domain, crm);

    const entityDefinitions = {};

    for (const [key, schemaEntity] of Object.entries(schema.data.entities)) {
        const mappingEntity = mappings.data.entities?.[key] || { fields: [] };
        const transformEntity = transforms.data?.entities?.[key] || { transforms: [] };

        // Auto-generate select from mapping fields if not explicitly set in schema
        let select = schemaEntity.select || '';
        if (!select && mappingEntity.fields?.length) {
            const fromFields = mappingEntity.fields
                .map(f => f.from)
                .filter(Boolean);
            select = [...new Set(fromFields)].join(', ');
        }

        entityDefinitions[key] = {
            sobject: schemaEntity.source,
            prolibuModel: schemaEntity.target,
            idField: schemaEntity.idField || 'externalId',
            enabled: schemaEntity.enabled !== false,
            defaultSelect: select,
            filters: schemaEntity.filters || null,
            fieldMappings: mappingEntity.fields,
            staticFields: mappingEntity.static || {},
            transforms: transformEntity.transforms || [],
            join: schemaEntity.join || null,
            joinedFieldMappings: mappingEntity.joinedFields || null,
        };
    }

    const pipelineConfig = pipelines.data.pipeline;
    const entityOrder = pipelineConfig.order || Object.keys(entityDefinitions);
    const batchSize = pipelineConfig.batchSize || 200;
    const concurrency = pipelineConfig.concurrency || 1;
    const onError = pipelineConfig.onError || 'skip';

    // Cross-validate: warn about entities in pipeline that don't exist in schema
    for (const name of entityOrder) {
        if (!entityDefinitions[name]) {
            console.warn(`⚠️  Entity "${name}" is in pipeline.order but not defined in schema.json — it will be skipped during migration.`);
        }
    }

    // Warn if standalone lineitems + opportunities with joins are both enabled
    const lineitemsDef = entityDefinitions['lineitems'];
    const opportunitiesDef = entityDefinitions['opportunities'];
    if (lineitemsDef?.enabled && opportunitiesDef?.enabled && opportunitiesDef?.join?.length) {
        const hasLineItemJoin = opportunitiesDef.join.some(j => j.as === 'lineItems');
        if (hasLineItemJoin && entityOrder.includes('lineitems')) {
            console.warn('⚠️  "lineitems" is enabled as a standalone entity, but "opportunities" already imports line items via join. This may cause duplicate data. Disable one of them in schema.json or remove "lineitems" from pipeline.order.');
        }
    }

    // Warn if standalone quotes is enabled — Quote data is consumed via the opportunities join
    const quotesDef = entityDefinitions['quotes'];
    if (quotesDef?.enabled && opportunitiesDef?.enabled && opportunitiesDef?.join?.length) {
        const hasQuoteJoin = opportunitiesDef.join.some(j => j.as === 'quote');
        if (hasQuoteJoin && entityOrder.includes('quotes')) {
            console.warn('⚠️  "quotes" is enabled as a standalone entity, but "opportunities" already imports quote data via join (Quote → proposal.quote.*). Prolibu has no standalone "quote" model — this entity will fail. Remove "quotes" from pipeline.order or disable it in schema.json.');
        }
    }

    const phases = (pipelines.data.phases || []).map(p => ({
        key: p.key,
        label: p.label,
        description: p.description,
    }));

    return {
        entityDefinitions,
        entityOrder,
        batchSize,
        concurrency,
        onError,
        phases,
        sources: {
            schema: { path: schema.source, isTemplate: schema.isTemplate },
            mappings: { path: mappings.source, isTemplate: mappings.isTemplate },
            pipelines: { path: pipelines.source, isTemplate: pipelines.isTemplate },
            transforms: { path: transforms.source, isTemplate: transforms.isTemplate },
        },
    };
}

/**
 * Save field mappings for specific entities.
 * Merges the provided entity mappings into the existing mappings.json (or template).
 * Writes the result to the domain-specific mappings.json.
 *
 * @param {string} domain
 * @param {string} crm
 * @param {object} fieldMaps - Keyed by SF object name, e.g. { "Account": { "Id": "externalId", "Name": "companyName" } }
 *                             Fields can also be objects: { "Id": { to: "externalId", ref: "User" } }
 * @param {object} schema - schema.json data (to resolve SF object → entity key)
 * @returns {string} Path where mappings were saved
 */
function saveMappings(domain, crm, fieldMaps, schema) {
    // Load existing mappings (from domain or template)
    const existing = loadMappings(domain, crm);
    const mappingsData = { ...existing.data };
    if (!mappingsData.entities) mappingsData.entities = {};

    // Build a reverse map: SF object name → entity key from schema
    const sourceToKey = {};
    for (const [key, def] of Object.entries(schema?.entities || {})) {
        sourceToKey[def.source] = key;
    }

    // Merge each SF object's field map into the mappings
    for (const [sfObjectName, fieldMap] of Object.entries(fieldMaps)) {
        const entityKey = sourceToKey[sfObjectName];
        if (!entityKey) continue;

        // Convert { "Id": "externalId", "OwnerId": { to: "assignee", ref: "User" } }
        // → [{ from: "Id", to: "externalId" }, { from: "OwnerId", to: "assignee", ref: "User" }, ...]
        const fields = [];
        for (const [from, toVal] of Object.entries(fieldMap)) {
            if (!toVal) continue;
            if (typeof toVal === 'object' && toVal.to) {
                // Field with reference: { to: "assignee", ref: "User" }
                fields.push({
                    from,
                    to: toVal.to,
                    ...(toVal.ref ? { ref: toVal.ref } : {}),
                });
            } else {
                // Simple field: "externalId"
                fields.push({ from, to: toVal });
            }
        }

        // Preserve existing static fields and other properties
        const existingEntity = mappingsData.entities[entityKey] || {};
        mappingsData.entities[entityKey] = {
            ...existingEntity,
            fields,
        };
    }

    // Write to domain-specific path
    const targetPath = path.join(domainDir(domain, crm), 'mappings.json');
    writeConfig(targetPath, mappingsData);
    return targetPath;
}

/**
 * Build a transformer function from JSON field mappings + transforms.
 * Returns a function with the same signature as the existing JS transformers:
 *   (crmRecord) => prolibuRecord
 *
 * @param {object} entityDef - Entity definition from buildEngineConfig
 * @returns {Function}
 */
function buildTransformer(entityDef) {
    const { fieldMappings, staticFields, transforms: transformRules, joinedFieldMappings } = entityDef;

    return function configTransformer(crmRecord) {
        const result = {};

        // 1. Apply field mappings (primary source)
        for (const mapping of fieldMappings) {
            let value = resolveField(crmRecord, mapping.from);

            // Apply default if value is null/undefined/empty
            if ((value === null || value === undefined || value === '') && mapping.default !== undefined) {
                value = mapping.default;
            }

            // Skip record if required field is missing
            if (mapping.required && (value === null || value === undefined || value === '')) {
                return null;
            }

            result[mapping.to] = value;
        }

        // 2. Apply static fields
        for (const [k, v] of Object.entries(staticFields)) {
            result[k] = v;
        }

        // 3. Apply joined field mappings (N:1 merge)
        if (joinedFieldMappings && crmRecord._joined) {
            for (const [alias, mappings] of Object.entries(joinedFieldMappings)) {
                const joinedData = crmRecord._joined[alias];
                if (!joinedData) continue;

                if (Array.isArray(joinedData)) {
                    const items = joinedData.map(item => {
                        const mapped = {};
                        for (const m of mappings) {
                            mapped[m.to] = resolveField(item, m.from) ?? (m.default !== undefined ? m.default : null);
                        }
                        return mapped;
                    });
                    result[`_joinedArray:${alias}`] = items;
                } else {
                    for (const m of mappings) {
                        const value = resolveField(joinedData, m.from) ?? (m.default !== undefined ? m.default : null);
                        result[m.to] = value;
                    }
                }
            }
        }

        // 4. Apply transforms
        for (const rule of transformRules) {
            applyTransform(result, rule);
        }

        return result;
    };
}

/**
 * Resolve a possibly dot-notated field from a CRM record.
 * e.g. "Account.Name" → record.Account?.Name
 */
function resolveField(record, fieldPath) {
    const parts = fieldPath.split('.');
    let current = record;
    for (const part of parts) {
        if (current == null) return null;
        current = current[part];
    }
    return current ?? null;
}

/**
 * Apply a single transform rule to a result record (mutates in place).
 */
function applyTransform(record, rule) {
    switch (rule.type) {
        case 'concat': {
            const values = (rule.fields || []).map(f => record[f] || '').filter(Boolean);
            record[rule.to] = values.join(rule.separator || ' ');
            break;
        }
        case 'lowercase':
            if (typeof record[rule.field] === 'string') record[rule.field] = record[rule.field].toLowerCase();
            break;
        case 'uppercase':
            if (typeof record[rule.field] === 'string') record[rule.field] = record[rule.field].toUpperCase();
            break;
        case 'trim':
            if (typeof record[rule.field] === 'string') record[rule.field] = record[rule.field].trim();
            break;
        case 'replace':
            if (typeof record[rule.field] === 'string') {
                record[rule.field] = record[rule.field].replace(new RegExp(rule.pattern, 'g'), rule.replacement || '');
            }
            break;
        case 'map':
            if (rule.values && record[rule.field] in rule.values) {
                record[rule.field] = rule.values[record[rule.field]];
            }
            break;
        case 'default':
            if (record[rule.field] === null || record[rule.field] === undefined || record[rule.field] === '') {
                record[rule.field] = rule.value;
            }
            break;
        case 'template': {
            let tpl = rule.template || '';
            tpl = tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => record[key] || '');
            record[rule.to] = tpl;
            break;
        }
        case 'boolean': {
            const truthy = rule.truthy || ['true', '1', 'yes'];
            const val = String(record[rule.field] ?? '').toLowerCase();
            record[rule.field] = truthy.includes(val) || record[rule.field] === true;
            break;
        }
        case 'date':
            break;
        case 'divide': {
            const val = Number(record[rule.field]);
            if (!isNaN(val) && rule.by) {
                record[rule.field] = val / rule.by;
            }
            break;
        }
        case 'expr': {
            // Evaluate JavaScript expression with `record` in scope
            try {
                // eslint-disable-next-line no-new-func
                const fn = new Function('record', `return (${rule.expr});`);
                record[rule.field] = fn(record);
            } catch (e) {
                console.warn(`⚠️  Transform expr error on "${rule.field}": ${e.message}`);
            }
            break;
        }
        default:
            break;
    }
}

// ─── Scaffold helpers ──────────────────────────────────────────

/**
 * Copy all template config files to a domain/crm directory.
 * Does NOT overwrite existing files.
 *
 * @param {string} domain
 * @param {string} crm
 * @returns {string[]} List of files created
 */
function scaffoldConfig(domain, crm) {
    const dir = domainDir(domain, crm);
    fs.mkdirSync(dir, { recursive: true });
    const created = [];

    for (const file of CONFIG_FILES) {
        const dest = path.join(dir, file);
        if (fs.existsSync(dest)) continue;
        // Prefer CRM-specific template, fall back to global
        const crmSrc = path.join(crmTemplatesDir(crm), file);
        const globalSrc = path.join(GLOBAL_TEMPLATES_DIR, file);
        const src = fs.existsSync(crmSrc) ? crmSrc : globalSrc;
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, dest);
        created.push(dest);
    }
    return created;
}

/**
 * Check which config files exist for a domain/crm.
 * @returns {{ file: string, exists: boolean, isTemplate: boolean }[]}
 */
function checkConfigStatus(domain, crm) {
    return CONFIG_FILES.map(file => {
        const resolved = resolveConfigPath(domain, crm, file);
        return {
            file,
            exists: !!resolved.path,
            isTemplate: resolved.isTemplate,
            path: resolved.path,
        };
    });
}

/**
 * Get the raw JSON content of a config file (for API/UI display).
 */
function getRawConfig(domain, crm, filename) {
    const resolved = resolveConfigPath(domain, crm, filename);
    if (!resolved.path) return null;
    return {
        content: fs.readFileSync(resolved.path, 'utf8'),
        path: resolved.path,
        isTemplate: resolved.isTemplate,
    };
}

/**
 * Save raw JSON content to a domain-specific file.
 * Validates that the content is valid JSON before writing.
 */
function saveRawConfig(domain, crm, filename, content) {
    if (!CONFIG_FILES.includes(filename)) {
        throw new ConfigError(`Unknown config file: ${filename}. Expected one of: ${CONFIG_FILES.join(', ')}`);
    }
    try {
        JSON.parse(content);
    } catch (e) {
        throw new ConfigError(`Invalid JSON syntax: ${e.message}`);
    }
    const filePath = path.join(domainDir(domain, crm), filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
}

// ─── Exports ───────────────────────────────────────────────────

module.exports = {
    // Path helpers
    domainDir,
    resolveConfigPath,
    CONFIG_FILES,

    // Backward-compatible aliases
    resolveYamlPath: resolveConfigPath,
    YAML_FILES: CONFIG_FILES,

    // Raw I/O
    readConfig,
    writeConfig,
    readYaml: readConfig,
    writeYaml: writeConfig,

    // Domain-level loaders
    loadSchema,
    loadMappings,
    loadPipelines,
    loadTransforms,
    loadAll,

    // Engine bridge
    buildEngineConfig,
    buildTransformer,

    // Mappings persistence
    saveMappings,

    // Scaffold & status
    scaffoldConfig,
    scaffoldYaml: scaffoldConfig,
    checkConfigStatus,
    checkYamlStatus: checkConfigStatus,
    getRawConfig,
    getRawYaml: getRawConfig,
    saveRawConfig,
    saveRawYaml: saveRawConfig,

    // Error class
    ConfigError,
    YamlConfigError: ConfigError,
};
