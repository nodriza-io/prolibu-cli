'use strict';

const sleep = require('../../../lib/utils/sleep');

const DEFAULT_MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

/**
 * Executes an async function with exponential backoff retry.
 * Only retries on HTTP 429 (rate-limit) or 5xx (server-error) responses.
 *
 * For 5xx errors, uses a steeper backoff (base × 3^attempt) to give the
 * server more recovery time.  For 429, uses the standard 2^attempt curve.
 *
 * @param {() => Promise<*>} fn           - Async operation to execute
 * @param {object}           [opts]
 * @param {number}           [opts.maxRetries=5]    - Max number of retries (not attempts)
 * @param {number}           [opts.baseDelayMs=1000] - Base delay in ms
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
            // 5xx: steeper backoff (3^n → 1s, 3s, 9s, 27s, 81s)
            // 429: standard backoff (2^n → 1s, 2s, 4s, 8s, 16s)
            const factor = (status >= 500) ? Math.pow(3, attempt) : Math.pow(2, attempt);
            const delay = baseDelayMs * factor;
            console.log(`   ⚠️  HTTP ${status} — retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
            await sleep(delay);
        }
    }
    throw lastErr;
}

module.exports = { withRetry };
