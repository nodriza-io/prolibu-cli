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
  const record = {
    refId: sfRecord.Id,
    firstName: sfRecord.FirstName || '',
    lastName: sfRecord.LastName || '',
    email: sfRecord.Email || '',
    jobTitle: sfRecord.Title || '',
    companyName: sfRecord.Account?.Name || '',
    source: 'salesforce',
  };

  // phones expects an array of objects
  const phone = sfRecord.Phone || sfRecord.MobilePhone || '';
  if (phone) {
    record.phones = [{ label: 'work', number: phone }];
  }

  return record;
}

module.exports = transformContact;
