const path = require('path');
const ProlibuApi = require('../../lib/vendors/prolibu/ProlibuApi');

/**
 * Batch writer for Prolibu that wraps ProlibuApi.
 * Handles upsert logic (findOneOrCreate / update) and dry-run mode.
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
  }

  /**
   * Write a batch of records to a Prolibu model.
   * Uses findOneOrCreate when an externalId field is provided, otherwise plain create.
   *
   * @param {string} model         - Prolibu model name (e.g. 'Contact', 'Product')
   * @param {object[]} records     - Array of transformed records ready to write
   * @param {object} [options]
   * @param {string} [options.idField] - Field in the record used as external unique key
   *
   * @returns {Promise<{ migrated: number, skipped: number, errors: string[] }>}
   */
  async writeBatch(model, records, { idField } = {}) {
    const result = { migrated: 0, skipped: 0, errors: [] };

    for (const record of records) {
      if (this.dryRun) {
        console.log(`[dry-run] Would write to ${model}:`, JSON.stringify(record).slice(0, 120));
        result.migrated++;
        continue;
      }

      try {
        if (idField && record[idField]) {
          await this.api.findOneOrCreate(
            model,
            record[idField],
            { field: idField },
            record
          );
        } else {
          await this.api.create(model, record);
        }
        result.migrated++;
      } catch (err) {
        const msg = err?.response?.data?.message || err.message || String(err);
        result.errors.push(`[${record[idField] || '?'}] ${msg}`);
        result.skipped++;
      }
    }

    return result;
  }
}

module.exports = ProlibuWriter;
