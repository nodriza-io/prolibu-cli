const sleep = require('./sleep');
const { handleAxiosError } = require('../vendors/prolibu/utils');

// Política de docs/integrations-for-ai-agents/11-best-practices.md §2.3:
// 5xx y 429 se reintentan; 400/401/403/404/409/422 son deterministas y no.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Decide si un error normalizado por handleAxiosError merece reintento.
 * - 'network' cubre timeouts de axios (ECONNABORTED) y caídas de conexión.
 * - 'unknown' es un error de programación (TypeError, etc.): reintentarlo solo repite el bug.
 */
function isRetryable(err) {
  if (!err) return false;
  if (err.type === 'network') return true;
  if (err.type === 'http') return RETRYABLE_STATUS.has(err.statusCode);
  return false;
}

/**
 * Lee Retry-After (segundos) de la respuesta original, si el servidor lo mandó.
 * handleAxiosError no propaga headers, pero sí conserva el error original.
 */
function retryAfterMs(err) {
  const headers = err?.originalError?.response?.headers;
  const raw = headers && (headers['retry-after'] || headers['Retry-After']);
  const secs = Number(raw);
  return Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, 8000) : 0;
}

/**
 * Ejecuta una operación idempotente reintentándola con backoff exponencial + jitter.
 *
 * @param {Function} fn                  async; se re-invoca en cada intento, recibe el nº de intento
 * @param {Object}   [opts]
 * @param {number}   [opts.retries=2]    reintentos DESPUÉS del primer intento (2 => 3 intentos)
 * @param {string}   [opts.label]        etiqueta para los logs
 * @param {number}   [opts.deadline]     timestamp absoluto; si dormir lo excedería, aborta ya.
 *                                       Evita el "unbounded retry loop" que revienta el timeout
 *                                       del script (09-connecting-external-services.md §462).
 * @returns {Promise<*>} lo que devuelva fn
 * @throws  el error normalizado (con .type / .statusCode / .details)
 */
async function withRetry(fn, opts = {}) {
  const { retries = 2, label = 'request', deadline = Infinity } = opts;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (rawErr) {
      // ProlibuApi ya lanza errores normalizados; no re-envolver.
      const err = rawErr && rawErr.type ? rawErr : handleAxiosError(rawErr);

      if (attempt >= retries || !isRetryable(err)) throw err;

      // base 500 ms en vez de los 250 del doc: un 502 es saturación, conviene dar aire.
      const backoff = retryAfterMs(err) || Math.min(2 ** attempt * 500, 4000);
      const delay = backoff + Math.floor(Math.random() * 250); // jitter

      if (Date.now() + delay >= deadline) {
        console.warn(`⏱️ ${label}: sin presupuesto para reintentar (${err.message})`);
        throw err;
      }

      console.warn(`⚠️ ${label}: ${err.message} — reintento ${attempt + 1}/${retries} en ${delay}ms`);
      await sleep(delay);
    }
  }
}

module.exports = { withRetry, isRetryable, RETRYABLE_STATUS };
