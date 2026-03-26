'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const credentialStore = require('../shared/credentialStore');
const migrationLogger = require('../shared/migrationLogger');
const yamlLoader = require('../shared/configLoader');
const ProlibuSchemaService = require('../shared/ProlibuSchemaService');

// ─── Constants ────────────────────────────────────────────────

const UI_PORT = 3721;
const UI_ROOT = path.join(__dirname, 'review-ui');
const CONNECTION_CHECK_TIMEOUT = 15000; // 15s timeout for CRM auth check

/**
 * Load CRM metadata (entity mapping, label, adapter info).
 * Each CRM folder must export a metadata.js with a standard shape.
 * @param {string} crm - CRM key (e.g. 'salesforce')
 * @returns {object} { label, entityMapping, adapterModule, credentialFields }
 */
function loadCRMMetadata(crm) {
  const metaPath = path.join(__dirname, '../adapters', crm, 'metadata.js');
  if (!fs.existsSync(metaPath)) {
    return { label: crm, entityMapping: {}, fieldMapping: {}, adapterModule: null, credentialFields: [] };
  }
  const meta = require(metaPath);
  // Load field-level mapping if available (JS fallback)
  const fieldMapPath = path.join(__dirname, '../adapters', crm, 'fieldMapping.js');
  if (!meta.fieldMapping && fs.existsSync(fieldMapPath)) {
    meta.fieldMapping = require(fieldMapPath);
  }
  return meta;
}

/**
 * Load field mappings from YAML (mappings.yml + schema.yml).
 * Converts YAML format [{from, to}] keyed by entity key (accounts)
 * into UI format {sfFieldName: prolibuFieldName} keyed by SObject name (Account).
 *
 * @param {string} domain
 * @param {string} crm
 * @returns {object} e.g. { Account: { Name: 'companyName', ... }, Contact: { ... } }
 */
function loadYamlFieldMapping(domain, crm) {
  const { data: mappingsData } = yamlLoader.loadMappings(domain, crm);
  const { data: schemaData } = yamlLoader.loadSchema(domain, crm);
  if (!mappingsData?.entities || !schemaData?.entities) return {};

  const result = {};
  for (const [entityKey, entityConf] of Object.entries(mappingsData.entities)) {
    // Resolve the SObject name from schema.yml (e.g. accounts → Account)
    const schemaEntity = schemaData.entities[entityKey];
    const sobjectName = schemaEntity?.source || entityKey;

    // Convert [{from, to}] array to {from: to} object
    const fieldObj = {};
    for (const f of entityConf.fields || []) {
      if (f.from && f.to) {
        fieldObj[f.from] = f.to;
      }
    }
    result[sobjectName] = fieldObj;
  }
  return result;
}

/**
 * Discover available CRM adapters by scanning for folders with metadata.js.
 * @param {string} domain - Prolibu domain (for checking credentials)
 * @returns {Array<{key, label, hasCredentials, credentialFields}>}
 */
function discoverCRMs(domain) {
  const adaptersDir = path.join(__dirname, '../adapters');
  return fs.readdirSync(adaptersDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(adaptersDir, d.name, 'metadata.js')))
    .map(d => {
      const meta = loadCRMMetadata(d.name);
      return {
        key: d.name,
        label: meta.label || d.name,
        hasCredentials: !!credentialStore.getCredentials(domain, d.name),
        credentialFields: meta.credentialFields || [],
      };
    });
}

// ─── Prolibu API helpers ──────────────────────────────────────

function prolibuGet(domain, apiKey, urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: domain,
      path: `/v2/${urlPath}`,
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
    };
    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Bad JSON from ${urlPath}: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timeout')); });
  });
}

function prolibuPost(domain, apiKey, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: domain,
      path: `/v2/${urlPath}`,
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Accept: 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data, status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Main ─────────────────────────────────────────────────────

/**
 * Start the migration dashboard UI server.
 *
 * This is the standalone entry point — not tied to any specific phase.
 * From the UI the user can trigger discover, review schema, configure, and migrate.
 *
 * @param {object}  opts
 * @param {string}  opts.domain  - Prolibu domain
 * @param {string}  opts.apiKey  - Prolibu API key
 * @param {string}  opts.crm     - CRM key (e.g. 'salesforce', 'hubspot')
 */
async function startUIServer({ domain, apiKey, crm }) {
  let CRM = crm || null;
  let crmMeta = CRM ? loadCRMMetadata(CRM) : null;

  /** Switch to a different CRM at runtime. */
  function selectCRM(key) {
    CRM = key;
    crmMeta = loadCRMMetadata(key);
  }

  // ── Build initial state from whatever already exists on disk ──
  function buildState() {
    const discovery = credentialStore.loadDiscovery(domain, CRM);
    const config = credentialStore.getConfig(domain, CRM) || {};
    const credentials = credentialStore.getCredentials(domain, CRM);
    const configPath = credentialStore.getConfigPath(domain, CRM);
    const setupPath = path.join(path.dirname(configPath), 'prolibu_setup.json');
    const lastLog = migrationLogger.readLog(domain, CRM);

    // Load field mapping from YAML (primary) with JS fallback
    let fieldMapping = {};
    try {
      fieldMapping = loadYamlFieldMapping(domain, CRM);
    } catch {
      // Fallback to JS field mapping from metadata
      fieldMapping = crmMeta.fieldMapping || {};
    }

    return {
      domain,
      crm: CRM,
      hasCredentials: !!credentials,
      crmLabel: crmMeta.label,
      sfInstanceUrl: credentials?.instanceUrl || null,
      hasDiscovery: !!discovery,
      discoveredAt: discovery?.discoveredAt || null,
      discoveryObjectCount: discovery ? Object.keys(discovery.objects || {}).length : 0,
      hasConfig: !!Object.keys(config).length,
      discovery,
      config,
      prolibuSpec: null, // fetched lazily below
      sfToProlibu: crmMeta.entityMapping,
      fieldMapping,
      paths: { config: configPath, setup: setupPath },
      lastLog: lastLog ? {
        startedAt: lastLog.startedAt,
        finishedAt: lastLog.finishedAt,
        dryRun: lastLog.dryRun,
        entities: lastLog.entities,
      } : null,
    };
  }

  // Prolibu schema service + spec fetch
  const schemaService = new ProlibuSchemaService({ domain, apiKey });
  let prolibuSpec = null;
  if (apiKey) {
    console.log('🔍 Obteniendo schema de Prolibu...');
    try {
      prolibuSpec = await schemaService.refreshSpec();
      const entities = await schemaService.listEntities();
      console.log(`   ✅ ${entities.length} entidades encontradas en Prolibu`);
    } catch (e) {
      console.log(`   ⚠️  No se pudo cargar el schema: ${e.message}`);
    }
  }
  console.log('');

  // ── Vite dev server ───────────────────────────────────
  let viteProcess = null;

  // SSE clients for real-time log streaming
  const sseClients = new Set();

  function broadcastSSE(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try { client.write(msg); } catch { sseClients.delete(client); }
    }
  }

  // ── HTTP Server ───────────────────────────────────────────
  await new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const urlObj = new URL(req.url, `http://localhost:${UI_PORT}`);
      const { method } = req;
      const { pathname } = urlObj;

      const readBody = () =>
        new Promise((r) => {
          let b = '';
          req.on('data', (c) => (b += c));
          req.on('end', () => { try { r(JSON.parse(b)); } catch { r({}); } });
        });

      const ok = (data) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(data));
      };

      const fail = (code, msg) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg }));
      };

      // CORS pre-flight
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        return res.end();
      }

      // ── Non-API requests → handled by Vite dev server ──
      if (method === 'GET' && !pathname.startsWith('/api')) {
        res.writeHead(302, { Location: 'http://localhost:5173' + pathname });
        return res.end();
      }

      // ════════════════════════════════════════════════════
      //  API ROUTES
      // ════════════════════════════════════════════════════

      // ── CRM Discovery & Selection ───────────────────────

      // List available CRMs
      if (method === 'GET' && pathname === '/api/crms') {
        const crms = discoverCRMs(domain);
        return ok({ crms, activeCrm: CRM, domain });
      }

      // Select active CRM
      if (method === 'POST' && pathname === '/api/select-crm') {
        const body = await readBody();
        if (!body.crm) return fail(400, 'Missing "crm" field');
        const available = discoverCRMs(domain);
        if (!available.find(c => c.key === body.crm)) {
          return fail(400, `Unknown CRM: ${body.crm}. Available: ${available.map(c => c.key).join(', ')}`);
        }
        selectCRM(body.crm);
        console.log(`🔄 CRM cambiado a ${crmMeta.label}`);
        return ok({ ok: true, crm: CRM, label: crmMeta.label });
      }

      // Test CRM connection (authenticate)
      if (method === 'GET' && pathname === '/api/crm/connection') {
        if (!CRM) return ok({ connected: false, error: 'No CRM selected' });
        const creds = credentialStore.getCredentials(domain, CRM);
        if (!creds) return ok({ connected: false, error: 'No credentials configured', lastChecked: new Date().toISOString() });
        if (!crmMeta.adapterModule) return ok({ connected: false, error: 'No adapter configured for this CRM', lastChecked: new Date().toISOString() });
        try {
          const AdapterClass = require(`../adapters/${CRM}/${crmMeta.adapterModule}`);
          const adapter = new AdapterClass(creds);
          // Race: authenticate vs timeout
          await Promise.race([
            adapter.authenticate(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), CONNECTION_CHECK_TIMEOUT)),
          ]);
          return ok({ connected: true, crm: CRM, label: crmMeta.label, lastChecked: new Date().toISOString() });
        } catch (e) {
          console.log(`❌ CRM connection check failed: ${e.message}`);
          return ok({ connected: false, crm: CRM, label: crmMeta.label, error: e.message, lastChecked: new Date().toISOString() });
        }
      }

      // Test Prolibu connection
      if (method === 'GET' && pathname === '/api/prolibu/connection') {
        if (!apiKey) return ok({ connected: false, error: 'No API key configured', lastChecked: new Date().toISOString() });
        try {
          // Simple test: fetch user profile to verify API key and connectivity
          await Promise.race([
            prolibuGet(domain, apiKey, 'user/me'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), CONNECTION_CHECK_TIMEOUT)),
          ]);
          return ok({ connected: true, domain, lastChecked: new Date().toISOString() });
        } catch (e) {
          console.log(`❌ Prolibu connection check failed (${domain}): ${e.message}`);
          return ok({ connected: false, domain, error: e.message, lastChecked: new Date().toISOString() });
        }
      }

      // ── Guard: CRM must be selected for remaining routes ─
      if (pathname.startsWith('/api/') &&
        pathname !== '/api/done' &&
        pathname !== '/api/crms' &&
        pathname !== '/api/select-crm' &&
        pathname !== '/api/prolibu/connection' &&
        !CRM) {
        return fail(400, 'No CRM selected. Select one from the dashboard first.');
      }

      // ── Credentials CRUD ────────────────────────────────
      if (method === 'GET' && pathname === '/api/credentials') {
        const creds = credentialStore.getCredentials(domain, CRM) || {};
        // Mask secret values (show only last 4 chars)
        const masked = {};
        for (const [k, v] of Object.entries(creds)) {
          if (typeof v === 'string' && v.length > 8 && k !== 'instanceUrl') {
            masked[k] = '•'.repeat(Math.min(v.length - 4, 20)) + v.slice(-4);
          } else {
            masked[k] = v;
          }
        }
        return ok({
          credentials: masked,
          raw: creds,  // full values for pre-filling the form
          fields: crmMeta.credentialFields || [],
          crmLabel: crmMeta.label,
        });
      }

      if (method === 'POST' && pathname === '/api/credentials') {
        const body = await readBody();
        if (!body || !Object.keys(body).length) {
          return fail(400, 'No credentials provided');
        }
        // Validate that all required fields are present
        const missing = (crmMeta.credentialFields || []).filter(f => !body[f]);
        if (missing.length) {
          return fail(400, `Missing required fields: ${missing.join(', ')}`);
        }
        credentialStore.saveCredentials(domain, CRM, body);
        console.log(`🔑 Credenciales ${crmMeta.label} guardadas para ${domain}`);
        return ok({ ok: true, message: 'Credentials saved' });
      }

      // ── YAML Config CRUD ────────────────────────────────

      // List all YAML files and their status (exists, isTemplate)
      if (method === 'GET' && pathname === '/api/yaml/status') {
        const status = yamlLoader.checkYamlStatus(domain, CRM);
        return ok({ files: status });
      }

      // Get a specific YAML file content
      if (method === 'GET' && pathname.startsWith('/api/yaml/file/')) {
        const filename = pathname.replace('/api/yaml/file/', '');
        if (!yamlLoader.YAML_FILES.includes(filename)) {
          return fail(400, `Unknown YAML file: ${filename}`);
        }
        const result = yamlLoader.getRawYaml(domain, CRM, filename);
        if (!result) return fail(404, `${filename} not found`);
        return ok(result);
      }

      // Save a specific YAML file
      if (method === 'POST' && pathname.startsWith('/api/yaml/file/')) {
        const filename = pathname.replace('/api/yaml/file/', '');
        const body = await readBody();
        if (!body.content) return fail(400, 'Missing "content" field');
        try {
          const savedPath = yamlLoader.saveRawYaml(domain, CRM, filename, body.content);
          console.log(`💾 ${filename} guardado → ${savedPath}`);
          return ok({ ok: true, path: savedPath });
        } catch (e) {
          return fail(400, e.message);
        }
      }

      // Get parsed YAML config (all 4 files merged into engine format)
      if (method === 'GET' && pathname === '/api/yaml/config') {
        try {
          const config = yamlLoader.buildEngineConfig(domain, CRM);
          return ok(config);
        } catch (e) {
          return fail(400, e.message);
        }
      }

      // Scaffold YAML templates into domain directory
      if (method === 'POST' && pathname === '/api/yaml/scaffold') {
        const created = yamlLoader.scaffoldYaml(domain, CRM);
        console.log(`📄 YAML scaffold: ${created.length} archivos creados para ${domain}/${CRM}`);
        return ok({ ok: true, created });
      }

      // ── Dashboard state (fresh from disk each time) ─────
      if (method === 'GET' && pathname === '/api/state') {
        const state = buildState();
        state.prolibuSpec = prolibuSpec;
        return ok(state);
      }

      // ── Status / health ─────────────────────────────────
      if (method === 'GET' && pathname === '/api/status') {
        const credentials = credentialStore.getCredentials(domain, CRM);
        const discovery = credentialStore.loadDiscovery(domain, CRM);
        const config = credentialStore.getConfig(domain, CRM);
        const lastLog = migrationLogger.readLog(domain, CRM);
        const yamlStatus = yamlLoader.checkYamlStatus(domain, CRM);
        const hasYamlConfig = yamlStatus.some(f => f.exists && !f.isTemplate);
        return ok({
          domain,
          crm: CRM,
          crmLabel: crmMeta.label,
          yaml: { files: yamlStatus, hasCustomConfig: hasYamlConfig },
          phases: {
            configure: { done: !!credentials, label: `Credenciales ${crmMeta.label}`, link: '/credentials' },
            discover: {
              done: !!discovery,
              label: 'Discovery',
              detail: discovery ? `${Object.keys(discovery.objects || {}).length} objetos · ${new Date(discovery.discoveredAt).toLocaleString()}` : null,
            },
            config: {
              done: hasYamlConfig || (!!config && Object.keys(config.entities || {}).length > 0),
              label: 'Configuración',
              detail: hasYamlConfig
                ? `YAML config (${yamlStatus.filter(f => f.exists && !f.isTemplate).length} archivos)`
                : config?.entities ? `${Object.keys(config.entities).length} entidades configuradas` : null,
              link: '/config',
            },
            migrate: {
              done: !!lastLog,
              label: 'Migración',
              detail: lastLog ? `Último run: ${new Date(lastLog.startedAt).toLocaleString()} ${lastLog.dryRun ? '(dry-run)' : ''}` : null,
            },
          },
        });
      }

      // ── Run a phase ─────────────────────────────────────
      if (method === 'POST' && pathname === '/api/phases/discover') {
        if (!credentialStore.getCredentials(domain, CRM)) {
          return fail(400, `No ${crmMeta.label} credentials configured. Run "prolibu migrate ${CRM} configure" first.`);
        }

        // Read body BEFORE responding — the request stream won't be available after ok()
        const body = await readBody().catch(() => ({}));

        ok({ ok: true, message: 'Discover phase started' });

        setImmediate(async () => {
          const origLog = console.log;
          try {
            console.log = (...args) => {
              const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
              origLog(...args);
              broadcastSSE({ type: 'log', data: line });
            };

            const engine = require(`../adapters/${CRM}/engine`);
            await engine.run({
              domain,
              apiKey,
              entities: [],
              phases: ['discover'],
              withCount: body.withCount || false,
              onDiscoverProgress: (progress) => {
                broadcastSSE({ type: 'discover-progress', data: progress });
              },
            });

            broadcastSSE({ type: 'phase-done', data: { phase: 'discover' } });
          } catch (e) {
            broadcastSSE({ type: 'error', data: e.message });
            broadcastSSE({ type: 'phase-done', data: { phase: 'discover', error: e.message } });
          } finally {
            console.log = origLog;
          }
        });
        return;
      }

      // ── Save config ─────────────────────────────────────
      if (method === 'POST' && pathname === '/api/save-config') {
        const body = await readBody();
        const configPath = credentialStore.getConfigPath(domain, CRM);
        credentialStore.saveConfig(domain, CRM, body, true);
        console.log(`💾 config.json guardado → ${configPath}`);
        return ok({ ok: true, path: configPath });
      }

      // ── Save setup ──────────────────────────────────────
      if (method === 'POST' && pathname === '/api/save-setup') {
        const body = await readBody();
        const configPath = credentialStore.getConfigPath(domain, CRM);
        const setupPath = path.join(path.dirname(configPath), 'prolibu_setup.json');
        fs.mkdirSync(path.dirname(setupPath), { recursive: true });
        fs.writeFileSync(setupPath, JSON.stringify(body, null, 2));
        console.log(`💾 prolibu_setup.json guardado → ${setupPath}`);
        return ok({ ok: true, path: setupPath });
      }

      // ── Save mappings ───────────────────────────────────
      if (method === 'POST' && pathname === '/api/save-mappings') {
        const body = await readBody();
        const fieldMaps = body.fieldMaps;
        if (!fieldMaps || typeof fieldMaps !== 'object') {
          return fail(400, 'fieldMaps is required');
        }
        try {
          const configLoader = require('../shared/configLoader');
          const { data: schema } = configLoader.loadSchema(domain, CRM);
          const savedPath = configLoader.saveMappings(domain, CRM, fieldMaps, schema);
          console.log(`💾 mappings.json guardado → ${savedPath}`);
          return ok({ ok: true, path: savedPath });
        } catch (e) {
          return fail(500, e.message);
        }
      }

      // ── Prolibu proxy: create field ─────────────────────
      if (method === 'POST' && pathname === '/api/prolibu/create-field') {
        if (!apiKey) return fail(400, 'No apiKey available');
        const body = await readBody();
        try {
          const result = await prolibuPost(domain, apiKey, 'custom-fields', body);
          return ok(result);
        } catch (e) { return fail(500, e.message); }
      }

      // ── Prolibu proxy: create object ────────────────────
      if (method === 'POST' && pathname === '/api/prolibu/create-object') {
        if (!apiKey) return fail(400, 'No apiKey available');
        const body = await readBody();
        try {
          const result = await prolibuPost(domain, apiKey, 'custom-objects', body);
          return ok(result);
        } catch (e) { return fail(500, e.message); }
      }

      // ── Prolibu schema service endpoints ────────────────
      // List all Prolibu entities
      if (method === 'GET' && pathname === '/api/prolibu/entities') {
        try {
          const entities = await schemaService.listEntities();
          return ok({ entities });
        } catch (e) { return fail(500, e.message); }
      }

      // Get schema for a specific entity
      if (method === 'GET' && pathname.startsWith('/api/prolibu/schema/')) {
        const entity = pathname.replace('/api/prolibu/schema/', '');
        if (!entity) return fail(400, 'Entity name required');
        try {
          const schema = await schemaService.getEntitySchema(entity);
          if (!schema) return fail(404, `No schema found for "${entity}"`);
          return ok(schema);
        } catch (e) { return fail(500, e.message); }
      }

      // Get flat field list for a specific entity
      if (method === 'GET' && pathname.startsWith('/api/prolibu/fields/')) {
        const entity = pathname.replace('/api/prolibu/fields/', '');
        if (!entity) return fail(400, 'Entity name required');
        try {
          const fields = await schemaService.getEntityFields(entity);
          if (!fields) return fail(404, `No fields found for "${entity}"`);
          return ok(fields);
        } catch (e) { return fail(500, e.message); }
      }

      // Refresh the OpenAPI spec from Prolibu
      if (method === 'POST' && pathname === '/api/prolibu/refresh-schema') {
        if (!apiKey) return fail(400, 'No apiKey available');
        try {
          await schemaService.refreshSpec();
          prolibuSpec = schemaService._spec;
          const entities = await schemaService.listEntities();
          return ok({ ok: true, entityCount: entities.length });
        } catch (e) { return fail(500, e.message); }
      }

      // Get the known field mapping for the active CRM
      if (method === 'GET' && pathname === '/api/field-mapping') {
        return ok(crmMeta.fieldMapping || {});
      }

      // ── Flow editor ─────────────────────────────────────
      if (method === 'GET' && pathname === '/api/flow') {
        try {
          const { data: pipelinesData } = yamlLoader.loadPipelines(domain, CRM);
          const pipeline = pipelinesData?.pipeline || {};

          // Gather available entities from multiple sources
          const entitySet = new Set();

          // 1. From schema.json entity definitions
          try {
            const { data: schemaData } = yamlLoader.loadSchema(domain, CRM);
            for (const key of Object.keys(schemaData?.entities || {})) {
              entitySet.add(key);
            }
          } catch { /* no schema */ }

          // 2. From config.json
          const config = credentialStore.getConfig(domain, CRM) || {};
          for (const key of Object.keys(config.entities || {})) {
            entitySet.add(key);
          }

          // 3. From transformers directory
          const configPath = credentialStore.getConfigPath(domain, CRM);
          const transformersDir = path.join(path.dirname(configPath), 'transformers');
          if (fs.existsSync(transformersDir)) {
            for (const f of fs.readdirSync(transformersDir)) {
              if (f.endsWith('.js')) entitySet.add(f.replace('.js', ''));
            }
          }

          // 4. From pipelines directory
          const pipelinesDir = path.join(path.dirname(configPath), 'pipelines');
          if (fs.existsSync(pipelinesDir)) {
            for (const f of fs.readdirSync(pipelinesDir)) {
              if (f.endsWith('.js')) entitySet.add(f.replace('.js', ''));
            }
          }

          // Auto-convert flat order to a single-step flow when no flow is defined
          let flow = pipeline.flow || null;
          if (!flow && pipeline.order?.length) {
            flow = [{ name: 'Paso 1', entities: pipeline.order }];
          }

          // Detect entity conflicts (e.g. lineitems + opportunities with joins)
          const warnings = [];
          try {
            const { data: schemaCheck } = yamlLoader.loadSchema(domain, CRM);
            const oppDef = schemaCheck?.entities?.opportunities;
            const liDef = schemaCheck?.entities?.lineitems;
            const quoteDef = schemaCheck?.entities?.quotes;
            if (oppDef?.enabled !== false && liDef?.enabled !== false) {
              const hasLineItemJoin = (oppDef?.join || []).some(j => j.as === 'lineItems');
              if (hasLineItemJoin) {
                warnings.push({
                  type: 'conflict',
                  entities: ['lineitems', 'opportunities'],
                  message: 'Los line items ya se importan automáticamente vía el join de opportunities (QuoteLineItem → proposal.quote.lineItems). Habilitar "lineitems" como entidad independiente puede causar datos duplicados.',
                });
              }
            }
            if (oppDef?.enabled !== false && quoteDef?.enabled !== false) {
              const hasQuoteJoin = (oppDef?.join || []).some(j => j.as === 'quote');
              if (hasQuoteJoin) {
                warnings.push({
                  type: 'conflict',
                  entities: ['quotes', 'opportunities'],
                  message: 'Los datos de Quote ya se importan vía el join de opportunities (Quote → proposal.quote.*). Prolibu no tiene un modelo "quote" independiente — esta entidad fallará si se ejecuta.',
                });
              }
            }
          } catch { /* no schema — skip warnings */ }

          return ok({
            flow,
            order: pipeline.order || [],
            availableEntities: [...entitySet],
            warnings,
            batchSize: pipeline.batchSize || 200,
            concurrency: pipeline.concurrency || 1,
            onError: pipeline.onError || 'skip',
          });
        } catch (e) {
          return ok({ flow: null, order: [], availableEntities: [], batchSize: 200, concurrency: 1, onError: 'skip' });
        }
      }

      if (method === 'POST' && pathname === '/api/flow') {
        const body = await readBody();
        const flow = body.flow;
        if (!Array.isArray(flow)) return fail(400, 'flow must be an array');

        try {
          const { data: pipelinesData } = yamlLoader.loadPipelines(domain, CRM);
          const pipeline = pipelinesData?.pipeline || {};

          // Update flow and derive order from flow
          pipeline.flow = flow;
          pipeline.order = flow.flatMap(step => step.entities || []);

          const updatedData = { ...pipelinesData, pipeline };
          const configPath = credentialStore.getConfigPath(domain, CRM);
          const pipelinesPath = path.join(path.dirname(configPath), 'pipelines.json');
          fs.mkdirSync(path.dirname(pipelinesPath), { recursive: true });
          fs.writeFileSync(pipelinesPath, JSON.stringify(updatedData, null, 2));
          console.log(`💾 Flow guardado → ${pipelinesPath}`);
          return ok({ ok: true, path: pipelinesPath });
        } catch (e) {
          return fail(500, e.message);
        }
      }

      // ── Pipeline introspection ──────────────────────────
      if (method === 'GET' && pathname === '/api/pipelines') {
        try {
          const configPath = credentialStore.getConfigPath(domain, CRM);
          const pipelinesDir = path.join(path.dirname(configPath), 'pipelines');
          const transformersDir = path.join(path.dirname(configPath), 'transformers');
          const result = {};

          if (fs.existsSync(pipelinesDir)) {
            for (const f of fs.readdirSync(pipelinesDir)) {
              if (!f.endsWith('.js')) continue;
              const key = f.replace('.js', '');
              try {
                const mod = require(path.join(pipelinesDir, f));
                const steps = mod.steps || mod.default?.steps || [];
                result[key] = {
                  custom: true,
                  source: `pipelines/${f}`,
                  steps: steps.map(s => ({
                    name: s.name || s.type || 'step',
                    type: s.type || 'transform',
                    description: s.description || '',
                  })),
                };
              } catch {
                result[key] = { custom: true, source: `pipelines/${f}`, steps: [], error: 'parse error' };
              }
            }
          }

          if (fs.existsSync(transformersDir)) {
            for (const f of fs.readdirSync(transformersDir)) {
              if (!f.endsWith('.js')) continue;
              const key = f.replace('.js', '');
              if (!result[key]) {
                result[key] = {
                  custom: false,
                  source: `transformers/${f}`,
                  steps: [{ name: 'transform', type: 'transform', description: 'Transformer base' }],
                };
              }
            }
          }

          return ok(result);
        } catch (e) {
          return fail(500, e.message);
        }
      }

      // ── Migration execution ─────────────────────────────
      if (method === 'POST' && pathname === '/api/migrate') {
        const body = await readBody();
        const entities = body.entities || [];
        const dryRun = body.dryRun !== false;

        if (!entities.length) return fail(400, 'No entities specified');

        ok({ ok: true, message: 'Migration started', dryRun });

        setImmediate(async () => {
          const origLog = console.log;
          try {
            const engine = require(`../adapters/${CRM}/engine`);
            console.log = (...args) => {
              const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
              origLog(...args);
              broadcastSSE({ type: 'log', data: line });
            };

            console.log(`🎯 Target Prolibu domain: ${domain}`);
            console.log(`🔑 Using API key: ${apiKey.slice(0, 8)}...`);
            console.log(`🧪 Dry run: ${dryRun ? 'YES (no data will be written)' : 'NO (real migration)'}`);
            console.log('');

            await engine.run({
              domain,
              apiKey,
              entities,
              phases: ['migrate'],
              dryRun,
              onProgress: (progress) => {
                broadcastSSE({ type: 'progress', data: progress });
              },
              onEntityResult: (entityKey, result) => {
                broadcastSSE({ type: 'result', data: { entity: entityKey, ...result } });
              },
            });

            broadcastSSE({ type: 'done', data: 'Migration completed' });
          } catch (e) {
            broadcastSSE({ type: 'error', data: e.message });
            broadcastSSE({ type: 'done', data: 'Migration failed' });
          } finally {
            console.log = origLog;
          }
        });
        return;
      }

      // ── SSE stream for real-time logs ───────────────────
      if (method === 'GET' && pathname === '/api/migrate/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write('data: {"type":"connected"}\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      // ── Graceful shutdown ───────────────────────────────
      if (method === 'POST' && pathname === '/api/done') {
        ok({ ok: true });
        if (viteProcess) { viteProcess.kill(); viteProcess = null; }
        server.close();
        console.log('\n✅ Servidor cerrado.');
        resolve();
        return;
      }

      fail(404, 'Not found');
    });

    // ── Start listening ─────────────────────────────────────
    server.listen(UI_PORT, '127.0.0.1', () => {
      const url = `http://localhost:${UI_PORT}`;
      const { spawn } = require('child_process');
      const viteUrl = 'http://localhost:5173';

      console.log('🌐 Migration Dashboard:');
      console.log(`   ${viteUrl}  (Vite hot reload)`);
      console.log(`   API backend en ${url}`);
      console.log(`   🎯 Target Prolibu: https://${domain}`);
      console.log('   Ctrl+C para cerrar todo.\n');

      viteProcess = spawn('npx', ['vite'], {
        cwd: UI_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
      });

      viteProcess.stdout.on('data', (data) => {
        const line = data.toString().trim();
        if (line) console.log(`  [vite] ${line}`);
      });
      viteProcess.stderr.on('data', (data) => {
        const line = data.toString().trim();
        if (line) console.log(`  [vite] ${line}`);
      });
      viteProcess.on('error', (err) => {
        console.error(`  ⚠️  No se pudo iniciar Vite: ${err.message}`);
        console.error('     Ejecuta "cd review-ui && npm run dev" manualmente.\n');
      });

      setTimeout(() => {
        const open = process.platform === 'win32' ? 'start'
          : process.platform === 'darwin' ? 'open' : 'xdg-open';
        require('child_process').exec(`${open} "${viteUrl}"`);
      }, 2000);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Puerto ${UI_PORT} ya está en uso.`);
        console.error('   Cierra la instancia anterior e intenta de nuevo.\n');
        process.exit(1);
      }
      throw err;
    });

    // Clean up on Ctrl+C
    process.on('SIGINT', () => {
      if (viteProcess) { viteProcess.kill(); viteProcess = null; }
      server.close();
      console.log('\n✅ Servidor cerrado.');
      resolve();
    });
  });
}

module.exports = startUIServer;
