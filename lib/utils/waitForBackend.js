'use strict';

const axios = require('axios');

/**
 * Wait for the Prolibu backend to recover after a COB create/delete triggers a restart.
 * Polls GET /v2/cob?limit=1 until a 200 response is received.
 *
 * @param {string} domain
 * @param {string} apiKey
 * @param {object} [opts]
 * @param {number} [opts.initialDelay=15000]  ms to wait before first poll
 * @param {number} [opts.intervalMs=5000]     ms between polls
 * @param {number} [opts.maxWaitMs=60000]     total wait budget after initial delay
 */
async function waitForBackend(domain, apiKey, { initialDelay = 15000, intervalMs = 5000, maxWaitMs = 60000 } = {}) {
    await new Promise((r) => setTimeout(r, initialDelay));
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        try {
            await axios.get(`https://${domain}/v2/cob?limit=1`, {
                headers: { Authorization: `Bearer ${apiKey}` },
                timeout: 5000,
            });
            return; // backend is up
        } catch {
            await new Promise((r) => setTimeout(r, intervalMs));
        }
    }
    throw new Error(`Backend did not recover within ${(initialDelay + maxWaitMs) / 1000}s`);
}

module.exports = waitForBackend;
