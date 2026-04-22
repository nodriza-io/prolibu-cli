/**
 * Data mapping between Prolibu Company and Salesforce Account
 * 
 * reverse: false (default) → Prolibu Company → Salesforce Account
 * reverse: true → Salesforce Account → Prolibu Company
 */

const Countries = require('../dictionaries/Countries');
const isoCountries = require('i18n-iso-countries');

// Register Spanish and English locales
isoCountries.registerLocale(require('i18n-iso-countries/langs/es.json'));
isoCountries.registerLocale(require('i18n-iso-countries/langs/en.json'));

const States = {
  US: require('../dictionaries/StateUS'),
};

module.exports = {
  // Basic mappings: prolibuField → salesforceField
  companyName: 'Name',
  primaryPhone: 'Phone',
  website: 'Website',
  legalName: 'Tradestyle',
  assignee: 'OwnerId',

  // Nested address mappings
  'address.street': 'BillingStreet',
  'address.city': 'BillingCity',
  'address.state': 'BillingState',
  'address.postalCode': 'BillingPostalCode',
  'address.country': 'BillingCountry',
  'address.location.lat': 'BillingLatitude',
  'address.location.long': 'BillingLongitude',
  'locale.currency': 'CurrencyIsoCode',

  // Transformations
  transforms: {
    // FORWARD TRANSFORMS (Prolibu → Salesforce)

    // Transform for BillingStreet - combines street + neighborhood
    BillingStreet: (value, sourceData) => {
      if (!value) return value;

      // Combine street + neighborhood if exists
      const neighborhood = sourceData?.address?.neighborhood;
      if (neighborhood) {
        return `${value}, ${neighborhood}`;
      }

      return value;
    },

    // Transform for BillingCountry - normalize country codes using Countries dictionary
    BillingCountry: (value, sourceData) => {
      if (!value) return undefined;

      // Convert to uppercase for consistent lookup
      const upperValue = value.toString().toUpperCase();

      // Use Countries dictionary to normalize country codes
      // Return undefined if not found in dictionary to avoid Salesforce errors
      return Countries[upperValue] || undefined;
    },

    // Transform for BillingState - dynamic state handling based on country code
    BillingState: (value, sourceData) => {
      if (!value) return undefined; // No state value, unset the field

      // Get the country code from source data (already in international format)
      const countryCode = sourceData?.address?.country?.toUpperCase();
      if (!countryCode) return undefined; // No country, unset state

      // Check if we have a states dictionary for this country
      if (States[countryCode]) {
        // Use the states dictionary to normalize the state
        const upperState = value.toString().toUpperCase();
        // Return undefined if state not found in dictionary
        return States[countryCode][upperState] || undefined;
      }

      // No states dictionary for this country, unset the field to avoid Salesforce error
      return undefined;
    },

    // Transform for coordinates
    BillingLatitude: (value) => {
      if (!value || isNaN(value)) return null;
      return parseFloat(value);
    },

    BillingLongitude: (value) => {
      if (!value || isNaN(value)) return null;
      return parseFloat(value);
    },

    // REVERSE TRANSFORMS (Salesforce → Prolibu)

    // Reverse transform for address.street - extract street from combined value
    'address.street': (value) => {
      if (!value) return value;

      // If value contains comma, extract only the street part
      const commaIndex = value.indexOf(',');
      if (commaIndex > 0) {
        return value.substring(0, commaIndex).trim();
      }

      return value;
    },

    // Reverse transform for address.country - convert full country name back to code
    'address.country': (value) => {
      if (!value) return undefined;

      const normalized = value.toString().trim();
      const upperNormalized = normalized.toUpperCase();

      // Check if already a valid ISO alpha-2 code
      if (upperNormalized.length === 2 && isoCountries.isValid(upperNormalized)) {
        return upperNormalized;
      }

      // Try to get alpha-2 code from country name in Spanish
      let code = isoCountries.getAlpha2Code(normalized, 'es');
      if (code) return code;

      // Try English
      code = isoCountries.getAlpha2Code(normalized, 'en');
      if (code) return code;

      // Try case-insensitive search in both languages
      code = isoCountries.getAlpha2Code(normalized.toLowerCase(), 'es');
      if (code) return code;

      code = isoCountries.getAlpha2Code(normalized.toLowerCase(), 'en');
      if (code) return code;

      // Last resort: check our legacy Countries dictionary (case-insensitive)
      for (const [isoCode, countryName] of Object.entries(Countries)) {
        if (countryName.toUpperCase() === upperNormalized) {
          return isoCode;
        }
      }

      // Return undefined if not found — Prolibu will reject invalid values
      return undefined;
    },

    // Reverse transform for address.state - convert full state name back to code
    'address.state': (value, sourceData) => {
      if (!value) return undefined;

      // Get the country to determine which states dictionary to use
      const country = sourceData?.BillingCountry;
      if (!country) return undefined;

      // Map country name back to country code
      let countryCode = null;
      for (const [code, countryName] of Object.entries(Countries)) {
        if (countryName === country) {
          countryCode = code;
          break;
        }
      }

      if (countryCode && States[countryCode]) {
        // Find state code by searching for the value in States dictionary
        for (const [code, stateName] of Object.entries(States[countryCode])) {
          if (stateName === value) {
            return code; // Return the state code
          }
        }
      }

      // Return undefined if not found in dictionary
      return undefined;
    }
  }
};