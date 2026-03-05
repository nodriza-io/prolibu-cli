'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const credentialStore = require('../../shared/credentialStore');

/**
 * Default Salesforce SObject → Prolibu entity mapping.
 * Key:   Salesforce SObject API name
 * Value: { prolibu: '<entity>', notes: '<optional context>' }
 *
 * Built from the Prolibu OpenAPI spec at /v2/openapi/specification.
 * Custom objects (__c) are listed separately as "unmapped" unless the user
 * explicitly maps them in config.json.
 */
const SF_TO_PROLIBU = {
    // Core CRM
    Account: { prolibu: 'company', notes: 'Companies / customers' },
    Contact: { prolibu: 'contact', notes: 'People linked to companies' },
    Lead: { prolibu: 'contact', notes: 'Unqualified contacts — tag as lead' },
    Opportunity: { prolibu: 'deal', notes: 'Sales pipeline opportunities' },
    Quote: { prolibu: 'quote', notes: 'Commercial proposals' },
    Contract: { prolibu: 'contract', notes: 'Signed agreements' },
    Case: { prolibu: 'ticket', notes: 'Support / service cases' },
    // Products & pricing
    Product2: { prolibu: 'product', notes: 'Product catalog' },
    Pricebook2: { prolibu: 'pricebook', notes: 'Price books' },
    PricebookEntry: { prolibu: 'pricebookentry', notes: 'Price per product per pricebook' },
    OpportunityLineItem: { prolibu: 'lineitem', notes: 'Line items in deals/quotes' },
    ProductFamily: { prolibu: 'productfamily', notes: 'Product families' },
    // Activities
    Task: { prolibu: 'task', notes: 'Tasks and to-dos' },
    Event: { prolibu: 'meeting', notes: 'Calendar events / meetings' },
    Note: { prolibu: 'note', notes: 'Notes attached to records' },
    Call: { prolibu: 'call', notes: 'Call logs' },
    // Marketing
    Campaign: { prolibu: 'campaign', notes: 'Marketing campaigns' },
    CampaignMember: { prolibu: 'attendee', notes: 'Campaign participants' },
    // People & teams
    User: { prolibu: 'user', notes: 'Internal users / reps' },
    Group: { prolibu: 'group', notes: 'User groups / teams' },
    // Invoicing
    Invoice: { prolibu: 'invoice', notes: 'Invoices (if SF Billing active)' },
};

const REVIEW_PORT = 3721;
const UI_FILE = path.join(__dirname, '../review-ui/index.html');

// ─── Prolibu API helpers ──────────────────────────────────────────

/**
 * GET /v2/<urlPath> on the Prolibu domain.
 * Returns the parsed JSON body, or rejects on network / parse error.
 */
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

/**
 * POST /v2/<urlPath> on the Prolibu domain with a JSON body.
 * Returns the parsed JSON body.
 */
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

// ─── Phase handler ────────────────────────────────────────────────

/**
 * Phase: review
 *
 * Starts a local web server (http://localhost:3721) with an interactive SPA
 * that shows:
 *
 *   📊 Schema Map      — clickable list of every SF object from discovery.json.
 *                        Selecting one shows a field-level comparison table
 *                        against the matching Prolibu entity schema.
 *
 *   ⚙️  Config Builder — toggle entities on/off, select the fields for each
 *                        SOQL SELECT, add WHERE filters, map custom SF objects
 *                        to Prolibu entities.  Produces two output files:
 *                          • config.json        — migration runtime config
 *                          • prolibu_setup.json — list of custom objects /
 *                            custom fields that must be created in Prolibu
 *                            before the migrate phase runs.
 *
 *   🟦 Prolibu Schema  — entities and their fields from /v2/openapi/specification
 *                        so you can see exactly what Prolibu already supports.
 *
 * Keeps the process alive until the user clicks "Cerrar servidor" in the UI
 * or presses Ctrl+C.
 *
 * Does NOT reconnect to Salesforce — reads discovery.json from disk only.
 * Run `--phase discover` first.
 *
 * @param {object} context
 * @param {string}  context.domain
 * @param {string}  [context.apiKey]  — needed to fetch the Prolibu schema
 */
async function review({ domain, apiKey }) {
    // 1. Guard — discovery must exist
    const discovery = credentialStore.loadDiscovery(domain, 'salesforce');
    if (!discovery) {
        console.error(`\n❌ No discovery.json found for "${domain}".`);
        console.error(`   Run first:\n   ./prolibu migrate salesforce run --domain ${domain} --phase discover\n`);
        process.exit(1);
    }

    // 2. Load current config (may be null — UI will start from empty)
    const existingConfig = credentialStore.getConfig(domain, 'salesforce') || {};

    // 3. Fetch Prolibu OpenAPI spec for field-level schema comparison
    let prolibuSpec = null;
    if (apiKey) {
        console.log('🔍 Obteniendo schema de Prolibu...');
        try {
            prolibuSpec = await prolibuGet(domain, apiKey, 'openapi/specification');
            const schemaCount = Object.keys(prolibuSpec?.components?.schemas || {}).length;
            console.log(`   ✅ ${schemaCount} entidades encontradas en Prolibu`);
        } catch (e) {
            console.log(`   ⚠️  No se pudo cargar el schema: ${e.message}`);
            console.log('       El Config Builder y Schema Map seguirán funcionando.\n');
        }
    }
    console.log('');

    // 4. Output file paths
    const configPath = credentialStore.getConfigPath(domain, 'salesforce');
    const setupPath = path.join(path.dirname(configPath), 'prolibu_setup.json');

    // 5. State object served to the browser on every /api/state request
    const initialState = {
        domain,
        discovery,
        config: existingConfig,
        prolibuSpec,
        sfToProlibu: SF_TO_PROLIBU,
        paths: { config: configPath, setup: setupPath },
    };

    // 6. Read the SPA HTML from disk
    const uiHtml = fs.readFileSync(UI_FILE, 'utf8');

    // 7. Start HTTP server — keep process alive until user closes it
    await new Promise((resolve) => {
        const server = http.createServer(async (req, res) => {
            const urlObj = new URL(req.url, `http://localhost:${REVIEW_PORT}`);
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

            // ── Routes ─────────────────────────────────────────────

            // Serve the SPA shell
            if (method === 'GET' && pathname === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end(uiHtml);
            }

            // State consumed by the SPA on mount
            if (method === 'GET' && pathname === '/api/state') {
                return ok(initialState);
            }

            // Persist config.json (overwrite = true)
            if (method === 'POST' && pathname === '/api/save-config') {
                const body = await readBody();
                credentialStore.saveConfig(domain, 'salesforce', body, /* overwrite */ true);
                console.log(`💾 config.json guardado → ${configPath}`);
                return ok({ ok: true, path: configPath });
            }

            // Persist prolibu_setup.json
            if (method === 'POST' && pathname === '/api/save-setup') {
                const body = await readBody();
                fs.mkdirSync(path.dirname(setupPath), { recursive: true });
                fs.writeFileSync(setupPath, JSON.stringify(body, null, 2));
                console.log(`💾 prolibu_setup.json guardado → ${setupPath}`);
                return ok({ ok: true, path: setupPath });
            }

            // Proxy: create a custom field in Prolibu
            // Expected body: { entity, apiName, label, type }
            if (method === 'POST' && pathname === '/api/prolibu/create-field') {
                if (!apiKey) return fail(400, 'No apiKey available — re-run with --apikey');
                const body = await readBody();
                try {
                    const result = await prolibuPost(domain, apiKey, 'custom-fields', body);
                    return ok(result);
                } catch (e) { return fail(500, e.message); }
            }

            // Proxy: create a custom object in Prolibu
            // Expected body: { prolibuEntity, label, sourceSObject }
            if (method === 'POST' && pathname === '/api/prolibu/create-object') {
                if (!apiKey) return fail(400, 'No apiKey available — re-run with --apikey');
                const body = await readBody();
                try {
                    const result = await prolibuPost(domain, apiKey, 'custom-objects', body);
                    return ok(result);
                } catch (e) { return fail(500, e.message); }
            }

            // Graceful shutdown — called by the UI "Cerrar servidor" button
            if (method === 'POST' && pathname === '/api/done') {
                ok({ ok: true });
                server.close();
                console.log('\n✅ Servidor de review cerrado.');
                resolve();
                return;
            }

            fail(404, 'Not found');
        });

        server.listen(REVIEW_PORT, '127.0.0.1', () => {
            const url = `http://localhost:${REVIEW_PORT}`;
            console.log(`🌐 Review UI disponible en:`);
            console.log(`   ${url}\n`);
            console.log('   Ctrl+C  o  haz clic en "Cerrar servidor" en el UI para salir.\n');
            // Auto-open browser (macOS / Linux / Windows)
            const open = process.platform === 'win32' ? 'start'
                : process.platform === 'darwin'  ? 'open'
                : 'xdg-open';
            require('child_process').exec(`${open} "${url}"`);
        });

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`\n❌ Puerto ${REVIEW_PORT} ya está en uso.`);
                console.error('   Cierra la instancia anterior e intenta de nuevo.\n');
                process.exit(1);
            }
            throw err;
        });
    });
}

module.exports = review;
