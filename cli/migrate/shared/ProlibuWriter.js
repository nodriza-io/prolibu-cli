const path = require('path');
const cliProgress = require('cli-progress');
const ProlibuApi = require('../../../lib/vendors/prolibu/ProlibuApi');
const SchemaSetup = require('./SchemaSetup');

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

    // Validate that the idField exists on the Prolibu model before processing the batch
    if (idField && !this.dryRun) {
      try {
        const res = await this.api.axios.get(`${this.api.prefix}/service/getSchema`, {
          params: { modelName: model, type: 'attrs' },
        });
        const attrs = res.data || {};
        if (!attrs[idField]) {
          throw new Error(`El modelo "${model}" en Prolibu no tiene el campo "${idField}". Créalo antes de migrar.`);
        }
      } catch (err) {
        if (err.message.includes('no tiene el campo')) throw err;
        // If schema check fails (network, auth), let it through — the writes will fail on their own
        console.log(`   ⚠️  No se pudo validar el schema de "${model}": ${err.message}`);
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
        if (idField && record[idField]) {
          // Use findOneOrCreate: update if exists, create if not
          const { created } = await this.api.findOneOrCreate(
            model,
            record[idField],
            { field: idField },
            record
          );
          if (created) {
            result.created++;
          } else {
            result.updated++;
          }
        } else {
          await this.api.create(model, record);
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
