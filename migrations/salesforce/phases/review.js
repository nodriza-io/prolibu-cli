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
const UI_DIR = path.join(__dirname, '../../review-ui/dist');
const UI_LEGACY = path.join(__dirname, '../../review-ui/index.legacy.html');

// MIME types for static file serving
const MIME = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

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

    // 6. Check for React dist/ or legacy fallback
    const hasReactBuild = fs.existsSync(path.join(UI_DIR, 'index.html'));
    const REVIEW_UI_ROOT = path.join(__dirname, '../../review-ui');
    let viteProcess = null;

    // Helper: serve a static file from the React build
    function serveStatic(res, filePath) {
        const ext = path.extname(filePath);
        const mime = MIME[ext] || 'application/octet-stream';
        try {
            const content = fs.readFileSync(filePath);
            res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
            res.end(content);
        } catch {
            // SPA fallback — serve index.html for client-side routes
            if (hasReactBuild) {
                const idx = fs.readFileSync(path.join(UI_DIR, 'index.html'));
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(idx);
            } else {
                res.writeHead(404);
                res.end('Not found');
            }
        }
    }

    // SSE clients for migration log streaming
    const sseClients = new Set();

    function broadcastSSE(data) {
        const msg = `data: ${JSON.stringify(data)}\n\n`;
        for (const client of sseClients) {
            try { client.write(msg); } catch { sseClients.delete(client); }
        }
    }

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

            // Serve the React SPA or legacy HTML
            if (method === 'GET' && !pathname.startsWith('/api')) {
                if (hasReactBuild) {
                    // Try exact file, else SPA fallback
                    const filePath = pathname === '/'
                        ? path.join(UI_DIR, 'index.html')
                        : path.join(UI_DIR, pathname);
                    return serveStatic(res, filePath);
                } else {
                    // Fallback to legacy
                    const legacy = fs.readFileSync(UI_LEGACY, 'utf8');
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    return res.end(legacy);
                }
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

            // ── Pipeline introspection ─────────────────────────────
            if (method === 'GET' && pathname === '/api/pipelines') {
                try {
                    const pipelinesDir = credentialStore.getPipelinePath
                        ? path.dirname(credentialStore.getPipelinePath(domain, 'salesforce', '_'))
                        : path.join(path.dirname(configPath), 'pipelines');
                    const transformersDir = path.join(path.dirname(configPath), 'transformers');

                    const result = {};

                    // Scan pipeline files
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

                    // Scan transformer files (these inject as default pipelines)
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

            // ── Migration execution ────────────────────────────────
            if (method === 'POST' && pathname === '/api/migrate') {
                const body = await readBody();
                const entities = body.entities || [];
                const dryRun = body.dryRun !== false;

                if (!entities.length) return fail(400, 'No entities specified');

                // Acknowledge immediately, then run async
                ok({ ok: true, message: 'Migration started', dryRun });

                // Run migration in background, streaming events via SSE
                setImmediate(async () => {
                    try {
                        const { run } = require('../engine');
                        // Override console.log to capture and broadcast logs
                        const origLog = console.log;
                        console.log = (...args) => {
                            const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
                            origLog(...args);
                            broadcastSSE({ type: 'log', data: line });
                        };

                        await run({
                            domain,
                            apiKey,
                            entities,
                            dryRun,
                            onEntityResult: (entityKey, result) => {
                                broadcastSSE({ type: 'result', data: { entity: entityKey, ...result } });
                            },
                        });

                        broadcastSSE({ type: 'done', data: 'Migration completed' });
                        console.log = origLog;
                    } catch (e) {
                        broadcastSSE({ type: 'error', data: e.message });
                        broadcastSSE({ type: 'done', data: 'Migration failed' });
                    }
                });
                return;
            }

            // SSE endpoint for real-time migration logs
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

            // Graceful shutdown — called by the UI "Cerrar servidor" button
            if (method === 'POST' && pathname === '/api/done') {
                ok({ ok: true });
                if (viteProcess) { viteProcess.kill(); viteProcess = null; }
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

            if (!hasReactBuild) {
                // Auto-start Vite dev server — single command experience
                const { spawn } = require('child_process');
                const viteUrl = 'http://localhost:5173';
                console.log(`   ${viteUrl}  (Vite dev mode)\n`);
                console.log(`   API backend en ${url}`);
                console.log('   Ctrl+C para cerrar todo.\n');

                viteProcess = spawn('npx', ['vite'], {
                    cwd: REVIEW_UI_ROOT,
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
                    console.error(`     Ejecuta "cd review-ui && npm run dev" manualmente.\n`);
                });

                // Wait a moment for Vite to start, then open browser
                setTimeout(() => {
                    const open = process.platform === 'win32' ? 'start'
                        : process.platform === 'darwin' ? 'open'
                            : 'xdg-open';
                    require('child_process').exec(`${open} "${viteUrl}"`);
                }, 2000);
            } else {
                console.log(`   ${url}\n`);
                console.log('   Ctrl+C  o  haz clic en "Cerrar servidor" en el UI para salir.\n');
                const open = process.platform === 'win32' ? 'start'
                    : process.platform === 'darwin' ? 'open'
                        : 'xdg-open';
                require('child_process').exec(`${open} "${url}"`);
            }
        });

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`\n❌ Puerto ${REVIEW_PORT} ya está en uso.`);
                console.error('   Cierra la instancia anterior e intenta de nuevo.\n');
                process.exit(1);
            }
            throw err;
        });

        // Clean up Vite on Ctrl+C
        process.on('SIGINT', () => {
            if (viteProcess) { viteProcess.kill(); viteProcess = null; }
            server.close();
            console.log('\n✅ Servidor de review cerrado.');
            resolve();
        });
    });
}

module.exports = review;
