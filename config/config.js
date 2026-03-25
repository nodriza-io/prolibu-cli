const fs = require('fs');
const path = require('path');

// Resource type subfolder names inside each account
const RESOURCE_TYPES = {
  scripts: 'scripts',
  sites: 'sites',
  plugins: 'plugins',
  vt: 'vt',
};

function getAccountPath(domain) {
  return path.join(process.cwd(), 'accounts', domain);
}

function getResourcePath(domain, resourceType, name) {
  return path.join(process.cwd(), 'accounts', domain, resourceType, name);
}

function getProfilePath(domain) {
  return path.join(process.cwd(), 'accounts', domain, 'profile.json');
}

function ensureConfig(domain) {
  const profilePath = getProfilePath(domain);
  if (!fs.existsSync(profilePath)) {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify({ apiKey: '' }, null, 2));
  }
}

function get(key, domain) {
  const profilePath = getProfilePath(domain);
  if (!fs.existsSync(profilePath)) return undefined;
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  return profile[key];
}

function set(key, value, domain) {
  const profilePath = getProfilePath(domain);
  ensureConfig(domain);
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  profile[key] = value;
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  if (key === 'apiKey') {
    console.log(`[DEBUG] apiKey for domain '${domain}' saved to ${profilePath}`);
  }
}

function getScriptCodePath(domain, scriptName) {
  return path.join(process.cwd(), 'accounts', domain, RESOURCE_TYPES.scripts, scriptName, 'code.js');
}

function getScriptEntryPath(domain, scriptName, fileName = 'index') {
  return path.join(process.cwd(), 'accounts', domain, RESOURCE_TYPES.scripts, scriptName, `${fileName}.js`);
}

function ensureScriptCode(domain, scriptName, fileName = 'index') {
  const codePath = getScriptEntryPath(domain, scriptName, fileName);
  if (!fs.existsSync(codePath)) {
    fs.mkdirSync(path.dirname(codePath), { recursive: true });
    fs.writeFileSync(codePath, '// Your script code here\n');
  }
}

function readScriptCode(domain, scriptName, fileName = 'index') {
  const codePath = getScriptEntryPath(domain, scriptName, fileName);
  if (!fs.existsSync(codePath)) return '';
  return fs.readFileSync(codePath, 'utf8');
}

function writeScriptCode(domain, scriptName, code, fileName = 'index') {
  const codePath = getScriptEntryPath(domain, scriptName, fileName);
  ensureScriptCode(domain, scriptName, fileName);
  fs.writeFileSync(codePath, code);
}

module.exports = {
  get,
  set,
  getProfilePath,
  getAccountPath,
  getResourcePath,
  RESOURCE_TYPES,
  ensureConfig,
  getScriptCodePath,
  getScriptEntryPath,
  ensureScriptCode,
  readScriptCode,
  writeScriptCode,
};
