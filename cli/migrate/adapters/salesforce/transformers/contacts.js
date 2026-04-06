/**
 * Base transformer: Salesforce Contact → Prolibu record.
 *
 * Override this per-domain by creating:
 *   accounts/<domain>/migrations/salesforce/transformers/contacts.js
 *
 * An override can be:
 *   - A full replacement function:  module.exports = (record) => ({ ... })
 *   - A decorator:                  module.exports = { extend: true, map: (record, base) => ({ ...base(record), extraField: ... }) }
 */
function transformContact(sfRecord) {
  return {
    refId: sfRecord.Id,
    firstName: sfRecord.FirstName || '',
    lastName: sfRecord.LastName || '',
    email: sfRecord.Email || '',
    phone: sfRecord.Phone || sfRecord.MobilePhone || '',
    title: sfRecord.Title || '',
    company: sfRecord.Account?.Name || '',
    source: 'salesforce',
  };
}

module.exports = transformContact;
