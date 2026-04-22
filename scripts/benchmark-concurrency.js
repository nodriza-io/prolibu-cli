#!/usr/bin/env node
'use strict';

/**
 * Benchmark: optimal concurrency for Prolibu migration
 *
 * Tests different concurrency levels (+ batchDelay combos) against the
 * destination API using real UPDATE operations on already-migrated products.
 *
 * Usage:
 *   node scripts/benchmark-concurrency.js --domain dev12.prolibu.com
 */

const ProlibuApi = require('../lib/vendors/prolibu/ProlibuApi');
const fs = require('fs');
const path = require('path');

// ── Config ─────────────────────────────────────────────────────
const DOMAIN = process.argv.find((a, i) => process.argv[i - 1] === '--domain') || 'dev12.prolibu.com';
const MODEL = 'Product'; // safe entity with lots of records
const SAMPLE_SIZE = 30;  // records to update per scenario
const CONCURRENCY_LEVELS = [1, 3, 5, 8, 10, 15, 20];
const BATCH_DELAYS = [0, 200, 500]; // ms between concurrent batches

// ── Helpers ────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function extractDocs(res) {
    if (Array.isArray(res)) return res;
    if (res?.docs) return res.docs;
    if (res?.data?.docs) return res.data.docs;
    if (res?.data && Array.isArray(res.data)) return res.data;
    return [];
}

async function runScenario(api, records, concurrency, batchDelay) {
    const results = { success: 0, errors: 0, statuses: {} };
    const timings = [];
    let processed = 0;

    for (let i = 0; i < records.length; i += concurrency) {
        const chunk = records.slice(i, i + concurrency);
        const batchStart = Date.now();

        const settled = await Promise.allSettled(chunk.map(async (rec) => {
            const start = Date.now();
            try {
                // Trivial no-op update: set refId (idempotent)
                await api.axios.patch(`${api.prefix}/${MODEL}/${rec._id}`, {
                    refId: rec.refId || rec._id,
                });
                const elapsed = Date.now() - start;
                timings.push(elapsed);
                results.success++;
                return elapsed;
            } catch (err) {
                const elapsed = Date.now() - start;
                timings.push(elapsed);
                const status = err?.response?.status || 'network';
                results.statuses[status] = (results.statuses[status] || 0) + 1;
                results.errors++;
                return elapsed;
            }
        }));

        processed += chunk.length;

        if (batchDelay > 0 && i + concurrency < records.length) {
            await sleep(batchDelay);
        }
    }

    timings.sort((a, b) => a - b);
    const totalTime = timings.reduce((s, t) => s + t, 0);
    const avg = Math.round(totalTime / timings.length);
    const p50 = timings[Math.floor(timings.length * 0.5)];
    const p90 = timings[Math.floor(timings.length * 0.9)];
    const p99 = timings[Math.floor(timings.length * 0.99)] || timings[timings.length - 1];
    const wallClock = Date.now(); // will be measured externally

    return { ...results, avg, p50, p90, p99, timings, totalTimings: totalTime };
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
    // Load API key from profile
    const profilePath = path.join(process.cwd(), 'accounts', DOMAIN, 'profile.json');
    if (!fs.existsSync(profilePath)) {
        console.error(`❌ Profile not found: ${profilePath}`);
        process.exit(1);
    }
    const { apiKey } = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    const api = new ProlibuApi({ domain: DOMAIN, apiKey, avoidThrottle: true });

    // Health check
    console.log(`🔍 Target: ${DOMAIN} (avoidThrottle: true)`);
    try {
        const res = await api.axios.get(`${api.prefix}/openapi/specification`);
        console.log(`✅ API reachable\n`);
    } catch (err) {
        console.error(`❌ API unreachable: ${err.message}`);
        process.exit(1);
    }

    // Fetch sample products
    console.log(`📥 Fetching ${SAMPLE_SIZE} ${MODEL} records for benchmarking...`);
    const res = await api.find(MODEL, { select: '_id refId productName', limit: SAMPLE_SIZE, sort: '_id' });
    const records = extractDocs(res);
    if (records.length < SAMPLE_SIZE) {
        console.warn(`⚠️  Only ${records.length} records available (wanted ${SAMPLE_SIZE})`);
    }
    console.log(`   Got ${records.length} records\n`);

    // Warmup: 3 sequential requests to establish connection pool
    console.log(`🔥 Warmup: 3 sequential requests...`);
    for (let w = 0; w < 3; w++) {
        try {
            await api.axios.patch(`${api.prefix}/${MODEL}/${records[0]._id}`, { refId: records[0].refId || records[0]._id });
        } catch { /* ignore */ }
        await sleep(200);
    }
    console.log(`   Done\n`);

    // ── Run scenarios ────────────────────────────────────────────
    const report = [];

    for (const concurrency of CONCURRENCY_LEVELS) {
        for (const batchDelay of BATCH_DELAYS) {
            const label = `c=${concurrency} delay=${batchDelay}ms`;
            process.stdout.write(`⏱️  ${label.padEnd(22)} ... `);

            const wallStart = Date.now();
            const result = await runScenario(api, records, concurrency, batchDelay);
            const wallMs = Date.now() - wallStart;
            const throughput = ((result.success / wallMs) * 1000).toFixed(2);

            const row = {
                concurrency,
                batchDelay,
                wallMs,
                throughput: parseFloat(throughput),
                success: result.success,
                errors: result.errors,
                errorStatuses: result.statuses,
                avgMs: result.avg,
                p50: result.p50,
                p90: result.p90,
                p99: result.p99,
            };
            report.push(row);

            const errInfo = result.errors > 0 ? ` ❌ ${result.errors} errors ${JSON.stringify(result.statuses)}` : '';
            console.log(
                `${wallMs}ms wall | ${throughput} rec/s | avg ${result.avg}ms | p50 ${result.p50}ms | p90 ${result.p90}ms | p99 ${result.p99}ms${errInfo}`
            );

            // Cooldown between scenarios
            await sleep(2000);
        }
        console.log('');
    }

    // ── Summary ──────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(80));
    console.log('📊 BENCHMARK SUMMARY');
    console.log('═'.repeat(80));
    console.log('');
    console.log(
        'Concurrency'.padEnd(12) +
        'Delay'.padEnd(8) +
        'Wall(ms)'.padEnd(10) +
        'rec/s'.padEnd(10) +
        'Avg(ms)'.padEnd(10) +
        'P50'.padEnd(8) +
        'P90'.padEnd(8) +
        'P99'.padEnd(8) +
        'Errors'.padEnd(8)
    );
    console.log('─'.repeat(80));

    for (const r of report) {
        console.log(
            String(r.concurrency).padEnd(12) +
            String(r.batchDelay).padEnd(8) +
            String(r.wallMs).padEnd(10) +
            String(r.throughput).padEnd(10) +
            String(r.avgMs).padEnd(10) +
            String(r.p50).padEnd(8) +
            String(r.p90).padEnd(8) +
            String(r.p99).padEnd(8) +
            String(r.errors).padEnd(8)
        );
    }

    // Best throughput with zero errors
    const zeroErrors = report.filter(r => r.errors === 0);
    if (zeroErrors.length) {
        const best = zeroErrors.reduce((a, b) => a.throughput > b.throughput ? a : b);
        console.log('');
        console.log(`🏆 Best (0 errors): concurrency=${best.concurrency}, batchDelay=${best.batchDelay}ms → ${best.throughput} rec/s`);
    }

    // Best throughput with <5% error rate
    const lowErr = report.filter(r => r.errors / SAMPLE_SIZE < 0.05);
    if (lowErr.length) {
        const best = lowErr.reduce((a, b) => a.throughput > b.throughput ? a : b);
        console.log(`🥈 Best (<5% err): concurrency=${best.concurrency}, batchDelay=${best.batchDelay}ms → ${best.throughput} rec/s`);
    }

    // Save raw results
    const outPath = path.join(process.cwd(), 'scripts', 'benchmark-results.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\n💾 Raw results saved to ${outPath}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
