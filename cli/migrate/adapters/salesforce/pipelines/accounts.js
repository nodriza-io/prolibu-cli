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

                // State first — needs the original full country name before remapping
                if (record['address.state'] && origCountry) {
                    const stateCode = CompanyMap.transforms['address.state'](
                        record['address.state'],
                        { BillingCountry: origCountry }
                    );
                    if (stateCode !== undefined) record['address.state'] = stateCode;
                }

                // Country: full name → ISO code
                if (origCountry) {
                    const countryCode = CompanyMap.transforms['address.country'](origCountry);
                    if (countryCode !== undefined) record['address.country'] = countryCode;
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
