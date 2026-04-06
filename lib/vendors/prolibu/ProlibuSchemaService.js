'use strict';

/**
 * ProlibuSchemaService
 *
 * On-demand service for querying Prolibu entity schemas.
 * It can work in two modes:
 *
 *   1. **From local OpenAPI spec** – if the full spec was already fetched
 *      (e.g. at server startup), pass it in and the service will extract
 *      entity schemas from `components.schemas` and POST request bodies.
 *
 *   2. **Live from API** – if a domain + apiKey are provided the service
 *      can fetch schemas on demand and cache them for the lifetime of the
 *      process.
 *
 * Usage:
 *   const svc = new ProlibuSchemaService({ spec });          // offline
 *   const svc = new ProlibuSchemaService({ domain, apiKey }); // live
 *   const svc = new ProlibuSchemaService({ domain, apiKey, spec }); // both
 *
 *   const schema = await svc.getEntitySchema('company');
 *   const fields = await svc.getEntityFields('company');
 *   const list   = await svc.listEntities();
 */

const https = require('https');

class ProlibuSchemaService {
    /**
     * @param {object}  opts
     * @param {string}  [opts.domain]  - Prolibu domain for live queries
     * @param {string}  [opts.apiKey]  - Prolibu API key
     * @param {object}  [opts.spec]    - Full OpenAPI spec (if already fetched)
     */
    constructor({ domain, apiKey, spec } = {}) {
        this.domain = domain || null;
        this.apiKey = apiKey || null;
        this._spec = spec || null;
        this._cache = new Map();
    }

    // ─── Public API ──────────────────────────────────────

    /**
     * List all known Prolibu entity names.
     * @returns {Promise<string[]>}
     */
    async listEntities() {
        const spec = await this._ensureSpec();
        if (!spec?.paths) return [];

        const entities = new Set();
        for (const p of Object.keys(spec.paths)) {
            const m = p.match(/^\/v2\/([a-z][a-z0-9-]*)\/$/i);
            if (m) entities.add(m[1]);
        }
        return [...entities].sort();
    }

    /**
     * Get the full schema definition for an entity.
     * Returns the POST requestBody JSON schema plus any components schema.
     *
     * @param {string} entityName - e.g. 'company', 'contact', 'deal'
     * @returns {Promise<object|null>}  { properties, required, ... } or null
     */
    async getEntitySchema(entityName) {
        if (!entityName) return null;
        const key = entityName.toLowerCase();

        if (this._cache.has(key)) return this._cache.get(key);

        const spec = await this._ensureSpec();
        if (!spec) return null;

        // Try from POST requestBody (most reliable source of writable fields)
        const postPath = `/v2/${key}/`;
        const postOp = spec.paths?.[postPath]?.post;
        const bodySchema = postOp
            ?.requestBody?.content?.['application/json']?.schema || null;

        // Try from components.schemas
        const compSchema = this._findComponentSchema(spec, key);

        // Merge: POST body has the writable fields, component schema may have
        // additional metadata (descriptions, enums, etc.)
        const merged = this._mergeSchemas(bodySchema, compSchema);
        if (merged) this._cache.set(key, merged);
        return merged;
    }

    /**
     * Get a flat map of field paths → { type, description, enum? }.
     * Nested objects (e.g. address.street) are flattened with dot notation.
     *
     * @param {string} entityName
     * @returns {Promise<object|null>}  { fieldPath: { type, description, ... } }
     */
    async getEntityFields(entityName) {
        const schema = await this.getEntitySchema(entityName);
        if (!schema?.properties) return null;
        return this._flattenProperties(schema.properties);
    }

    /**
     * Force-refresh the spec by re-fetching from the API.
     * Only works if domain + apiKey are set.
     */
    async refreshSpec() {
        if (!this.domain || !this.apiKey) {
            throw new Error('Cannot refresh: no domain/apiKey configured');
        }
        this._spec = await this._fetchSpec();
        this._cache.clear();
        return this._spec;
    }

    /**
     * Replace the cached spec with a new one (e.g. after external refresh).
     * @param {object} spec
     */
    setSpec(spec) {
        this._spec = spec;
        this._cache.clear();
    }

    // ─── Private ─────────────────────────────────────────

    async _ensureSpec() {
        if (this._spec) return this._spec;
        if (this.domain && this.apiKey) {
            this._spec = await this._fetchSpec();
        }
        return this._spec;
    }

    _fetchSpec() {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: this.domain,
                path: '/v2/openapi/specification',
                headers: { 'x-api-key': this.apiKey, Accept: 'application/json' },
            };
            const req = https.get(options, (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error(`Bad JSON from openapi/specification: ${e.message}`)); }
                });
            });
            req.on('error', reject);
            req.setTimeout(20000, () => req.destroy(new Error('Spec fetch timeout')));
        });
    }

    _findComponentSchema(spec, entityKey) {
        const schemas = spec?.components?.schemas;
        if (!schemas) return null;
        // Try exact, PascalCase, case-insensitive
        if (schemas[entityKey]) return schemas[entityKey];
        const pascal = entityKey.charAt(0).toUpperCase() + entityKey.slice(1);
        if (schemas[pascal]) return schemas[pascal];
        const entry = Object.entries(schemas).find(
            ([k]) => k.toLowerCase() === entityKey,
        );
        return entry ? entry[1] : null;
    }

    _mergeSchemas(bodySchema, compSchema) {
        if (!bodySchema && !compSchema) return null;
        if (!bodySchema) return compSchema;
        if (!compSchema) return bodySchema;

        // Body schema takes priority for properties, merge descriptions from comp
        const merged = { ...bodySchema };
        if (compSchema.properties) {
            merged.properties = { ...compSchema.properties, ...bodySchema.properties };
        }
        return merged;
    }

    /**
     * Flatten nested property keys using dot notation.
     * e.g. { address: { properties: { street: ... } } } → { 'address.street': ... }
     */
    _flattenProperties(properties, prefix = '') {
        const result = {};
        for (const [key, val] of Object.entries(properties)) {
            const fullKey = prefix ? `${prefix}.${key}` : key;

            // Dot-notation keys from OpenAPI (e.g. "address.street" already flat)
            if (key.includes('.')) {
                result[key] = {
                    type: val?.type || 'string',
                    description: val?.description || '',
                    ...(val?.enum ? { enum: val.enum } : {}),
                };
                continue;
            }

            if (val?.type === 'object' && val?.properties) {
                Object.assign(result, this._flattenProperties(val.properties, fullKey));
            } else {
                result[fullKey] = {
                    type: val?.type || 'string',
                    description: val?.description || '',
                    ...(val?.enum ? { enum: val.enum } : {}),
                };
            }
        }
        return result;
    }
}

module.exports = ProlibuSchemaService;
