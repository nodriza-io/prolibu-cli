'use strict';

const CompanyMap = require('../../../../../lib/vendors/salesforce/maps/CompanyMap');

/**
 * Default Salesforce → Prolibu pipeline for the 'accounts' entity.
 * Applied to ALL domains unless overridden by:
 *   accounts/<domain>/migrations/salesforce/pipelines/accounts.js
 *
 * Steps:
 *   base           — engine injects the yaml/base transformer here
 *   normalizeFields — fixes values that SF sends as full strings but Prolibu
 *                    expects as ISO codes or ObjectIds:
 *                    - address.country: "United States" → "US"
 *                    - address.state:   "Texas"         → "TX"
 *                    - industry:        nullify strings that are not ObjectIds
 */
module.exports = {
    steps: [
        { name: 'base' },
        {
            name: 'normalizeFields',
            after: (record) => {
                const origCountry = record['address.country'];
                const origState = record['address.state'];
                const origCity = record['address.city'];
                const origStreet = record['address.street'];
                const origPostalCode = record['address.zip'];

                // Always preserve original Salesforce address values in customFields (open text)
                if (origCountry) record['customFields.originalCountry'] = origCountry;
                if (origState) record['customFields.originalState'] = origState;
                if (origCity) record['customFields.originalCity'] = origCity;
                if (origStreet) record['customFields.originalStreet'] = origStreet;
                if (origPostalCode) record['customFields.originalPostalCode'] = origPostalCode;

                // State first — needs the original full country name before remapping
                if (origState && origCountry) {
                    const stateCode = CompanyMap.transforms['address.state'](
                        origState,
                        { BillingCountry: origCountry }
                    );
                    if (stateCode !== undefined) record['address.state'] = stateCode;
                }

                // Country: full name → ISO code (undefined if not found)
                if (origCountry) {
                    const countryCode = CompanyMap.transforms['address.country'](origCountry);
                    record['address.country'] = countryCode; // may be undefined
                }

                // Industry: nullify if not a valid Prolibu ObjectId (24-char hex)
                if (record.industry && !/^[0-9a-f]{24}$/i.test(record.industry)) {
                    record.industry = null;
                }

                return record;
            },
        },
    ],
};
