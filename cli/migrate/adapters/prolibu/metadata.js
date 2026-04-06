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
 * Credential keys required for this CRM (source Prolibu account).
 */
exports.credentialFields = ['sourceDomain', 'sourceApiKey'];
