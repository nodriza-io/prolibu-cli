'use strict';

/**
 * Prolibu CRM metadata for the generic migration UI.
 *
 * Enables account-to-account migrations: source Prolibu → destination Prolibu.
 * Discovery is driven entirely by the source account's OpenAPI specification.
 */

exports.label = 'Prolibu';

/**
 * Default entity mapping (Prolibu → Prolibu — 1:1 by default).
 * Used by the Schema Map page to show recommended mappings.
 */
exports.entityMapping = {
  contact:       { prolibu: 'contact',       notes: 'People / leads' },
  deal:          { prolibu: 'deal',           notes: 'Sales opportunities' },
  company:       { prolibu: 'company',        notes: 'Companies / accounts' },
  product:       { prolibu: 'product',        notes: 'Product catalog' },
  quote:         { prolibu: 'quote',          notes: 'Commercial proposals' },
  invoice:       { prolibu: 'invoice',        notes: 'Invoices' },
  task:          { prolibu: 'task',           notes: 'Tasks and to-dos' },
  note:          { prolibu: 'note',           notes: 'Notes attached to records' },
  user:          { prolibu: 'user',           notes: 'Internal users' },
  campaign:      { prolibu: 'campaign',       notes: 'Marketing campaigns' },
};

exports.adapterModule = null; // no external adapter needed — uses ProlibuApi directly

/**
 * Test connectivity to the source Prolibu account.
 * Called by the migration UI when adapterModule is null.
 */
exports.testConnection = async function testConnection(creds) {
  if (!creds?.sourceDomain || !creds?.sourceApiKey) {
    throw new Error('Missing sourceDomain or sourceApiKey');
  }
  const ProlibuApi = require('../../../../lib/vendors/prolibu/ProlibuApi');
  await new ProlibuApi({ domain: creds.sourceDomain, apiKey: creds.sourceApiKey })
    .findOne('user', 'me');
};

/**
 * Credential keys required for this CRM (source Prolibu account).
 */
exports.credentialFields = ['sourceDomain', 'sourceApiKey'];
