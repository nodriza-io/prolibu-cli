#!/usr/bin/env node
/**
 * Simulates the exact queries the migration makes against Company in Prolibu.
 * Measures response times and payload sizes to identify bottlenecks.
 *
 * Usage:
 *   node scripts/simulate-company-query.js [--domain stg.prolibu.com] [--chunk 50] [--max 200]
 */
const ProlibuApi = require('../lib/vendors/prolibu/ProlibuApi');
const rawAccounts = require('../accounts/stg.prolibu.com/migrations/salesforce/logs/accounts-raw.json');

// ── Parse CLI args ──────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const DOMAIN = getArg('domain', 'stg.prolibu.com');
const CHUNK_SIZE = parseInt(getArg('chunk', '50'), 10);
const MAX_IDS = parseInt(getArg('max', '200'), 10);

const profile = require(`../accounts/${DOMAIN}/profile.json`);

async function main() {
    const api = new ProlibuApi({ domain: DOMAIN, apiKey: profile.apiKey });

    const allRefIds = rawAccounts.map(r => r.Id).filter(Boolean);
    const testIds = allRefIds.slice(0, MAX_IDS);

    console.log(`\n🔬 Simulación de queries de Company en ${DOMAIN}`);
    console.log(`   Total accounts en log: ${allRefIds.length}`);
    console.log(`   IDs a probar: ${testIds.length}`);
    console.log(`   Chunk size: ${CHUNK_SIZE}\n`);

    // ─── TEST 1: OpenAPI spec fetch ───────────────────────────
    console.log('━━━ TEST 1: OpenAPI spec fetch ━━━');
    {
        const start = Date.now();
        const res = await api.axios.get(`${api.prefix}/openapi/specification`);
        const elapsed = Date.now() - start;
        const size = JSON.stringify(res.data).length;
        const schemaCount = Object.keys(res.data?.components?.schemas || {}).length;
        console.log(`   ⏱  ${elapsed}ms`);
        console.log(`   📦 Payload: ${(size / 1024).toFixed(1)} KB`);
        console.log(`   📋 Schemas: ${schemaCount}\n`);
    }

    // ─── TEST 2: Bulk prefetch — xquery { refId: { $in: chunk } } ──
    console.log('━━━ TEST 2: Bulk prefetch (xquery $in) ━━━');
    const chunkTimings = [];
    let totalFound = 0;
    for (let i = 0; i < testIds.length; i += CHUNK_SIZE) {
        const chunk = testIds.slice(i, i + CHUNK_SIZE);
        const start = Date.now();
        try {
            const res = await api.find('Company', {
                xquery: JSON.stringify({ refId: { $in: chunk } }),
                select: '_id refId',
                limit: CHUNK_SIZE,
            });
            const elapsed = Date.now() - start;
            const rows = Array.isArray(res) ? res : (res?.data || []);
            totalFound += rows.length;
            chunkTimings.push({ chunk: i / CHUNK_SIZE + 1, size: chunk.length, found: rows.length, ms: elapsed });
            console.log(`   Chunk ${chunkTimings.length}: ${chunk.length} IDs → ${rows.length} found, ${elapsed}ms`);
        } catch (err) {
            const elapsed = Date.now() - start;
            console.log(`   Chunk ${i / CHUNK_SIZE + 1}: ❌ ERROR ${elapsed}ms — ${err.message}`);
            chunkTimings.push({ chunk: i / CHUNK_SIZE + 1, size: chunk.length, found: 0, ms: elapsed, error: err.message });
        }
    }
    const avgMs = chunkTimings.reduce((s, t) => s + t.ms, 0) / chunkTimings.length;
    console.log(`\n   📊 Resumen prefetch:`);
    console.log(`      Chunks: ${chunkTimings.length}`);
    console.log(`      Total found: ${totalFound}/${testIds.length}`);
    console.log(`      Avg: ${avgMs.toFixed(0)}ms/chunk`);
    console.log(`      Min: ${Math.min(...chunkTimings.map(t => t.ms))}ms`);
    console.log(`      Max: ${Math.max(...chunkTimings.map(t => t.ms))}ms`);
    console.log(`      Total: ${chunkTimings.reduce((s, t) => s + t.ms, 0)}ms`);

    const fullChunks = Math.ceil(allRefIds.length / CHUNK_SIZE);
    const estimatedTotal = avgMs * fullChunks;
    console.log(`\n   🔮 Extrapolación a ${allRefIds.length} IDs:`);
    console.log(`      ${fullChunks} chunks × ${avgMs.toFixed(0)}ms = ~${(estimatedTotal / 1000).toFixed(1)}s\n`);

    // ─── TEST 3: buildIdMap query (chunk=200) ─────────────────
    console.log('━━━ TEST 3: buildIdMap query (chunk=200) ━━━');
    {
        const bigChunk = testIds.slice(0, 200);
        const start = Date.now();
        try {
            const res = await api.find('Company', {
                xquery: JSON.stringify({ refId: { $in: bigChunk } }),
                select: '_id refId',
                limit: 200,
            });
            const elapsed = Date.now() - start;
            const rows = Array.isArray(res) ? res : (res?.data || []);
            console.log(`   200 IDs → ${rows.length} found, ${elapsed}ms`);
        } catch (err) {
            const elapsed = Date.now() - start;
            console.log(`   ❌ ERROR ${elapsed}ms — ${err.message}`);
        }
        console.log();
    }

    // ─── TEST 4: Single record xquery lookup ──────────────────
    console.log('━━━ TEST 4: Single record xquery lookup ━━━');
    {
        const singleId = testIds[0];
        const start = Date.now();
        try {
            const res = await api.find('Company', {
                xquery: JSON.stringify({ refId: singleId }),
                select: '_id refId',
                limit: 1,
            });
            const elapsed = Date.now() - start;
            const rows = Array.isArray(res) ? res : (res?.data || []);
            console.log(`   refId="${singleId}" → ${rows.length} found, ${elapsed}ms`);
        } catch (err) {
            const elapsed = Date.now() - start;
            console.log(`   ❌ ERROR ${elapsed}ms — ${err.message}`);
        }
        console.log();
    }

    // ─── TEST 5: Baseline find (no xquery) ────────────────────
    console.log('━━━ TEST 5: Baseline find (no xquery) ━━━');
    {
        const start = Date.now();
        try {
            const res = await api.find('Company', { select: '_id refId', limit: 50 });
            const elapsed = Date.now() - start;
            const rows = Array.isArray(res) ? res : (res?.data || []);
            console.log(`   limit=50, no filter → ${rows.length} found, ${elapsed}ms`);
        } catch (err) {
            const elapsed = Date.now() - start;
            console.log(`   ❌ ERROR ${elapsed}ms — ${err.message}`);
        }
        console.log();
    }

    console.log('✅ Simulación completa\n');
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
