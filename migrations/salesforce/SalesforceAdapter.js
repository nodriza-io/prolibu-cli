const SalesforceApi = require('../../../lib/vendors/salesforce/SalesforceApi');

/**
 * Thin wrapper around SalesforceApi scoped to CLI usage (local mode, credentials from file).
 * Provides entity-level fetch methods used by the migration engine.
 */
class SalesforceAdapter {
  /**
   * @param {object} credentials
   * @param {string} credentials.instanceUrl
   * @param {string} credentials.clientKey
   * @param {string} credentials.clientSecret
   * @param {string} [credentials.apiVersion='58.0']
   */
  constructor({ instanceUrl, clientKey, clientSecret, apiVersion = '58.0' }) {
    this.api = new SalesforceApi({
      instanceUrl,
      customerKey: clientKey,
      customerSecret: clientSecret,
      apiVersion,
    });
  }

  /**
   * Authenticate with Salesforce (client credentials OAuth2 flow)
   */
  async authenticate() {
    await this.api.authenticate();
  }

  /**
   * Fetch records from a Salesforce SObject using the find() method.
   * Supports raw SOQL string or options object (select, limit, page, sort, + where fields).
   *
   * @param {string} sobjectType  - e.g. 'Contact', 'Product2', 'Account'
   * @param {string|object} options - Raw SOQL string or options object
   * @returns {Promise<object[]>}  - Array of Salesforce records
   */
  async fetch(sobjectType, options = {}) {
    const result = await this.api.find(sobjectType, options);
    return result?.data || [];
  }

  /**
   * Convenience: fetch ALL records across all pages.
   * Re-fetches with increasing page numbers until empty.
   *
   * @param {string} sobjectType
   * @param {object} options - Options object (not raw SOQL); limit per page defaults to 200
   * @returns {Promise<object[]>}
   */
  async fetchAll(sobjectType, options = {}) {
    const batchSize = options.limit || 200;
    let page = 1;
    let allRecords = [];

    while (true) {
      const batch = await this.fetch(sobjectType, { ...options, limit: batchSize, page });
      if (!batch || batch.length === 0) break;
      allRecords = allRecords.concat(batch);
      if (batch.length < batchSize) break; // last page
      page++;
    }

    return allRecords;
  }
}

module.exports = SalesforceAdapter;
