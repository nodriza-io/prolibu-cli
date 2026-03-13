const path = require('path');
const ProlibuApi = require('../../lib/vendors/prolibu/ProlibuApi');
const SchemaSetup = require('./SchemaSetup');

/**
 * Batch writer for Prolibu that wraps ProlibuApi.
 * Handles upsert logic (update if exists, create if not) and dry-run mode.
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
   * Uses upsert when an externalId field is provided (update if exists, create if not), 
   * otherwise plain create.
   *
   * @param {string} model         - Prolibu model name (e.g. 'Contact', 'Product')
   * @param {object[]} records     - Array of transformed records ready to write
   * @param {object} [options]
   * @param {string} [options.idField] - Field in the record used as external unique key
   *
   * @returns {Promise<{ migrated: number, updated: number, created: number, skipped: number, errors: string[] }>}
   */
  async writeBatch(model, records, { idField } = {}) {
    const result = { migrated: 0, updated: 0, created: 0, skipped: 0, errors: [] };

    // Log target domain for first record batch
    if (records.length > 0 && !this.dryRun) {
      console.log(`📤 Writing ${records.length} ${model} records to https://${this.domain}/v2/${model}`);
    }

    for (const record of records) {
      // Skip null/undefined records (transformer might return null for filtered records)
      if (!record || typeof record !== 'object') {
        result.skipped++;
        continue;
      }

      if (this.dryRun) {
        console.log(`[dry-run] Would write to ${model}:`, JSON.stringify(record).slice(0, 120));
        result.migrated++;
        continue;
      }

      try {
        if (idField && record[idField]) {
          // Use upsert: update if exists, create if not
          const { created } = await this.api.upsert(
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
    }

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
