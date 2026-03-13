'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ACCOUNTS_DIR = path.join(process.cwd(), 'accounts');
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

const YAML_FILES = ['schema.yml', 'mappings.yml', 'pipelines.yml', 'transforms.yml'];

// ─── Path helpers ──────────────────────────────────────────────

/**
 * Directory where domain-specific YAML config lives.
 * accounts/<domain>/migrations/<crm>/
 */
function domainDir(domain, crm) {
    return path.join(ACCOUNTS_DIR, domain, 'migrations', crm);
}

/**
 * Resolve a YAML file path.
 * If the domain-specific file exists, return it.
 * Otherwise return the template path.
 *
 * @param {string} domain
 * @param {string} crm
 * @param {string} filename - e.g. 'schema.yml'
 * @returns {{ path: string, isTemplate: boolean }}
 */
function resolveYamlPath(domain, crm, filename) {
    const domainPath = path.join(domainDir(domain, crm), filename);
    if (fs.existsSync(domainPath)) {
        return { path: domainPath, isTemplate: false };
    }
    const templatePath = path.join(TEMPLATES_DIR, filename);
    if (fs.existsSync(templatePath)) {
        return { path: templatePath, isTemplate: true };
    }
    return { path: null, isTemplate: false };
}

// ─── Raw loader ────────────────────────────────────────────────

/**
 * Read and parse a YAML file. Returns null if not found.
 * @param {string} filePath
 * @returns {object|null}
 */
function readYaml(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    return yaml.load(content) || {};
}

/**
 * Write an object as YAML to a file, creating dirs as needed.
 * @param {string} filePath
 * @param {object} data
 */
function writeYaml(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = yaml.dump(data, { lineWidth: 120, noRefs: true, quotingType: '"' });
    fs.writeFileSync(filePath, content, 'utf8');
}

// ─── Domain-level loaders (with template fallback) ─────────────

/**
 * Load schema.yml for a domain/crm.
 * Falls back to template if domain-specific file doesn't exist.
 * @returns {{ data: object, source: string, isTemplate: boolean }}
 */
function loadSchema(domain, crm) {
    const resolved = resolveYamlPath(domain, crm, 'schema.yml');
    const data = readYaml(resolved.path);
    validateSchema(data, resolved.path);
    return { data, source: resolved.path, isTemplate: resolved.isTemplate };
}

/**
 * Load mappings.yml for a domain/crm.
 * @returns {{ data: object, source: string, isTemplate: boolean }}
 */
function loadMappings(domain, crm) {
    const resolved = resolveYamlPath(domain, crm, 'mappings.yml');
    const data = readYaml(resolved.path);
    validateMappings(data, resolved.path);
    return { data, source: resolved.path, isTemplate: resolved.isTemplate };
}

/**
 * Load pipelines.yml for a domain/crm.
 * @returns {{ data: object, source: string, isTemplate: boolean }}
 */
function loadPipelines(domain, crm) {
    const resolved = resolveYamlPath(domain, crm, 'pipelines.yml');
    const data = readYaml(resolved.path);
    validatePipelines(data, resolved.path);
    return { data, source: resolved.path, isTemplate: resolved.isTemplate };
}

/**
 * Load transforms.yml for a domain/crm.
 * @returns {{ data: object, source: string, isTemplate: boolean }}
 */
function loadTransforms(domain, crm) {
    const resolved = resolveYamlPath(domain, crm, 'transforms.yml');
    const data = readYaml(resolved.path);
    return { data, source: resolved.path, isTemplate: resolved.isTemplate };
}

/**
 * Load ALL four YAML configs at once.
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
    if (!data) throw new YamlConfigError('schema.yml not found', filePath);
    if (!data.entities || typeof data.entities !== 'object') {
        throw new YamlConfigError('schema.yml must have an "entities" object', filePath);
    }
    for (const [key, entity] of Object.entries(data.entities)) {
        if (!entity.source) throw new YamlConfigError(`Entity "${key}" missing required "source" field`, filePath);
        if (!entity.target) throw new YamlConfigError(`Entity "${key}" missing required "target" field`, filePath);
    }
}

function validateMappings(data, filePath) {
    if (!data) throw new YamlConfigError('mappings.yml not found', filePath);
    if (!data.entities || typeof data.entities !== 'object') {
        throw new YamlConfigError('mappings.yml must have an "entities" object', filePath);
    }
    for (const [key, entity] of Object.entries(data.entities)) {
        if (!Array.isArray(entity.fields)) {
            throw new YamlConfigError(`Entity "${key}" in mappings.yml must have a "fields" array`, filePath);
        }
        for (const field of entity.fields) {
            if (!field.from) throw new YamlConfigError(`Entity "${key}" has a field mapping missing "from"`, filePath);
            if (!field.to) throw new YamlConfigError(`Entity "${key}" has a field mapping missing "to"`, filePath);
        }
    }
}

function validatePipelines(data, filePath) {
    if (!data) throw new YamlConfigError('pipelines.yml not found', filePath);
    if (!data.pipeline) throw new YamlConfigError('pipelines.yml must have a "pipeline" section', filePath);
    if (!Array.isArray(data.pipeline.order) || !data.pipeline.order.length) {
        throw new YamlConfigError('pipeline.order must be a non-empty array', filePath);
    }
}

// ─── Custom error ──────────────────────────────────────────────

class YamlConfigError extends Error {
    constructor(message, filePath) {
        super(`YAML Config Error: ${message}${filePath ? ` (${filePath})` : ''}`);
        this.name = 'YamlConfigError';
        this.filePath = filePath;
    }
}

// ─── Derived helpers (convenience for the engine) ──────────────

/**
 * Build ENTITY_DEFINITIONS-compatible structure from YAML config.
 * This bridges the YAML config with the existing engine interface,
 * so we don't need to rewrite the engine all at once.
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

        entityDefinitions[key] = {
            sobject: schemaEntity.source,
            prolibuModel: schemaEntity.target,
            idField: schemaEntity.idField || 'externalId',
            enabled: schemaEntity.enabled !== false,
            defaultSelect: schemaEntity.select || '',
            filters: schemaEntity.filters || null,
            fieldMappings: mappingEntity.fields,
            staticFields: mappingEntity.static || {},
            transforms: transformEntity.transforms || [],
            // N:1 join support
            join: schemaEntity.join || null,
            joinedFieldMappings: mappingEntity.joinedFields || null,
        };
    }

    const pipelineConfig = pipelines.data.pipeline;
    const entityOrder = pipelineConfig.order || Object.keys(entityDefinitions);
    const batchSize = pipelineConfig.batchSize || 200;
    const concurrency = pipelineConfig.concurrency || 1;
    const onError = pipelineConfig.onError || 'skip';

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
 * Build a transformer function from YAML field mappings + transforms.
 * Returns a function with the same signature as the existing JS transformers:
 *   (crmRecord) => prolibuRecord
 *
 * @param {object} entityDef - Entity definition from buildEngineConfig
 * @returns {Function}
 */
function buildTransformer(entityDef) {
    const { fieldMappings, staticFields, transforms: transformRules, joinedFieldMappings } = entityDef;

    return function yamlTransformer(crmRecord) {
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
                return null; // signals: skip this record
            }

            result[mapping.to] = value;
        }

        // 2. Apply static fields
        for (const [k, v] of Object.entries(staticFields)) {
            result[k] = v;
        }

        // 3. Apply joined field mappings (N:1 merge)
        //    Joined records are attached to crmRecord._joined.<alias> by migrate phase
        if (joinedFieldMappings && crmRecord._joined) {
            for (const [alias, mappings] of Object.entries(joinedFieldMappings)) {
                const joinedData = crmRecord._joined[alias];
                if (!joinedData) continue;

                if (Array.isArray(joinedData)) {
                    // Strategy "all" → map each item, produce array
                    const items = joinedData.map(item => {
                        const mapped = {};
                        for (const m of mappings) {
                            mapped[m.to] = resolveField(item, m.from) ?? (m.default !== undefined ? m.default : null);
                        }
                        return mapped;
                    });
                    // Find a common prefix to nest under (e.g. proposal.quote.lineItems)
                    // If all "to" fields are flat, store as array under the alias
                    result[`_joinedArray:${alias}`] = items;
                } else {
                    // Strategy "latest" / "primary" → single object, map each field
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
            // Basic date pass-through — extend with date-fns if needed
            break;
        case 'custom':
            if (rule.expression && rule.field) {
                try {
                    const value = record[rule.field];
                    // eslint-disable-next-line no-eval
                    record[rule.field] = eval(rule.expression);
                } catch { /* ignore eval errors */ }
            }
            break;
        default:
            break;
    }
}

// ─── Scaffold helpers ──────────────────────────────────────────

/**
 * Copy all template YAML files to a domain/crm directory.
 * Does NOT overwrite existing files.
 *
 * @param {string} domain
 * @param {string} crm
 * @returns {string[]} List of files created
 */
function scaffoldYaml(domain, crm) {
    const dir = domainDir(domain, crm);
    fs.mkdirSync(dir, { recursive: true });
    const created = [];

    for (const file of YAML_FILES) {
        const dest = path.join(dir, file);
        if (fs.existsSync(dest)) continue;
        const src = path.join(TEMPLATES_DIR, file);
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, dest);
        created.push(dest);
    }
    return created;
}

/**
 * Check which YAML files exist for a domain/crm.
 * @returns {{ file: string, exists: boolean, isTemplate: boolean }[]}
 */
function checkYamlStatus(domain, crm) {
    return YAML_FILES.map(file => {
        const resolved = resolveYamlPath(domain, crm, file);
        return {
            file,
            exists: !!resolved.path,
            isTemplate: resolved.isTemplate,
            path: resolved.path,
        };
    });
}

/**
 * Get the raw YAML content of a file (for API/UI display).
 */
function getRawYaml(domain, crm, filename) {
    const resolved = resolveYamlPath(domain, crm, filename);
    if (!resolved.path) return null;
    return {
        content: fs.readFileSync(resolved.path, 'utf8'),
        path: resolved.path,
        isTemplate: resolved.isTemplate,
    };
}

/**
 * Save raw YAML content to a domain-specific file.
 * Validates that the content is valid YAML before writing.
 */
function saveRawYaml(domain, crm, filename, content) {
    if (!YAML_FILES.includes(filename)) {
        throw new YamlConfigError(`Unknown YAML file: ${filename}. Expected one of: ${YAML_FILES.join(', ')}`);
    }
    // Validate YAML syntax
    try {
        yaml.load(content);
    } catch (e) {
        throw new YamlConfigError(`Invalid YAML syntax: ${e.message}`);
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
    resolveYamlPath,
    YAML_FILES,

    // Raw I/O
    readYaml,
    writeYaml,

    // Domain-level loaders
    loadSchema,
    loadMappings,
    loadPipelines,
    loadTransforms,
    loadAll,

    // Engine bridge
    buildEngineConfig,
    buildTransformer,

    // Scaffold & status
    scaffoldYaml,
    checkYamlStatus,
    getRawYaml,
    saveRawYaml,

    // Error class
    YamlConfigError,
};
