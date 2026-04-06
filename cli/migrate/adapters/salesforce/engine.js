const path = require('path');
const SalesforceAdapter = require('./SalesforceAdapter');
const ProlibuWriter = require('../../shared/ProlibuWriter');
const credentialStore = require('../../shared/credentialStore');
const logger = require('../../shared/migrationLogger');
const yamlLoader = require('../../shared/configLoader');
const discoverPhase = require('./phases/discover');
const reviewPhase = require('./phases/review');
const scaffoldPhase = require('./phases/scaffold');
const migratePhase = require('./phases/migrate');

/**
 * Ordered phase definitions.
 * Each phase has a name, description, and an execute(context) function.
 */
const PHASES = [
  {
    name: 'discover',
    description: 'Introspect Salesforce — list all SObjects, fields, record counts, and Apex code',
    execute: async (context) => discoverPhase(context),
  },
  {
    name: 'review',
    description: 'Start interactive review UI (http://localhost:3721) — schema map, config builder, prolibu_setup export',
    execute: async (context) => reviewPhase(context),
  },
  {
    name: 'scaffold',
    description: 'Generate objects/Cob/ and objects/CustomField/ files from prolibu_setup.json',
    execute: async (context) => scaffoldPhase(context),
  },
  {
    name: 'migrate',
    description: 'Fetch records from Salesforce, transform, and write to Prolibu',
    execute: async (context) => migratePhase(context),
  },
];

/**
 * Legacy hardcoded entity definitions — kept as fallback.
 * The engine now prefers YAML-based config via yamlLoader.buildEngineConfig().
 * These are only used if YAML files are missing.
 */
const ENTITY_DEFINITIONS = {
  contacts: {
    sobject: 'Contact',
    prolibuModel: 'Contact',
    idField: 'refId',
    baseTransformer: () => require('./transformers/contacts'),
    defaultSelect: 'Id, FirstName, LastName, Email, Phone, MobilePhone, Title, Account.Name',
  },
  products: {
    sobject: 'Product2',
    prolibuModel: 'Product',
    idField: 'refId',
    baseTransformer: () => require('./transformers/products'),
    defaultSelect: 'Id, Name, Description, ProductCode, IsActive',
  },
  accounts: {
    sobject: 'Account',
    prolibuModel: 'Company',
    idField: 'refId',
    baseTransformer: () => require('./transformers/accounts'),
    defaultSelect: 'Id, Name, Industry, Phone, Website, BillingCity, BillingCountry',
  },
};

/**
 * Default entity order — used as fallback when YAML is not available.
 */
const ENTITY_ORDER = ['accounts', 'products', 'contacts'];

/**
 * Resolve entity definitions and order, preferring YAML config.
 * Falls back to hardcoded ENTITY_DEFINITIONS if YAML files are missing.
 */
function resolveConfig(domain) {
  try {
    const yamlConfig = yamlLoader.buildEngineConfig(domain, 'salesforce');
    console.log('📄 Configuration loaded from YAML files');

    // Merge YAML-based entity definitions with JS transformer fallback
    const entityDefs = {};
    for (const [key, def] of Object.entries(yamlConfig.entityDefinitions)) {
      entityDefs[key] = {
        ...def,
        // Build transformer from YAML mappings; fallback to JS transformer if available
        baseTransformer: () => {
          const yamlTransformer = yamlLoader.buildTransformer(def);
          // If there's also a domain-specific JS override, let it take precedence
          const jsOverride = credentialStore.loadTransformerOverride(domain, 'salesforce', key);
          if (jsOverride) {
            if (jsOverride.extend) {
              return (record) => jsOverride.map(record, yamlTransformer);
            }
            return jsOverride;
          }
          return yamlTransformer;
        },
      };
    }

    return {
      entityDefinitions: entityDefs,
      entityOrder: yamlConfig.entityOrder,
      batchSize: yamlConfig.batchSize,
    };
  } catch (e) {
    if (e.name === 'YamlConfigError') {
      console.log(`⚠️  YAML config issue: ${e.message}`);
      console.log('   Falling back to built-in entity definitions');
    }
    const domainConfig = credentialStore.getConfig(domain, 'salesforce') || {};
    return {
      entityDefinitions: ENTITY_DEFINITIONS,
      entityOrder: ENTITY_ORDER,
      batchSize: domainConfig.batchSize || 200,
    };
  }
}

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
 * @param {Function} [options.onProgress]  - Callback({ entity, processed, total, ...stats }) per record
 * @param {Function} [options.onEntityResult] - Callback(entityKey, result) per entity completion
 * @param {Function} [options.onDiscoverProgress] - Callback({ done, total }) per SObject described during discover
 *
 * @returns {Promise<object>} - Final migration log
 */
async function run({ domain, apiKey, entities, phases: phaseFilter, from, to, dryRun = false, withCount = false, force = false, onProgress, onEntityResult, onDiscoverProgress }) {

  // Resolve config from YAML (with fallback to hardcoded definitions)
  const resolved = resolveConfig(domain);
  const { entityDefinitions, entityOrder, batchSize, concurrency } = resolved;

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

  // Resolve entities — expand 'all' using order from config
  const resolvedEntities = entities.includes('all') ? entityOrder : entities;

  // Shared context passed to every phase
  let adapter;
  let writer;

  const log = logger.createLog();
  log.dryRun = dryRun;

  const needsSalesforce = phasesToRun.some((p) => ['discover', 'migrate'].includes(p.name));
  const needsWriter = phasesToRun.some((p) => p.name === 'migrate');

  if (needsSalesforce) {
    const credentials = credentialStore.getCredentials(domain, 'salesforce');
    if (!credentials) {
      throw new Error(`No Salesforce credentials found for domain "${domain}". Run: prolibu migrate salesforce configure --domain ${domain}`);
    }
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
    entityDefinitions,
    batchSize,
    concurrency,
    dryRun,
    withCount,
    force,
    onProgress,
    onEntityResult,
    onDiscoverProgress,
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
