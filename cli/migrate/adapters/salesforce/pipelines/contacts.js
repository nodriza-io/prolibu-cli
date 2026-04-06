'use strict';

const ContactMap = require('../../../../../lib/vendors/salesforce/maps/ContactMap');

/**
 * Default Salesforce → Prolibu pipeline for the 'contacts' entity.
 * Applied to ALL domains unless overridden by:
 *   accounts/<domain>/migrations/salesforce/pipelines/contacts.js
 *
 * Steps:
 *   base           — engine injects the yaml/base transformer here
 *   normalizeFields — fixes country/state values that SF sends as full strings:
 *                    - address.country: "United States" → "US"
 *                    - address.state:   "Texas"         → "TX"
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
                    const stateCode = ContactMap.transforms['address.state'](
                        record['address.state'],
                        { MailingCountry: origCountry }
                    );
                    if (stateCode !== undefined) record['address.state'] = stateCode;
                }

                // Country: full name → ISO code
                if (origCountry) {
                    const countryCode = ContactMap.transforms['address.country'](origCountry);
                    if (countryCode !== undefined) record['address.country'] = countryCode;
                }

                return record;
            },
        },
    ],
};
