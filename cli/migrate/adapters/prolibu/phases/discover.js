'use strict';

const credentialStore = require('../../../shared/credentialStore');
const ProlibuApi = require('../../../../../lib/vendors/prolibu/ProlibuApi');
const { listCustomFields } = require('../../../../../api/customFieldClient');
const { listCobs } = require('../../../../../api/cobClient');

/**
 * Phase: discover
 *
 * Connects to the SOURCE Prolibu account and fetches:
 *   1. Custom fields
 *   2. Custom objects (COBs)
 *   3. Scripts
 *
 * Produces artifacts:
 *   - accounts/<domain>/migrations/prolibu/discovery.json
 *
 * discovery.json shape:
 * {
 *   "discoveredAt": "ISO string",
 *   "sourceDomain": "source.prolibu.com",
 *   "customFields": [
 *     { "id": "...", "objectAssigned": "Contact", "customFields": [...], "overrides": {...} }
 *   ],
 *   "customObjects": [
 *     { "id": "...", "modelName": "MyObject", "displayName": "My Object", "fields": {} }
 *   ],
 *   "scripts": [
 *     { "id": "...", "scriptCode": "my-script", "scriptName": "My Script", "active": true, ... }
 *   ]
 * }
 *
 * @param {object}   context
 * @param {string}   context.domain          - Destination Prolibu domain (artifacts are saved here)
 * @param {string}   context.sourceDomain    - Source Prolibu domain to introspect
 * @param {string}   context.sourceApiKey    - API key for the source domain
 */
async function discover({ domain, sourceDomain, sourceApiKey }) {
  console.log(`🔍 Starting Prolibu discovery on: ${sourceDomain}`);
  console.log('');

  const sourceApi = new ProlibuApi({ domain: sourceDomain, apiKey: sourceApiKey });

  // ─── 1. Custom fields ────────────────────────────────────────

  console.log('🔧 Fetching custom fields...');
  let customFields = [];
  try {
    const result = await listCustomFields(sourceDomain, sourceApiKey, { limit: 200 });
    customFields = (result?.data || result || []).map((cf) => ({
      id: cf._id,
      objectAssigned: cf.objectAssigned,
      customFields: cf.customFields || [],
      overrides: cf.overrides || {},
    }));
    console.log(`   Found ${customFields.length} custom fields`);
  } catch (err) {
    console.warn(`   ⚠️  Could not fetch custom fields: ${err.message}`);
  }

  // ─── 2. Custom objects (COBs) ─────────────────────────────────

  console.log('');
  console.log('📦 Fetching custom objects (COBs)...');
  let customObjects = [];
  try {
    const result = await listCobs(sourceDomain, sourceApiKey, { limit: 200 });
    customObjects = (result?.data || result || []).map((cob) => ({
      id: cob._id,
      modelName: cob.modelName,
      displayName: cob.displayName || cob.modelName,
      fields: cob.fields || {},
    }));
    console.log(`   Found ${customObjects.length} custom objects`);
  } catch (err) {
    console.warn(`   ⚠️  Could not fetch custom objects: ${err.message}`);
  }

  // ─── 3. Scripts ───────────────────────────────────────────────

  console.log('');
  console.log('📜 Fetching scripts...');
  let scripts = [];
  try {
    const result = await sourceApi.find('script', { limit: 200, select: 'scriptCode scriptName code active variables lifecycleHooks readme' });
    const docs = result?.docs || result?.data || result || [];
    scripts = (Array.isArray(docs) ? docs : []).map((s) => ({
      id: s._id,
      scriptCode: s.scriptCode,
      scriptName: s.scriptName,
      code: s.code,
      active: s.active,
      variables: s.variables || [],
      lifecycleHooks: s.lifecycleHooks || [],
      ...(s.readme ? { readme: s.readme } : {}),
    }));
    console.log(`   Found ${scripts.length} scripts`);
  } catch (err) {
    console.warn(`   ⚠️  Could not fetch scripts: ${err.message}`);
  }

  // ─── 4. Save discovery artifact ──────────────────────────────

  const discovery = {
    discoveredAt: new Date().toISOString(),
    sourceDomain,
    customFields,
    customObjects,
    scripts,
  };

  credentialStore.saveDiscovery(domain, 'prolibu', discovery);

  // ─── Summary ─────────────────────────────────────────────────

  const cfByModel = customFields.reduce((acc, cf) => {
    acc[cf.objectAssigned] = (acc[cf.objectAssigned] || 0) + 1;
    return acc;
  }, {});

  console.log('');
  console.log('✅ Discovery complete');
  console.log(`   📋 ${customFields.length} custom fields across ${Object.keys(cfByModel).length} models`);
  console.log(`   📦 ${customObjects.length} custom objects`);
  console.log(`   📜 ${scripts.length} scripts`);
  console.log(`   💾 Saved to: accounts/${domain}/migrations/prolibu/discovery.json`);
  console.log('');

  return discovery;
}

module.exports = discover;
