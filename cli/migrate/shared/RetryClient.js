'use strict';

const sleep = require('../../../lib/utils/sleep');

const DEFAULT_MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Executes an async function with exponential backoff retry.
 * Only retries on HTTP 429 (rate-limit) or 5xx (server-error) responses.
 *
 * Delays: attempt 0 → 1 s, attempt 1 → 2 s, attempt 2 → 4 s
 *
 * @param {() => Promise<*>} fn           - Async operation to execute
 * @param {object}           [opts]
 * @param {number}           [opts.maxRetries=3]    - Max number of retries (not attempts)
 * @param {number}           [opts.baseDelayMs=1000] - Base delay in ms; doubles each attempt
 * @returns {Promise<*>}
 * @throws  The last error if all retries are exhausted or the error is not retryable
 */
async function withRetry(fn, { maxRetries = DEFAULT_MAX_RETRIES, baseDelayMs = BASE_DELAY_MS } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const status = err?.response?.status ?? err?.statusCode ?? err?.status;
            const retryable = status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);

            if (!retryable || attempt === maxRetries) throw err;

            lastErr = err;
            const delay = baseDelayMs * Math.pow(2, attempt);
            console.log(`   ⚠️  HTTP ${status} — retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
            await sleep(delay);
        }
    }
    throw lastErr;
}

module.exports = { withRetry };
