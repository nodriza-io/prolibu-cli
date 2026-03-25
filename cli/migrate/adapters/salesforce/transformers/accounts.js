/**
 * Base transformer: Salesforce Account → Prolibu record.
 *
 * Override this per-domain by creating:
 *   accounts/<domain>/migrations/salesforce/transformers/accounts.js
 */
function transformAccount(sfRecord) {
  return {
    externalId: sfRecord.Id,
    name: sfRecord.Name || '',
    industry: sfRecord.Industry || '',
    phone: sfRecord.Phone || '',
    website: sfRecord.Website || '',
    billingCity: sfRecord.BillingCity || '',
    billingCountry: sfRecord.BillingCountry || '',
    source: 'salesforce',
  };
}

module.exports = transformAccount;
