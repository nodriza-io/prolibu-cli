'use strict';

const credentialStore = require('../../../shared/credentialStore');
const ProlibuSchemaService = require('../../../../../lib/vendors/prolibu/ProlibuSchemaService');
const ProlibuApi = require('../../../../../lib/vendors/prolibu/ProlibuApi');
const { listCustomFields } = require('../../../../../api/customFieldClient');
const { listCobs } = require('../../../../../api/cobClient');

/**
 * Phase: discover
 *
 * Connects to the SOURCE Prolibu account and introspects its full schema:
 *   1. Fetches the OpenAPI specification (/v2/openapi/specification)
 *   2. Extracts all standard entities with their field details
 *   3. Fetches all custom fields (customfield collection)
 *   4. Fetches all custom objects / COBs (cob collection)
 *   5. Optionally counts records per entity
 *
 * Produces artifacts:
 *   - accounts/<domain>/migrations/prolibu/discovery.json
 *
 * discovery.json shape:
 * {
 *   "discoveredAt": "ISO string",
 *   "withCount": true|false,
 *   "sourceDomain": "source.prolibu.com",
 *   "entities": {
 *     "contact": {
 *       "type": "standard",
 *       "fields": 18,
 *       "fieldDetails": [
 *         { "name": "firstName", "type": "string", "description": "...", "required": false }
 *       ],
 *       "records": 420    // only when withCount=true
 *     },
 *     ...
 *   },
 *   "customFields": [
 *     { "id": "...", "modelName": "Contact", "key": "myField", "type": "string", "label": "My Field" }
 *   ],
 *   "customObjects": [
 *     { "id": "...", "modelName": "MyObject", "displayName": "My Object", "fields": {} }
 *   ]
 * }
 *
 * @param {object}   context
 * @param {string}   context.domain          - Destination Prolibu domain (artifacts are saved here)
 * @param {string}   context.sourceDomain    - Source Prolibu domain to introspect
 * @param {string}   context.sourceApiKey    - API key for the source domain
 * @param {boolean}  [context.withCount]     - Fetch record count per entity (default: false)
 * @param {function} [context.onDiscoverProgress] - Progress callback ({ done, total })
 */
async function discover({ domain, sourceDomain, sourceApiKey, withCount = false, onDiscoverProgress }) {
  console.log(`🔍 Starting Prolibu discovery on: ${sourceDomain}`);
  if (withCount) console.log('   (record counts enabled — this will take longer)');
  console.log('');

  // ─── 1. Fetch OpenAPI specification ─────────────────────────

  console.log('📄 Fetching OpenAPI specification...');
  const schemaSvc = new ProlibuSchemaService({ domain: sourceDomain, apiKey: sourceApiKey });
  let spec;
  try {
    spec = await schemaSvc.refreshSpec();
  } catch (err) {
    console.error(`❌ Failed to fetch specification from ${sourceDomain}: ${err.message}`);
    process.exit(1);
  }

  const entityNames = await schemaSvc.listEntities();
  console.log(`   Found ${entityNames.length} entities in specification`);
  console.log('');

  // ─── 2. Extract field details for each entity ────────────────

  console.log('🗂  Extracting entity schemas...');
  const entities = {};
  let done = 0;

  for (const name of entityNames) {
    try {
      const schema = await schemaSvc.getEntitySchema(name);
      const props = schema?.properties || {};
      const requiredFields = new Set(schema?.required || []);

      const fieldDetails = Object.entries(props).map(([fieldName, def]) => {
        const entry = {
          name: fieldName,
          type: def.type || (def.$ref ? 'ref' : 'mixed'),
          required: requiredFields.has(fieldName),
        };
        if (def.description) entry.description = def.description;
        if (def.enum) entry.enum = def.enum;
        if (def.format) entry.format = def.format;
        if (def.$ref) entry.$ref = def.$ref;
        return entry;
      });

      entities[name] = {
        type: 'standard',
        fields: fieldDetails.length,
        fieldDetails,
      };
    } catch (err) {
      entities[name] = { type: 'standard', error: err.message };
    }

    done++;
    if (onDiscoverProgress) onDiscoverProgress({ done, total: entityNames.length });
    process.stdout.write(`\r   Progress: ${done}/${entityNames.length}`);
  }

  console.log(''); // newline after progress

  // ─── 3. Optional: record counts ──────────────────────────────

  if (withCount) {
    console.log('');
    console.log('📊 Counting records per entity...');
    const sourceApi = new ProlibuApi({ domain: sourceDomain, apiKey: sourceApiKey });
    let countDone = 0;

    for (const name of entityNames) {
      if (entities[name]?.error) {
        countDone++;
        continue;
      }
      try {
        const result = await sourceApi.find(name, { limit: 1 });
        entities[name].records = result?.pagination?.count ?? 0;
      } catch {
        entities[name].records = 0;
      }
      countDone++;
      process.stdout.write(`\r   Progress: ${countDone}/${entityNames.length}`);
    }
    console.log('');
  }

  // ─── 4. Custom fields ────────────────────────────────────────

  console.log('');
  console.log('🔧 Fetching custom fields...');
  let customFields = [];
  try {
    const result = await listCustomFields(sourceDomain, sourceApiKey, { limit: 200 });
    customFields = (result?.data || result || []).map((cf) => ({
      id: cf._id,
      modelName: cf.modelName,
      key: cf.key,
      type: cf.type,
      label: cf.label || cf.key,
      ...(cf.enum?.length ? { enum: cf.enum } : {}),
      ...(cf.required ? { required: true } : {}),
    }));
    console.log(`   Found ${customFields.length} custom fields`);
  } catch (err) {
    console.warn(`   ⚠️  Could not fetch custom fields: ${err.message}`);
  }

  // ─── 5. Custom objects (COBs) ─────────────────────────────────

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

  // ─── 6. Save discovery artifact ──────────────────────────────

  const discovery = {
    discoveredAt: new Date().toISOString(),
    withCount,
    sourceDomain,
    entities,
    customFields,
    customObjects,
  };

  credentialStore.saveDiscovery(domain, 'prolibu', discovery);

  // ─── Summary ─────────────────────────────────────────────────

  const errCount = Object.values(entities).filter((e) => e.error).length;
  const cfByModel = customFields.reduce((acc, cf) => {
    acc[cf.modelName] = (acc[cf.modelName] || 0) + 1;
    return acc;
  }, {});

  console.log('');
  console.log(`✅ Discovery complete — ${Object.keys(entities).length} entities documented`);
  console.log(`   📋 ${customFields.length} custom fields across ${Object.keys(cfByModel).length} models`);
  console.log(`   📦 ${customObjects.length} custom objects`);
  if (withCount) {
    const withData = Object.values(entities).filter((e) => (e.records ?? 0) > 0).length;
    console.log(`   📊 ${withData} entities with data`);
  }
  if (errCount) console.log(`   ⚠️  ${errCount} entities skipped (schema error)`);
  console.log(`   💾 Saved to: accounts/${domain}/migrations/prolibu/discovery.json`);
  console.log('');

  return discovery;
}

module.exports = discover;
