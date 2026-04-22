const SalesforceApi = require('../../../../lib/vendors/salesforce/SalesforceApi');

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
   * Uses cursor-based pagination (Id > lastId) to avoid Salesforce's 2000 OFFSET limit.
   *
   * @param {string} sobjectType
   * @param {object} options - Options object (not raw SOQL); limit per page defaults to 200
   * @returns {Promise<object[]>}
   */
  async fetchAll(sobjectType, options = {}) {
    const batchSize = options.limit || 200;
    let allRecords = [];
    let lastId = null;

    // Ensure Id is in the select fields for cursor pagination
    let select = options.select || 'Id';
    if (!/\bId\b/i.test(select)) {
      select = `Id, ${select}`;
    }

    while (true) {
      const queryOpts = { ...options, select, limit: batchSize, sort: 'Id ASC', page: 1 };
      if (lastId) {
        queryOpts.Id = { $gt: lastId };
      }
      const batch = await this.fetch(sobjectType, queryOpts);
      if (!batch || batch.length === 0) break;
      allRecords = allRecords.concat(batch);
      lastId = batch[batch.length - 1].Id;
      if (batch.length < batchSize) break; // last page
    }

    return allRecords;
  }

  /**
   * List all available SObjects in the org (global describe).
   * Delegates to SalesforceApi.describeGlobal().
   *
   * @returns {Promise<object[]>} Array of sobject descriptor stubs
   */
  async describeGlobal() {
    return this.api.describeGlobal();
  }

  /**
   * Execute a raw SOQL query against Salesforce.
   * Delegates to SalesforceApi.query().
   *
   * @param {string} soql - Raw SOQL query string
   * @returns {Promise<{ data: object[], pagination: object }>}
   */
  async query(soql) {
    return this.api.query(soql);
  }

  /**
   * Describe a single SObject in full (fields, relationships, etc).
   * Delegates to SalesforceApi.describeSObject().
   *
   * @param {string} sobjectName - e.g. 'Contact', 'ClienteVIP__c'
   * @returns {Promise<object>} Full describe result
   */
  async describeSObject(sobjectName) {
    return this.api.describeSObject(sobjectName);
  }

  /**
   * List all Apex Classes using Tooling API.
   * Delegates to SalesforceApi.listApexClasses().
   *
   * @returns {Promise<object[]>} Array of ApexClass metadata
   */
  async listApexClasses() {
    return this.api.listApexClasses();
  }

  /**
   * List all Apex Triggers using Tooling API.
   * Delegates to SalesforceApi.listApexTriggers().
   *
   * @returns {Promise<object[]>} Array of ApexTrigger metadata
   */
  async listApexTriggers() {
    return this.api.listApexTriggers();
  }

  /**
   * Fetch the full source body of an Apex Class by ID.
   * Delegates to SalesforceApi.fetchApexClassBody().
   *
   * @param {string} classId - Salesforce ApexClass Id (e.g. '01p...')
   * @returns {Promise<string>} The Apex class source code
   */
  async fetchApexClassBody(classId) {
    return this.api.fetchApexClassBody(classId);
  }

  /**
   * Fetch the full source body of an Apex Trigger by ID.
   * Delegates to SalesforceApi.fetchApexTriggerBody().
   *
   * @param {string} triggerId - Salesforce ApexTrigger Id (e.g. '01q...')
   * @returns {Promise<string>} The Apex trigger source code
   */
  async fetchApexTriggerBody(triggerId) {
    return this.api.fetchApexTriggerBody(triggerId);
  }
}

module.exports = SalesforceAdapter;
