const fs = require('fs');
const path = require('path');

const ACCOUNTS_DIR = path.join(process.cwd(), 'accounts');

/**
 * Get path to CRM credentials file for a domain
 * accounts/<domain>/migrations/<crm>/credentials.json
 */
function getCredentialsPath(domain, crm) {
  return path.join(ACCOUNTS_DIR, domain, 'migrations', crm, 'credentials.json');
}

/**
 * Get path to CRM config file for a domain
 * accounts/<domain>/migrations/<crm>/config.json
 */
function getConfigPath(domain, crm) {
  return path.join(ACCOUNTS_DIR, domain, 'migrations', crm, 'config.json');
}

/**
 * Get path to domain transformers override folder
 * accounts/<domain>/migrations/<crm>/transformers/
 */
function getTransformersPath(domain, crm) {
  return path.join(ACCOUNTS_DIR, domain, 'migrations', crm, 'transformers');
}

/**
 * Read CRM credentials for a domain
 * @returns {object|null}
 */
function getCredentials(domain, crm) {
  const filePath = getCredentialsPath(domain, crm);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Save CRM credentials for a domain
 */
function saveCredentials(domain, crm, credentials) {
  const filePath = getCredentialsPath(domain, crm);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(credentials, null, 2));
}

/**
 * Read migration config for a domain
 * @returns {object|null}
 */
function getConfig(domain, crm) {
  const filePath = getConfigPath(domain, crm);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Save migration config for a domain (does not overwrite if already exists)
 */
function saveConfig(domain, crm, config, overwrite = false) {
  const filePath = getConfigPath(domain, crm);
  if (!overwrite && fs.existsSync(filePath)) return false;
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
  return true;
}

/**
 * Ensure the transformers override directory exists
 */
function ensureTransformersDir(domain, crm) {
  const dir = getTransformersPath(domain, crm);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Check if an override transformer exists for a domain/entity
 */
function hasTransformerOverride(domain, crm, entity) {
  const filePath = path.join(getTransformersPath(domain, crm), `${entity}.js`);
  return fs.existsSync(filePath);
}

/**
 * Load override transformer for a domain/entity (returns null if none)
 */
function loadTransformerOverride(domain, crm, entity) {
  const filePath = path.join(getTransformersPath(domain, crm), `${entity}.js`);
  if (!fs.existsSync(filePath)) return null;
  // Clear require cache so edits take effect without restarting
  delete require.cache[require.resolve(filePath)];
  return require(filePath);
}

module.exports = {
  getCredentialsPath,
  getConfigPath,
  getTransformersPath,
  getCredentials,
  saveCredentials,
  getConfig,
  saveConfig,
  ensureTransformersDir,
  hasTransformerOverride,
  loadTransformerOverride,
};
