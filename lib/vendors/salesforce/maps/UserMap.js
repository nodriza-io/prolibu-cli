/**
 * Data mapping between Prolibu User and Salesforce User
 *
 * reverse: false (default) → Prolibu User → Salesforce User
 * reverse: true → Salesforce User → Prolibu User
 *
 * Role in deal migration:
 *   Deals reference an `assignee` (Prolibu User) resolved from the SF `OwnerId`.
 *   The migration engine matches records by `email` — both systems share email
 *   as the canonical unique identifier for people.
 */

module.exports = {
  // Basic mappings: prolibuField → salesforceField
  firstName:             'FirstName',
  lastName:              'LastName',
  email:                 'Email',
  jobTitle:              'Title',
  phone:                 'Phone',
  mobile:                'MobilePhone',

  // Address
  'address.street':      'Street',
  'address.city':        'City',
  'address.state':       'State',
  'address.postalCode':  'PostalCode',
  'address.country':     'Country',

  transforms: {
    // ── FORWARD TRANSFORMS (Prolibu → Salesforce) ────────────────────

    // Prolibu status 'Active'/'Deactivated' → SF IsActive boolean
    IsActive: (value) => {
      if (value === undefined || value === null) return undefined;
      return value === 'Active';
    },

    // ── REVERSE TRANSFORMS (Salesforce → Prolibu) ────────────────────

    // SF IsActive boolean → Prolibu status string
    status: (value) => {
      if (value === undefined || value === null) return undefined;
      return value === true ? 'Active' : 'Deactivated';
    },

    // Normalize address.postalCode (SF PostalCode is already a string)
    'address.postalCode': (value) => {
      if (!value) return undefined;
      return String(value).trim();
    },
  },
};
