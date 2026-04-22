const path = require('path');
const fs = require('fs');
const cliProgress = require('cli-progress');
const ProlibuApi = require('../../../lib/vendors/prolibu/ProlibuApi');
const SchemaSetup = require('../../../lib/vendors/prolibu/SchemaSetup');
const sleep = require('../../../lib/utils/sleep');
const { withRetry } = require('./RetryClient');

const CONCURRENT_BATCH_SIZE = 1;

// Fields that are internal/meta and should never be validated against the schema
const META_FIELDS = new Set([
  '_id', '_source', '_joined', '__v', 'createdAt', 'updatedAt',
  'createdBy', 'updatedBy', 'status',
]);

/**
 * Get top-level keys from a record (dot-notation prefix = first segment only).
 * Excludes meta/internal fields.
 */
function getRecordFieldKeys(record) {
  return Object.keys(record)
    .map(k => k.includes('.') ? k.split('.')[0] : k)
    .filter(k => !META_FIELDS.has(k) && !k.startsWith('_'))
    .filter((k, i, arr) => arr.indexOf(k) === i); // unique
}

/**
 * Expand dot-notation keys into nested objects.
 * e.g. { "proposal.quote.lineItems": [...] } → { proposal: { quote: { lineItems: [...] } } }
 */
function expandDotNotation(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!key.includes('.')) {
      result[key] = value;
      continue;
    }
    const parts = key.split('.');
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] === undefined || current[parts[i]] === null) {
        current[parts[i]] = {};
      } else if (typeof current[parts[i]] !== 'object' || Array.isArray(current[parts[i]])) {
        // Don't overwrite non-object values
        break;
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }
  return result;
}

/**
 * Extract docs array from Prolibu API response.
 * Handles both paginated responses ({ docs: [...] }) and raw arrays.
 */
function extractDocs(res) {
  return Array.isArray(res) ? res : (res?.docs || res?.data || []);
}

/**
 * Batch writer for Prolibu that wraps ProlibuApi.
 * Handles findOneOrCreate logic (update if exists, create if not) and dry-run mode.
 * Also provides convenience methods for schema setup (custom fields & custom objects).
 */
class ProlibuWriter {
  /**
   * @param {object} options
   * @param {string} options.domain  - Prolibu domain (e.g. dev10.prolibu.com)
   * @param {string} options.apiKey  - Prolibu API key
   * @param {boolean} [options.dryRun=false] - If true, no writes are performed
   */
  constructor({ domain, apiKey, dryRun = false }) {
    this.domain = domain;
    this.dryRun = dryRun;
    this.api = new ProlibuApi({ domain, apiKey, avoidThrottle: true });
    this._schemaSetup = new SchemaSetup({ domain, apiKey, dryRun });
    this._openApiSpec = null; // Cache for OpenAPI specification
  }

  /**
   * Health check: hit /version to verify the Prolibu backend is reachable.
   * Throws if the server is down or responds with a non-2xx status.
   */
  async healthCheck() {
    try {
      const res = await this.api.axios.get('/version', { timeout: 10000 });
      return res.data;
    } catch (err) {
      const status = err?.response?.status;
      const msg = status
        ? `Prolibu health check failed: HTTP ${status}`
        : `Prolibu health check failed: ${err.message}`;
      throw new Error(msg);
    }
  }

  /**
   * Write a batch of records to a Prolibu model.
   * Uses upsert by refId when idField is provided (update if exists, create if not),
   * otherwise plain create.
   *
   * @param {string}     model           - Prolibu model name (e.g. 'Contact', 'Product')
   * @param {object[]}   records         - Array of transformed records ready to write
   * @param {object}     [options]
   * @param {string}     [options.idField]    - Field in the record holding the source system ID
   * @param {Function}   [options.onProgress] - Callback(progressData) called after each record
   * @param {IdMapStore} [options.idStore]    - Persistent map to save sourceId→prolibuId after each write
   * @param {number}     [options.batchDelay=0] - Delay in ms between concurrent batches (default 0)
   * @param {number}     [options.concurrency]   - Max concurrent requests per batch (overrides CONCURRENT_BATCH_SIZE)
   *
   * @returns {Promise<{ migrated: number, updated: number, created: number, skipped: number, errors: string[] }>}
   */
  async writeBatch(model, records, { idField, onProgress, idStore, batchDelay = 0, concurrency, recordDelay = 0, maxRetries, cooldownMs = 30000, consecutiveErrorsBeforeCooldown = 3, errorThreshold = 0, prefetchOnly = false, altLookupField } = {}) {
    const result = { migrated: 0, updated: 0, created: 0, skipped: 0, errors: [], resumed: 0 };

    // Log target domain for first record batch
    if (records.length > 0 && !this.dryRun) {
      console.log(`📤 Writing ${records.length} ${model} records to https://${this.domain}/v2/${model}`);
    }

    // ── Schema validation ─────────────────────────────────────
    // Fetch OpenAPI spec once and extract model schema for validation
    let schemaAttrs = null;
    if (records.length > 0) {
      try {
        // Use cached OpenAPI specification or fetch it
        if (!this._openApiSpec) {
          const res = await this.api.axios.get(`${this.api.prefix}/openapi/specification`);
          this._openApiSpec = res.data || {};
        }
        const schemas = this._openApiSpec?.components?.schemas || {};

        // Find schema by model name (case-insensitive)
        const modelLower = model.toLowerCase();
        const schemaKey = Object.keys(schemas).find(k => k.toLowerCase() === modelLower);

        if (schemaKey && schemas[schemaKey]?.properties) {
          schemaAttrs = schemas[schemaKey].properties;
        }
      } catch (err) {
        console.log(`   ⚠️  No se pudo validar el schema de "${model}": ${err.message}`);
      }
    }

    if (schemaAttrs) {
      // 1. Validate idField exists
      if (idField && !schemaAttrs[idField]) {
        throw new Error(`El modelo "${model}" en Prolibu no tiene el campo "${idField}". Créalo antes de migrar.`);
      }

      // 2. Validate all fields in the sample record exist in the schema
      const sample = records.find(r => r && typeof r === 'object');
      if (sample) {
        const recordKeys = getRecordFieldKeys(sample);
        const unknownFields = recordKeys.filter(k => !(k in schemaAttrs));

        if (unknownFields.length > 0) {
          // Cross-reference with local CustomField file to give a better hint
          const cfPath = path.join(
            process.cwd(), 'accounts', this.domain, 'objects', 'CustomField', `${model}.json`
          );
          let localOnly = [];
          if (fs.existsSync(cfPath)) {
            try {
              const cfDef = JSON.parse(fs.readFileSync(cfPath, 'utf8'));
              const localFieldNames = Object.keys(cfDef.customFields || {});
              localOnly = unknownFields.filter(f => localFieldNames.includes(f));
            } catch { /* ignore parse error */ }
          }

          const notLocal = unknownFields.filter(f => !localOnly.includes(f));
          const lines = [
            `\n❌ El modelo "${model}" en Prolibu no reconoce los siguientes campos:`,
            `   ${unknownFields.map(f => `"${f}"`).join(', ')}`,
            '',
          ];

          if (localOnly.length) {
            lines.push(
              `   ⚠️  Estos campos están declarados en objects/CustomField/${model}.json`,
              `       pero no se han pusheado a Prolibu todavía:`,
              `       ${localOnly.map(f => `"${f}"`).join(', ')}`,
              '',
              `   👉  Corre primero:  ./prolibu objects push --domain ${this.domain}`,
            );
          }

          if (notLocal.length) {
            lines.push(
              `   ⚠️  Estos campos no existen ni en disco ni en Prolibu:`,
              `       ${notLocal.map(f => `"${f}"`).join(', ')}`,
              '',
              `   👉  Opciones:`,
              `       A) Agrégalos en accounts/${this.domain}/objects/CustomField/${model}.json`,
              `          y luego corre:  ./prolibu objects push --domain ${this.domain}`,
              `       B) Créalos directamente en Prolibu (UI o API)`,
              `       C) Excluye estos campos del transformer devolviendo undefined para ellos`,
            );
          }

          throw new Error(lines.join('\n'));
        }
      }
    }

    // ── Auto-detect altLookupField from OpenAPI paths ────────
    // If no altLookupField was provided, detect the model's unique code field
    // from the OpenAPI spec path pattern: /v2/{model}/{codeField}
    if (!altLookupField && idField && this._openApiSpec) {
      const apiPaths = this._openApiSpec.paths || {};
      const modelLower = model.toLowerCase();
      for (const p of Object.keys(apiPaths)) {
        const parts = p.replace(/^\//, '').split('/');
        // Match /v2/{model}/{codeField}
        if (parts.length === 3 && parts[0] === 'v2'
          && parts[1].toLowerCase() === modelLower
          && parts[2].startsWith('{') && parts[2].endsWith('}')) {
          const candidate = parts[2].slice(1, -1);
          // Skip generic _id or same as idField — not useful as alt lookup
          if (candidate !== '_id' && candidate !== idField) {
            // Only use if the field exists in the schema or in the record data
            const sample = records.find(r => r && typeof r === 'object');
            const inSchema = schemaAttrs && candidate in schemaAttrs;
            const inRecord = sample && candidate in sample;
            if (inSchema || inRecord) {
              altLookupField = candidate;
              console.log(`   🔑 Auto-detected altLookupField: "${altLookupField}" (from OpenAPI path)`);
            }
          }
          break;
        }
      }
    }

    const isCLI = !onProgress;
    let bar;
    if (isCLI) {
      bar = new cliProgress.SingleBar({
        format: `   {bar} {percentage}% | {value}/{total} | ➕ {created} created | 🔄 {updated} updated | ❌ {errors} errors`,
        barCompleteChar: '█',
        barIncompleteChar: '░',
        hideCursor: true,
      });
      bar.start(records.length, 0, { created: 0, updated: 0, errors: 0 });
    }

    // ── Resume: filter out records already in idStore ─────────
    if (idField && idStore && idStore.size > 0) {
      const before = records.length;
      records = records.filter(r => {
        const sourceId = r && r[idField];
        return !sourceId || !idStore.get(sourceId);
      });
      const skippedByResume = before - records.length;
      if (skippedByResume > 0) {
        result.resumed = skippedByResume;
        console.log(`   ⏩ Resumed: ${skippedByResume} records already migrated (idStore), ${records.length} remaining`);
      }
    }

    const total = records.length;
    let processed = 0;
    let consecutiveErrors = 0;
    const retryOpts = maxRetries ? { maxRetries } : {};

    // ── Bulk prefetch: resolve all refIds upfront in chunks of 50 ──
    const PREFETCH_CHUNK = 50;
    const refIdCache = new Map(); // sourceId → prolibuId
    if (idField && !this.dryRun) {
      const allRefIds = records
        .map(r => r && r[idField])
        .filter(Boolean);
      if (allRefIds.length > 0) {
        console.log(`   🔍 Bulk lookup: ${allRefIds.length} refIds in chunks of ${PREFETCH_CHUNK}...`);
        for (let i = 0; i < allRefIds.length; i += PREFETCH_CHUNK) {
          const chunk = allRefIds.slice(i, i + PREFETCH_CHUNK);
          try {
            const res = await withRetry(() =>
              this.api.find(model, {
                xquery: { refId: { $in: chunk } },
                select: '_id refId',
                limit: PREFETCH_CHUNK,
              }),
              retryOpts,
            );
            const rows = extractDocs(res);
            for (const row of rows) {
              if (row.refId && row._id) refIdCache.set(row.refId, row._id);
            }
          } catch (err) {
            console.warn(`   ⚠️  Bulk lookup chunk failed: ${err.message} — records in this chunk will use individual lookup`);
          }
          // Throttle between chunks to protect the backend
          if (i + PREFETCH_CHUNK < allRefIds.length && recordDelay > 0) {
            await sleep(recordDelay);
          }
        }
        console.log(`   ✅ Bulk lookup: ${refIdCache.size}/${allRefIds.length} already exist in Prolibu`);

        // ── Alt lookup: fallback to altLookupField for unresolved records ──
        if (altLookupField && refIdCache.size < allRefIds.length) {
          const unresolved = records.filter(r => {
            const sid = r && r[idField];
            return sid && !refIdCache.has(sid);
          });
          const altValues = unresolved
            .map(r => r[altLookupField])
            .filter(v => v != null && v !== '');
          if (altValues.length > 0) {
            console.log(`   🔍 Alt lookup by "${altLookupField}": ${altValues.length} unresolved records...`);
            // Build value→sourceIds reverse map for matching (1:N — multiple source records can share the same alt value)
            const valToSourceIds = new Map();
            for (const r of unresolved) {
              const v = r[altLookupField];
              if (v != null && v !== '') {
                const key = String(v);
                if (!valToSourceIds.has(key)) valToSourceIds.set(key, []);
                valToSourceIds.get(key).push(r[idField]);
              }
            }
            // Deduplicate alt values for the query
            const uniqueAltValues = [...new Set(altValues.map(String))];
            for (let i = 0; i < uniqueAltValues.length; i += PREFETCH_CHUNK) {
              const chunk = uniqueAltValues.slice(i, i + PREFETCH_CHUNK);
              try {
                const res = await withRetry(() =>
                  this.api.find(model, {
                    xquery: { [altLookupField]: { $in: chunk } },
                    select: `_id ${altLookupField}`,
                    limit: PREFETCH_CHUNK,
                  }),
                  retryOpts,
                );
                const rows = extractDocs(res);
                for (const row of rows) {
                  const altVal = row[altLookupField];
                  if (altVal && row._id) {
                    const sourceIds = valToSourceIds.get(String(altVal));
                    if (sourceIds) {
                      for (const sourceId of sourceIds) {
                        refIdCache.set(sourceId, row._id);
                      }
                    }
                  }
                }
              } catch (err) {
                console.warn(`   ⚠️  Alt lookup chunk failed: ${err.message}`);
              }
              if (i + PREFETCH_CHUNK < altValues.length && recordDelay > 0) {
                await sleep(recordDelay);
              }
            }
            console.log(`   ✅ Alt lookup: ${refIdCache.size}/${allRefIds.length} total resolved after fallback`);
          }
        }
      }
    }

    // ── Prefetch-only mode: stop here, return lookup results ──
    if (prefetchOnly) {
      if (bar) bar.stop();
      const newCount = total - refIdCache.size;
      console.log(`   📊 Prefetch summary: ${refIdCache.size} to update, ${newCount} to create, ${result.resumed} resumed`);
      result.prefetch = { existing: refIdCache.size, new: newCount, total };
      return result;
    }

    /**
     * Process a single record and mutate `result` in place.
     * Uses refIdCache to skip the per-record find — only 1 API call per record.
     * Returns true if the record hit a server error (5xx), false otherwise.
     */
    const processOne = async (record) => {
      if (!record || typeof record !== 'object') {
        result.skipped++;
        return false;
      }

      if (this.dryRun) {
        result.migrated++;
        return false;
      }

      const sourceId = idField ? record[idField] : null;
      try {
        const expanded = expandDotNotation(record);

        if (idField && sourceId) {
          const cachedProlibuId = refIdCache.get(sourceId);
          let created, prolibuId;

          if (cachedProlibuId) {
            // Record exists — update directly (no find needed)
            // Strip refId (identity) and altLookupField (might conflict with another record)
            const { refId: _stripped, [altLookupField]: _altStripped, ...updateData } = expanded;
            await withRetry(() => this.api.update(model, cachedProlibuId, updateData), retryOpts);
            created = false;
            prolibuId = cachedProlibuId;
          } else {
            // Record not in cache — create it
            try {
              const rec = await withRetry(() => this.api.create(model, expanded), retryOpts);
              created = true;
              prolibuId = rec?._id;
            } catch (createErr) {
              // If create failed with 400 "already exists" and we have an altLookupField,
              // look up the existing record and retry as update
              const createStatus = createErr?.response?.status ?? createErr?.statusCode;
              const altVal = altLookupField && record[altLookupField];
              if (createStatus === 400 && altVal) {
                const existing = await this.api.find(model, {
                  xquery: { [altLookupField]: altVal },
                  select: '_id',
                  limit: 1,
                });
                const rows = extractDocs(existing);
                if (rows.length > 0 && rows[0]._id) {
                  const existingId = rows[0]._id;
                  const { refId: _stripped, [altLookupField]: _altStripped, ...updateData } = expanded;
                  await withRetry(() => this.api.update(model, existingId, updateData), retryOpts);
                  refIdCache.set(sourceId, existingId);
                  created = false;
                  prolibuId = existingId;
                } else {
                  throw createErr; // re-throw if lookup found nothing
                }
              } else {
                throw createErr;
              }
            }
          }

          if (created) {
            result.created++;
          } else {
            result.updated++;
          }
          if (idStore && prolibuId) idStore.set(sourceId, prolibuId);
        } else {
          await withRetry(() => this.api.create(model, expanded), retryOpts);
          result.created++;
        }
        result.migrated++;
        return false;
      } catch (err) {
        const msg = err?.response?.data?.message || err.message || String(err);
        result.errors.push(`[${sourceId ?? '?'}] ${msg}`);
        result.skipped++;
        const status = err?.response?.status ?? err?.statusCode ?? err?.status;
        return Number.isInteger(status) && status >= 500;
      }
    };

    // Process in concurrent batches; size is caller-supplied or the module default
    const batchSize = (Number.isInteger(concurrency) && concurrency > 0) ? concurrency : CONCURRENT_BATCH_SIZE;
    for (let i = 0; i < records.length; i += batchSize) {
      // ── Circuit breaker: abort if error threshold exceeded ──
      if (errorThreshold > 0 && result.errors.length >= errorThreshold) {
        const remaining = records.length - i;
        result.skipped += remaining;
        console.log(`\n   🔴 Circuit breaker: ${result.errors.length} errors reached threshold (${errorThreshold}). Aborting ${remaining} remaining records.`);
        break;
      }

      const chunk = records.slice(i, i + batchSize);

      if (batchSize === 1 && recordDelay > 0) {
        // Sequential mode with per-record delay
        for (const record of chunk) {
          const wasServerError = await processOne(record);
          if (wasServerError) {
            consecutiveErrors++;
            if (consecutiveErrors >= consecutiveErrorsBeforeCooldown) {
              console.log(`\n   🧊 ${consecutiveErrors} consecutive server errors — cooling down ${cooldownMs / 1000}s...`);
              await sleep(cooldownMs);
              consecutiveErrors = 0;
            }
          } else {
            consecutiveErrors = 0;
          }
          if (recordDelay > 0) await sleep(recordDelay);
        }
      } else {
        await Promise.allSettled(chunk.map(record => processOne(record)));
      }

      processed += chunk.length;

      // Flush idStore to disk after every concurrent batch
      if (idStore && idStore.isDirty) {
        idStore.save();
      }

      if (bar) bar.update(processed, { created: result.created, updated: result.updated, errors: result.errors.length });

      // Periodic log every 50 records (visible in log viewers that don't support \r)
      if (processed % 50 === 0 || processed === total) {
        console.log(`   📊 Progress: ${processed}/${total} (➕ ${result.created} created, 🔄 ${result.updated} updated, ❌ ${result.errors.length} errors)`);
      }

      if (onProgress) onProgress({ processed, total, ...result });
      if (batchDelay > 0) await sleep(batchDelay);
    }

    // Final flush of any remaining idMap entries
    if (idStore && idStore.isDirty) idStore.save();

    if (bar) bar.stop();

    return result;
  }

  /**
   * Migration-specific upsert: search by refId, update if found, create if not.
   * Always queries Prolibu using the canonical `refId` field with minimal payload.
   * Wraps each API call with exponential-backoff retry (429 / 5xx).
   *
   * @param {string} model     - Prolibu model name
   * @param {string} sourceId  - Source-system ID (value stored in refId)
   * @param {object} data      - Record data to create/update (must include refId on create)
   * @returns {Promise<{ created: boolean, prolibuId: string }>}
   */
  async _upsertRecord(model, sourceId, data, retryOpts = {}) {
    const results = await withRetry(() =>
      this.api.find(model, {
        xquery: { refId: sourceId },
        select: '_id refId',
        limit: 1,
      }),
      retryOpts,
    );
    const rows = Array.isArray(results) ? results : (results?.data || []);
    if (rows.length > 0) {
      const prolibuId = rows[0]._id;
      // Strip refId from PATCH body — the record already has it and it should not be re-sent
      const { refId: _stripped, ...updateData } = data;
      await withRetry(() => this.api.update(model, prolibuId, updateData), retryOpts);
      return { created: false, prolibuId };
    }
    const record = await withRetry(() => this.api.create(model, data), retryOpts);
    return { created: true, prolibuId: record?._id };
  }

  // ── Schema setup convenience methods ────────────────────────

  /**
   * Access the underlying SchemaSetup instance for advanced operations.
   * @returns {SchemaSetup}
   */
  get schemaSetup() {
    return this._schemaSetup;
  }

  /**
   * Create custom fields on an existing Prolibu model.
   * Shortcut for `this.schemaSetup.createCustomFields(...)`.
   *
   * @param {string} modelName - Target model (e.g. 'Contact')
   * @param {object} fields    - Field definitions
   * @param {object} [options]
   * @returns {Promise<{ success: boolean, record?: object, error?: string }>}
   */
  async createCustomFields(modelName, fields, options) {
    return this._schemaSetup.createCustomFields(modelName, fields, options);
  }

  /**
   * Create a new Custom Object (COB) in Prolibu.
   * Shortcut for `this.schemaSetup.createCustomObject(...)`.
   *
   * @param {object} definition - COB definition with modelName + field definitions
   * @returns {Promise<{ success: boolean, record?: object, error?: string }>}
   */
  async createCustomObject(definition) {
    return this._schemaSetup.createCustomObject(definition);
  }

  /**
   * Apply a prolibu_setup.json configuration (custom objects + custom fields).
   * Shortcut for `this.schemaSetup.applySetup(...)`.
   *
   * @param {object} setupConfig - The setup configuration
   * @returns {Promise<{ customObjects: object[], customFields: object[], errors: string[] }>}
   */
  async applySetup(setupConfig) {
    return this._schemaSetup.applySetup(setupConfig);
  }
}

module.exports = ProlibuWriter;
