'use strict';

const ContactMap = require('../../../../../lib/vendors/salesforce/maps/ContactMap');

/**
 * Default Salesforce → Prolibu pipeline for the 'leads' entity.
 * Applied to ALL domains unless overridden by:
 *   accounts/<domain>/migrations/salesforce/pipelines/leads.js
 *
 * Steps:
 *   base           — engine injects the yaml/base transformer here
 *   normalizeFields — fixes country/state values that SF sends as full strings:
 *                    - address.country: "Colombia" → "CO"
 *                    - address.state:   "Antioquia" → state code
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
                    record['address.country'] = countryCode;
                    if (origCountry) record['customFields.originalCountry'] = origCountry;
                }

                return record;
            },
        },
    ],
};
