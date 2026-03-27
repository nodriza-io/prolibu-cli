const path = require('path');
const fs = require('fs');
const cliProgress = require('cli-progress');
const ProlibuApi = require('../../../lib/vendors/prolibu/ProlibuApi');
const SchemaSetup = require('./SchemaSetup');

// Fields that are internal/meta and should never be validated against the schema
const META_FIELDS = new Set([
  '_id', '_source', '_joined', '__v', 'createdAt', 'updatedAt',
  'createdBy', 'updatedBy', 'status',
]);

/**
 * Get top-level keys from a record (dot-notation prefix = first segment only).
 * Excludes meta/internal fields.
 */
function getRecordFieldKeys(record) {
  return Object.keys(record)
    .map(k => k.includes('.') ? k.split('.')[0] : k)
    .filter(k => !META_FIELDS.has(k) && !k.startsWith('_'))
    .filter((k, i, arr) => arr.indexOf(k) === i); // unique
}

/**
 * Expand dot-notation keys into nested objects.
 * e.g. { "proposal.quote.lineItems": [...] } → { proposal: { quote: { lineItems: [...] } } }
 */
function expandDotNotation(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!key.includes('.')) {
      result[key] = value;
      continue;
    }
    const parts = key.split('.');
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] === undefined || current[parts[i]] === null) {
        current[parts[i]] = {};
      } else if (typeof current[parts[i]] !== 'object' || Array.isArray(current[parts[i]])) {
        // Don't overwrite non-object values
        break;
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }
  return result;
}

/**
 * Batch writer for Prolibu that wraps ProlibuApi.
 * Handles findOneOrCreate logic (update if exists, create if not) and dry-run mode.
 * Also provides convenience methods for schema setup (custom fields & custom objects).
 */
class ProlibuWriter {
  /**
   * @param {object} options
   * @param {string} options.domain  - Prolibu domain (e.g. dev10.prolibu.com)
   * @param {string} options.apiKey  - Prolibu API key
   * @param {boolean} [options.dryRun=false] - If true, no writes are performed
   */
  constructor({ domain, apiKey, dryRun = false }) {
    this.domain = domain;
    this.dryRun = dryRun;
    this.api = new ProlibuApi({ domain, apiKey });
    this._schemaSetup = new SchemaSetup({ domain, apiKey, dryRun });
    this._openApiSpec = null; // Cache for OpenAPI specification
  }

  /**
   * Write a batch of records to a Prolibu model.
   * Uses findOneOrCreate when an externalId field is provided (update if exists, create if not), 
   * otherwise plain create.
   *
   * @param {string} model         - Prolibu model name (e.g. 'Contact', 'Product')
   * @param {object[]} records     - Array of transformed records ready to write
   * @param {object} [options]
   * @param {string} [options.idField] - Field in the record used as external unique key
   * @param {Function} [options.onProgress] - Callback(progressData) called after each record
   *
   * @returns {Promise<{ migrated: number, updated: number, created: number, skipped: number, errors: string[] }>}
   */
  async writeBatch(model, records, { idField, onProgress } = {}) {
    const result = { migrated: 0, updated: 0, created: 0, skipped: 0, errors: [] };

    // Log target domain for first record batch
    if (records.length > 0 && !this.dryRun) {
      console.log(`📤 Writing ${records.length} ${model} records to https://${this.domain}/v2/${model}`);
    }

    // ── Schema validation ─────────────────────────────────────
    // Fetch OpenAPI spec once and extract model schema for validation
    let schemaAttrs = null;
    if (records.length > 0) {
      try {
        // Use cached OpenAPI specification or fetch it
        if (!this._openApiSpec) {
          const res = await this.api.axios.get(`${this.api.prefix}/openapi/specification`);
          this._openApiSpec = res.data || {};
        }
        const schemas = this._openApiSpec?.components?.schemas || {};

        // Find schema by model name (case-insensitive)
        const modelLower = model.toLowerCase();
        const schemaKey = Object.keys(schemas).find(k => k.toLowerCase() === modelLower);

        if (schemaKey && schemas[schemaKey]?.properties) {
          schemaAttrs = schemas[schemaKey].properties;
        }
      } catch (err) {
        console.log(`   ⚠️  No se pudo validar el schema de "${model}": ${err.message}`);
      }
    }

    if (schemaAttrs) {
      // 1. Validate idField exists
      if (idField && !schemaAttrs[idField]) {
        throw new Error(`El modelo "${model}" en Prolibu no tiene el campo "${idField}". Créalo antes de migrar.`);
      }

      // 2. Validate all fields in the sample record exist in the schema
      const sample = records.find(r => r && typeof r === 'object');
      if (sample) {
        const recordKeys = getRecordFieldKeys(sample);
        const unknownFields = recordKeys.filter(k => !(k in schemaAttrs));

        if (unknownFields.length > 0) {
          // Cross-reference with local CustomField file to give a better hint
          const cfPath = path.join(
            process.cwd(), 'accounts', this.domain, 'objects', 'CustomField', `${model}.json`
          );
          let localOnly = [];
          if (fs.existsSync(cfPath)) {
            try {
              const cfDef = JSON.parse(fs.readFileSync(cfPath, 'utf8'));
              const localFieldNames = Object.keys(cfDef.customFields || {});
              localOnly = unknownFields.filter(f => localFieldNames.includes(f));
            } catch { /* ignore parse error */ }
          }

          const notLocal = unknownFields.filter(f => !localOnly.includes(f));
          const lines = [
            `\n❌ El modelo "${model}" en Prolibu no reconoce los siguientes campos:`,
            `   ${unknownFields.map(f => `"${f}"`).join(', ')}`,
            '',
          ];

          if (localOnly.length) {
            lines.push(
              `   ⚠️  Estos campos están declarados en objects/CustomField/${model}.json`,
              `       pero no se han pusheado a Prolibu todavía:`,
              `       ${localOnly.map(f => `"${f}"`).join(', ')}`,
              '',
              `   👉  Corre primero:  ./prolibu objects push --domain ${this.domain}`,
            );
          }

          if (notLocal.length) {
            lines.push(
              `   ⚠️  Estos campos no existen ni en disco ni en Prolibu:`,
              `       ${notLocal.map(f => `"${f}"`).join(', ')}`,
              '',
              `   👉  Opciones:`,
              `       A) Agrégalos en accounts/${this.domain}/objects/CustomField/${model}.json`,
              `          y luego corre:  ./prolibu objects push --domain ${this.domain}`,
              `       B) Créalos directamente en Prolibu (UI o API)`,
              `       C) Excluye estos campos del transformer devolviendo undefined para ellos`,
            );
          }

          throw new Error(lines.join('\n'));
        }
      }
    }

    const isCLI = !onProgress;
    let bar;
    if (isCLI) {
      bar = new cliProgress.SingleBar({
        format: `   {bar} {percentage}% | {value}/{total} | ➕ {created} created | 🔄 {updated} updated | ❌ {errors} errors`,
        barCompleteChar: '█',
        barIncompleteChar: '░',
        hideCursor: true,
      });
      bar.start(records.length, 0, { created: 0, updated: 0, errors: 0 });
    }

    const total = records.length;
    let processed = 0;

    for (const record of records) {
      // Skip null/undefined records (transformer might return null for filtered records)
      if (!record || typeof record !== 'object') {
        result.skipped++;
        processed++;
        if (bar) bar.increment(1, { created: result.created, updated: result.updated, errors: result.errors.length });
        if (onProgress) onProgress({ processed, total, ...result });
        continue;
      }

      if (this.dryRun) {
        result.migrated++;
        processed++;
        if (bar) bar.increment(1, { created: result.created, updated: result.updated, errors: result.errors.length });
        if (onProgress) onProgress({ processed, total, ...result });
        continue;
      }

      try {
        // Expand dot-notation keys to nested objects before sending to API
        const expanded = expandDotNotation(record);

        if (idField && record[idField]) {
          // Use findOneOrCreate: update if exists, create if not
          const { created } = await this.api.findOneOrCreate(
            model,
            record[idField],
            { field: idField },
            expanded
          );
          if (created) {
            result.created++;
          } else {
            result.updated++;
          }
        } else {
          await this.api.create(model, expanded);
          result.created++;
        }
        result.migrated++;
      } catch (err) {
        const msg = err?.response?.data?.message || err.message || String(err);
        const recordId = record && record[idField] ? record[idField] : '?';
        result.errors.push(`[${recordId}] ${msg}`);
        result.skipped++;
      }
      processed++;
      if (bar) bar.increment(1, { created: result.created, updated: result.updated, errors: result.errors.length });
      if (onProgress) onProgress({ processed, total, ...result });
    }

    if (bar) bar.stop();

    return result;
  }

  // ── Schema setup convenience methods ────────────────────────

  /**
   * Access the underlying SchemaSetup instance for advanced operations.
   * @returns {SchemaSetup}
   */
  get schemaSetup() {
    return this._schemaSetup;
  }

  /**
   * Create custom fields on an existing Prolibu model.
   * Shortcut for `this.schemaSetup.createCustomFields(...)`.
   *
   * @param {string} modelName - Target model (e.g. 'Contact')
   * @param {object} fields    - Field definitions
   * @param {object} [options]
   * @returns {Promise<{ success: boolean, record?: object, error?: string }>}
   */
  async createCustomFields(modelName, fields, options) {
    return this._schemaSetup.createCustomFields(modelName, fields, options);
  }

  /**
   * Create a new Custom Object (COB) in Prolibu.
   * Shortcut for `this.schemaSetup.createCustomObject(...)`.
   *
   * @param {object} definition - COB definition with modelName + field definitions
   * @returns {Promise<{ success: boolean, record?: object, error?: string }>}
   */
  async createCustomObject(definition) {
    return this._schemaSetup.createCustomObject(definition);
  }

  /**
   * Apply a prolibu_setup.json configuration (custom objects + custom fields).
   * Shortcut for `this.schemaSetup.applySetup(...)`.
   *
   * @param {object} setupConfig - The setup configuration
   * @returns {Promise<{ customObjects: object[], customFields: object[], errors: string[] }>}
   */
  async applySetup(setupConfig) {
    return this._schemaSetup.applySetup(setupConfig);
  }
}

module.exports = ProlibuWriter;
