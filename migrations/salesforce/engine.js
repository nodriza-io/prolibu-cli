const path = require('path');
const SalesforceAdapter = require('./SalesforceAdapter');
const ProlibuWriter = require('../shared/ProlibuWriter');
const credentialStore = require('../shared/credentialStore');
const logger = require('../shared/migrationLogger');

/**
 * Entity definitions: maps entity key → Salesforce SObject + base transformer + Prolibu model
 */
const ENTITY_DEFINITIONS = {
  contacts: {
    sobject: 'Contact',
    prolibuModel: 'Contact',
    idField: 'externalId',
    baseTransformer: () => require('./transformers/contacts'),
    defaultSelect: 'Id, FirstName, LastName, Email, Phone, MobilePhone, Title, Account.Name',
  },
  products: {
    sobject: 'Product2',
    prolibuModel: 'Product',
    idField: 'externalId',
    baseTransformer: () => require('./transformers/products'),
    defaultSelect: 'Id, Name, Description, ProductCode, IsActive',
  },
  accounts: {
    sobject: 'Account',
    prolibuModel: 'Company',
    idField: 'externalId',
    baseTransformer: () => require('./transformers/accounts'),
    defaultSelect: 'Id, Name, Industry, Phone, Website, BillingCity, BillingCountry',
  },
};

/**
 * Resolve the transformer for an entity, merging domain override if present.
 *
 * Override types:
 *   - Full replacement:  module.exports = (record) => ({ ... })
 *   - Decorator:        module.exports = { extend: true, map: (record, base) => ({ ...base(record), extra: ... }) }
 *
 * @param {string} domain
 * @param {string} entityKey
 * @param {Function} baseTransformer
 * @returns {Function}
 */
function resolveTransformer(domain, entityKey, baseTransformer) {
  const override = credentialStore.loadTransformerOverride(domain, 'salesforce', entityKey);
  if (!override) return baseTransformer;

  if (typeof override === 'function') {
    // Full replacement
    return override;
  }

  if (override.extend === true && typeof override.map === 'function') {
    // Decorator: wraps the base
    return (record) => override.map(record, baseTransformer);
  }

  console.warn(`[engine] ⚠️  Override for "${entityKey}" in ${domain} has an unrecognized format. Using base transformer.`);
  return baseTransformer;
}

/**
 * Run the migration engine for a given domain and set of entities.
 *
 * @param {object} options
 * @param {string} options.domain       - Prolibu domain
 * @param {string} options.apiKey       - Prolibu API key
 * @param {string[]} options.entities   - Entity keys to migrate (e.g. ['contacts', 'products'])
 * @param {boolean} [options.dryRun]    - If true, nothing is written to Prolibu
 *
 * @returns {Promise<object>} - Final migration log
 */
async function run({ domain, apiKey, entities, dryRun = false }) {
  const credentials = credentialStore.getCredentials(domain, 'salesforce');
  if (!credentials) {
    throw new Error(`No Salesforce credentials found for domain "${domain}". Run: prolibu migrate salesforce configure --domain ${domain}`);
  }

  const domainConfig = credentialStore.getConfig(domain, 'salesforce') || {};
  const entityConfig = domainConfig.entities || {};
  const batchSize = domainConfig.batchSize || 200;

  const adapter = new SalesforceAdapter(credentials);
  const writer = new ProlibuWriter({ domain, apiKey, dryRun });

  console.log(`🔗 Connecting to Salesforce (${credentials.instanceUrl})...`);
  await adapter.authenticate();
  console.log('✅ Salesforce authenticated');
  console.log('');

  const log = logger.createLog();
  log.dryRun = dryRun;

  for (const entityKey of entities) {
    const definition = ENTITY_DEFINITIONS[entityKey];
    if (!definition) {
      console.warn(`⚠️  Unknown entity "${entityKey}", skipping.`);
      continue;
    }

    // Check if entity is disabled in domain config
    const cfg = entityConfig[entityKey];
    if (cfg && cfg.enabled === false) {
      console.log(`⏭️  ${entityKey}: disabled in config.json, skipping`);
      continue;
    }

    console.log(`📦 Migrating ${entityKey}...`);

    const transformer = resolveTransformer(domain, entityKey, definition.baseTransformer());

    // Build fetch options; use raw SOQL when a filter is configured for this entity
    let records;
    if (cfg?.filter) {
      const soql = `SELECT ${definition.defaultSelect} FROM ${definition.sobject} WHERE ${cfg.filter} LIMIT ${batchSize}`;
      const result = await adapter.api.find(definition.sobject, soql);
      records = result?.data || [];
    } else {
      records = await adapter.fetchAll(definition.sobject, {
        select: definition.defaultSelect,
        limit: batchSize,
      });
    }
    console.log(`   Fetched ${records.length} records from Salesforce`);

    const transformed = records.map(transformer);

    const result = await writer.writeBatch(definition.prolibuModel, transformed, {
      idField: definition.idField,
    });

    logger.recordEntityResult(log, entityKey, result);
    console.log(`   ✅ ${result.migrated} migrated, ⏭️ ${result.skipped} skipped, ❌ ${result.errors.length} errors`);
  }

  logger.finalizeLog(domain, 'salesforce', log);
  logger.printSummary(log);

  return log;
}

module.exports = { run, ENTITY_DEFINITIONS };
