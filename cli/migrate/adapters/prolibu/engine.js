'use strict';

const credentialStore = require('../../shared/credentialStore');
const discoverPhase = require('./phases/discover');

/**
 * Ordered phases for Prolibu → Prolibu migration.
 * More phases (scaffold, migrate) can be added following the same pattern.
 */
const PHASES = [
  {
    name: 'discover',
    description: 'Introspect source Prolibu — fetch spec, entities, custom fields, COBs',
    execute: async (context) => discoverPhase(context),
  },
];

/**
 * Run one or more phases for a Prolibu → Prolibu migration.
 *
 * @param {object}   opts
 * @param {string}   opts.domain         - Destination domain (artifacts are stored here)
 * @param {string}   opts.apiKey         - Destination Prolibu API key
 * @param {string[]} [opts.phases]       - Phase names to run (default: all)
 * @param {boolean}  [opts.withCount]    - Pass --count to discover phase
 */
async function run({ domain, apiKey, phases: phaseFilter, withCount = false }) {
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

  const context = { domain, apiKey, sourceDomain, sourceApiKey, withCount };

  for (const phase of toRun) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🚀 Phase: ${phase.name}`);
    console.log(`   ${phase.description}`);
    console.log(`${'─'.repeat(60)}\n`);
    await phase.execute(context);
  }

  console.log('✅ All phases complete.\n');
}

module.exports = { run, PHASES };
