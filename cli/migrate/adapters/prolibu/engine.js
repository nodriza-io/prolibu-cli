'use strict';

const credentialStore = require('../../shared/credentialStore');
const ProlibuWriter = require('../../shared/ProlibuWriter');
const logger = require('../../shared/migrationLogger');
const discoverPhase = require('./phases/discover');
const scaffoldPhase = require('./phases/scaffold');
const migratePhase = require('./phases/migrate');

/**
 * Entity definitions for Prolibu → Prolibu migration.
 * Since both sides use the same schema, the mapping is 1:1.
 * Each entity has a base transformer that strips system fields and resolves refs.
 */
const ENTITY_DEFINITIONS = {
  stages: {
    source: 'stage',
    target: 'stage',
    idField: 'refId',
    enabled: true,
    baseTransformer: () => require('./transformers/stage'),
  },
  companies: {
    source: 'company',
    target: 'company',
    idField: 'refId',
    enabled: true,
    baseTransformer: () => require('./transformers/company'),
  },
  contacts: {
    source: 'contact',
    target: 'contact',
    idField: 'refId',
    enabled: true,
    baseTransformer: () => require('./transformers/contact'),
  },
  products: {
    source: 'product',
    target: 'product',
    idField: 'refId',
    enabled: true,
    baseTransformer: () => require('./transformers/product'),
  },
  pricebooks: {
    source: 'pricebook',
    target: 'pricebook',
    idField: 'refId',
    enabled: true,
    baseTransformer: () => require('./transformers/pricebook'),
  },
  pricebookentries: {
    source: 'pricebookentry',
    target: 'pricebookentry',
    idField: 'refId',
    enabled: true,
    baseTransformer: () => require('./transformers/pricebookentry'),
  },
  deals: {
    source: 'deal',
    target: 'deal',
    idField: 'refId',
    enabled: true,
    baseTransformer: () => require('./transformers/deal'),
  },
};

const ENTITY_ORDER = ['stages', 'companies', 'contacts', 'products', 'pricebooks', 'pricebookentries', 'deals'];

/**
 * Ordered phases for Prolibu → Prolibu migration.
 */
const PHASES = [
  {
    name: 'discover',
    description: 'Fetch custom objects, custom fields, and scripts from source Prolibu',
    execute: async (context) => discoverPhase(context),
  },
  {
    name: 'scaffold',
    description: 'Sync custom fields and custom objects from source to destination',
    execute: async (context) => scaffoldPhase(context),
  },
  {
    name: 'migrate',
    description: 'Fetch records from source Prolibu, transform, and write to destination',
    execute: async (context) => migratePhase(context),
  },
];

/**
 * Run one or more phases for a Prolibu → Prolibu migration.
 *
 * @param {object}   opts
 * @param {string}   opts.domain         - Destination domain
 * @param {string}   opts.apiKey         - Destination API key
 * @param {string[]} [opts.phases]       - Phase names to run (default: all)
 * @param {string[]} [opts.entities]     - Entity keys to migrate (default: all)
 * @param {boolean}  [opts.dryRun]       - If true, nothing is written
 * @param {boolean}  [opts.force]        - Re-migrate already-mapped records
 * @param {Function} [opts.onProgress]
 * @param {Function} [opts.onEntityResult]
 */
async function run({ domain, apiKey, phases: phaseFilter, entities, dryRun = false, force = false, onProgress, onEntityResult }) {
  const credentials = credentialStore.getCredentials(domain, 'prolibu');
  if (!credentials) {
    console.error(`❌ No source Prolibu credentials found for domain "${domain}".`);
    console.error(`   Run: prolibu migrate prolibu configure --domain ${domain}`);
    process.exit(1);
  }

  const { sourceDomain, sourceApiKey } = credentials;

  const toRun = phaseFilter?.length
    ? PHASES.filter((p) => phaseFilter.includes(p.name))
    : PHASES;

  if (!toRun.length) {
    const available = PHASES.map((p) => p.name).join(', ');
    console.error(`❌ No matching phases found. Available: ${available}`);
    process.exit(1);
  }

  // Resolve entities — expand 'all' or default to full order
  const resolvedEntities = !entities || entities.includes('all')
    ? ENTITY_ORDER
    : entities;

  // Shared context – preserve previous entity results across runs
  const log = logger.readLog(domain, 'prolibu') || logger.createLog();
  log.started = new Date().toISOString();
  log.completed = null;
  log.dryRun = dryRun;

  const needsWriter = toRun.some((p) => p.name === 'migrate');
  let writer;

  if (needsWriter) {
    writer = new ProlibuWriter({ domain, apiKey, dryRun });
    console.log(`📤 Destination: ${domain}`);
    console.log(`📥 Source: ${sourceDomain}`);

    // Health check
    try {
      await writer.healthCheck();
      console.log('✅ Destination Prolibu is reachable');
    } catch (err) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
    console.log('');
  }

  const context = {
    domain,
    apiKey,
    sourceDomain,
    sourceApiKey,
    entities: resolvedEntities,
    writer,
    log,
    entityDefinitions: ENTITY_DEFINITIONS,
    batchSize: 100,
    concurrency: 8,
    batchDelay: 200,
    recordDelay: 0,
    maxRetries: 5,
    cooldownMs: 30000,
    consecutiveErrorsBeforeCooldown: 3,
    errorThreshold: 20,
    dryRun,
    force,
    onProgress,
    onEntityResult,
  };

  for (const phase of toRun) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🚀 Phase: ${phase.name}`);
    console.log(`   ${phase.description}`);
    console.log(`${'─'.repeat(60)}\n`);
    await phase.execute(context);
  }

  // Finalize log
  logger.finalizeLog(domain, 'prolibu', log);
  logger.printSummary(log);

  console.log('✅ All phases complete.\n');
  return log;
}

module.exports = { run, PHASES };
