/**
 * cli/builders/migrateBuilder.js
 *
 * Utility functions for building/packaging migration artifacts.
 * Reserved for future use (e.g., exporting migration configs, bundling adapters).
 */

/**
 * Placeholder: Export migration configuration as a portable package
 * @param {string} domain - Prolibu domain
 * @param {string} crm - CRM adapter key
 * @returns {Promise<string>} Path to exported package
 */
async function exportMigrationConfig(domain, crm) {
    // Future implementation: bundle YAML configs, credentials (encrypted), etc.
    throw new Error('Not yet implemented');
}

module.exports = {
    exportMigrationConfig,
};
