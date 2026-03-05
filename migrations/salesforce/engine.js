const path = require('path');
const SalesforceAdapter = require('./SalesforceAdapter');
const ProlibuWriter = require('../shared/ProlibuWriter');
const credentialStore = require('../shared/credentialStore');
const logger = require('../shared/migrationLogger');
const discoverPhase = require('./phases/discover');
const reviewPhase = require('./phases/review');
const migratePhase = require('./phases/migrate');

/**
 * Ordered list of entities to migrate when running 'all'.
 * Reflects data dependencies: base objects first, dependent objects last.
 */
const ENTITY_ORDER = ['accounts', 'products', 'contacts'];

/**
 * Ordered phase definitions.
 * Each phase has a name, description, and an execute(context) function.
 */
const PHASES = [
  {
    name: 'discover',
    description: 'Introspect Salesforce — list all SObjects, fields and record counts',
    execute: async (context) => discoverPhase(context),
  },
  {
    name: 'review',
    description: 'Start interactive review UI (http://localhost:3721) — schema map, config builder, prolibu_setup export',
    execute: async (context) => reviewPhase(context),
  },
  {
    name: 'migrate',
    description: 'Fetch records from Salesforce, transform, and write to Prolibu',
    execute: async (context) => migratePhase(context),
  },
];

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
 * Run the migration engine.
 *
 * Orchestrates phases in order. Each phase receives a shared context object
 * containing the adapter, writer, logger, and resolved entity list.
 *
 * @param {object} options
 * @param {string}   options.domain       - Prolibu domain
 * @param {string}   options.apiKey       - Prolibu API key
 * @param {string[]} options.entities     - Entity keys to run in the migrate phase
 * @param {string[]} [options.phases]     - Phase names to run (default: all phases in order)
 * @param {number}   [options.from]       - Run phases from this index (1-based, inclusive)
 * @param {number}   [options.to]         - Run phases up to this index (1-based, inclusive)
 * @param {boolean}  [options.dryRun]     - If true, nothing is written to Prolibu
 * @param {boolean}  [options.withCount]   - Fetch record counts during discover phase (slower)
 *
 * @returns {Promise<object>} - Final migration log
 */
async function run({ domain, apiKey, entities, phases: phaseFilter, from, to, dryRun = false, withCount = false }) {
  const credentials = credentialStore.getCredentials(domain, 'salesforce');
  if (!credentials) {
    throw new Error(`No Salesforce credentials found for domain "${domain}". Run: prolibu migrate salesforce configure --domain ${domain}`);
  }

  const domainConfig = credentialStore.getConfig(domain, 'salesforce') || {};
  const batchSize = domainConfig.batchSize || 200;

  // Resolve which phases to run
  let phasesToRun = PHASES;

  if (phaseFilter && phaseFilter.length > 0) {
    phasesToRun = PHASES.filter((p) => phaseFilter.includes(p.name));
    if (phasesToRun.length === 0) {
      throw new Error(`No matching phases found for: ${phaseFilter.join(', ')}. Available: ${PHASES.map((p) => p.name).join(', ')}`);
    }
  } else if (from !== undefined || to !== undefined) {
    const fromIdx = (from ?? 1) - 1;
    const toIdx = (to ?? PHASES.length) - 1;
    phasesToRun = PHASES.slice(fromIdx, toIdx + 1);
  }

  // Resolve entities — expand 'all' using ENTITY_ORDER
  const resolvedEntities = entities.includes('all') ? ENTITY_ORDER : entities;

  // Shared context passed to every phase
  let adapter;
  let writer;

  const log = logger.createLog();
  log.dryRun = dryRun;

  const needsSalesforce = phasesToRun.some((p) => ['discover', 'migrate'].includes(p.name));
  const needsWriter = phasesToRun.some((p) => p.name === 'migrate');

  if (needsSalesforce) {
    adapter = new SalesforceAdapter(credentials);
    console.log(`🔗 Connecting to Salesforce (${credentials.instanceUrl})...`);
    await adapter.authenticate();
    console.log('✅ Salesforce authenticated');
    console.log('');
  }

  if (needsWriter) {
    writer = new ProlibuWriter({ domain, apiKey, dryRun });
  }

  const context = {
    domain,
    apiKey,
    entities: resolvedEntities,
    adapter,
    writer,
    log,
    entityDefinitions: ENTITY_DEFINITIONS,
    batchSize,
    dryRun,
    withCount,
  };

  // Execute each phase in order
  for (const phase of phasesToRun) {
    console.log(`▶  Phase: ${phase.name} — ${phase.description}`);
    console.log('');
    await phase.execute(context);
    console.log('');
  }

  if (needsWriter) {
    logger.finalizeLog(domain, 'salesforce', log);
    logger.printSummary(log);
  }

  return log;
}

module.exports = { run, ENTITY_DEFINITIONS, ENTITY_ORDER, PHASES };
