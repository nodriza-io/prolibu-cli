'use strict';

const credentialStore = require('../../../shared/credentialStore');
const logger = require('../../../shared/migrationLogger');
const PipelineRunner = require('../../../shared/PipelineRunner');
const IdMapStore = require('../../../shared/IdMapStore');
const ProlibuApi = require('../../../../../lib/vendors/prolibu/ProlibuApi');
const fs = require('fs');
const path = require('path');

/**
 * Phase: migrate
 *
 * Runs the data migration for a given set of entities from a source
 * Prolibu account to a destination Prolibu account.
 *
 * For each entity:
 *   1. Fetches all records from the source (paginated)
 *   2. Builds idMap for cross-entity reference resolution
 *   3. Runs records through the pipeline (base transformer + domain overrides)
 *   4. Writes transformed records to the destination via ProlibuWriter
 *
 * @param {object}   context
 * @param {string}   context.domain             - Destination Prolibu domain
 * @param {string}   context.sourceDomain       - Source Prolibu domain
 * @param {string}   context.sourceApiKey        - Source API key
 * @param {string[]} context.entities            - Ordered list of entity keys to migrate
 * @param {object}   context.writer              - ProlibuWriter instance (destination)
 * @param {object}   context.log                 - Migration log from migrationLogger
 * @param {object}   context.entityDefinitions   - Entity definition map from engine.js
 * @param {number}   context.batchSize
 * @param {number}   context.concurrency
 * @param {number}   context.batchDelay
 * @param {number}   context.recordDelay
 * @param {number}   context.maxRetries
 * @param {number}   context.cooldownMs
 * @param {number}   context.consecutiveErrorsBeforeCooldown
 * @param {number}   context.errorThreshold
 * @param {boolean}  context.force               - Re-migrate already-mapped records
 * @param {boolean}  context.dryRun
 * @param {Function} [context.onProgress]
 * @param {Function} [context.onEntityResult]
 */
async function migrate(context) {
    const {
        domain,
        sourceDomain,
        sourceApiKey,
        entities,
        writer,
        log,
        entityDefinitions,
        batchSize,
        concurrency,
        batchDelay,
        recordDelay,
        maxRetries,
        cooldownMs,
        consecutiveErrorsBeforeCooldown,
        errorThreshold,
        force,
        dryRun,
        onProgress,
        onEntityResult,
    } = context;

    const sourceApi = new ProlibuApi({ domain: sourceDomain, apiKey: sourceApiKey });

    for (const entityKey of entities) {
        const definition = entityDefinitions[entityKey];
        if (!definition) {
            console.warn(`⚠️  Unknown entity "${entityKey}", skipping.`);
            continue;
        }

        if (definition.enabled === false) {
            console.log(`⏭️  ${entityKey}: disabled in config, skipping`);
            continue;
        }

        console.log(`\n📦 Migrating ${entityKey}...`);
        const sourceModel = definition.source;
        const destModel = definition.target;

        // Capture baseline stats from previous runs so we can accumulate
        if (!log.entities) log.entities = {};
        const baseline = log.entities[entityKey] ? { ...log.entities[entityKey] } : null;

        // ── 1. Fetch all records from source ──────────────────────────
        console.log(`   📥 Fetching ${sourceModel} records from ${sourceDomain}...`);
        const records = await fetchAllRecords(sourceApi, sourceModel, batchSize);
        console.log(`   Fetched ${records.length} records from source`);

        if (!records.length) {
            continue;
        }

        // ── Log raw data ──────────────────────────────────────────────
        const logsDir = path.join(process.cwd(), 'accounts', domain, 'migrations', 'prolibu', 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        fs.writeFileSync(
            path.join(logsDir, `${entityKey}-raw.json`),
            JSON.stringify(records, null, 2)
        );
        console.log(`   📝 Raw data logged to logs/${entityKey}-raw.json`);

        // ── 2. Load IdMapStore for this entity ────────────────────────
        const idStore = new IdMapStore({
            domain,
            crm: 'prolibu',
            model: destModel,
        }).load();
        if (idStore.size > 0) {
            console.log(`   📦 IdMapStore loaded: ${idStore.size} cached mappings for ${destModel}`);
        }

        // ── 3. Build idMap for cross-entity ref resolution ────────────
        const idMap = buildIdMap(domain, entityDefinitions);

        // ── 4. Resolve transformer and run pipeline ──────────────────
        const baseTransformer = definition.baseTransformer();
        const pipeline = PipelineRunner.resolvePipeline(domain, 'prolibu', entityKey, baseTransformer);
        const pipelineContext = { idMap, api: writer.api };

        // Run pipeline.prepare if defined
        if (typeof pipeline.prepare === 'function') {
            await pipeline.prepare(records, pipelineContext);
        }

        const transformed = await PipelineRunner.runPipeline(pipeline, records, pipelineContext);

        // Filter out nulls (records that failed required-field checks)
        const validRecords = transformed.filter(r => r != null);
        if (validRecords.length < transformed.length) {
            const skippedCount = transformed.length - validRecords.length;
            console.log(`   ⚠️  ${skippedCount} record(s) skipped (null/invalid)`);
        }

        // ── Log transformed data ─────────────────────────────────────
        fs.writeFileSync(
            path.join(logsDir, `${entityKey}-transformed.json`),
            JSON.stringify(validRecords, null, 2)
        );
        console.log(`   📝 Transformed data logged to logs/${entityKey}-transformed.json`);

        // ── 5. Write to destination ──────────────────────────────────
        const entityProgress = (progress) => {
            logger.recordEntityResult(log, entityKey, logger.mergeWithBaseline(baseline, progress));
            logger.saveLog(domain, 'prolibu', log);
            if (onProgress) onProgress({ entity: entityKey, ...progress });
        };

        const result = await writer.writeBatch(destModel, validRecords, {
            idField: definition.idField,
            onProgress: entityProgress,
            idStore: force ? null : idStore,
            concurrency,
            batchDelay,
            recordDelay,
            maxRetries,
            cooldownMs,
            consecutiveErrorsBeforeCooldown,
            errorThreshold,
        });

        logger.recordEntityResult(log, entityKey, logger.mergeWithBaseline(baseline, result));
        if (onEntityResult) onEntityResult(entityKey, result);

        const updatedMsg = result.updated > 0 ? `, 🔄 ${result.updated} updated` : '';
        const createdMsg = result.created > 0 ? `, ➕ ${result.created} created` : '';
        console.log(`   ✅ ${result.migrated} migrated${createdMsg}${updatedMsg}, ⏭️ ${result.skipped} skipped, ❌ ${result.errors.length} errors`);
    }
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Fetch all records from a source Prolibu model using pagination.
 * @param {ProlibuApi} api
 * @param {string}     model
 * @param {number}     pageSize
 * @returns {Promise<object[]>}
 */
async function fetchAllRecords(api, model, pageSize = 50) {
    const allRecords = [];
    let skip = 0;
    let hasMore = true;

    while (hasMore) {
        const result = await api.find(model, { limit: pageSize, skip });
        const docs = result?.docs || result?.data || result || [];
        const records = Array.isArray(docs) ? docs : [];

        allRecords.push(...records);

        const total = result?.pagination?.count ?? result?.total ?? 0;
        skip += records.length;

        if (records.length < pageSize || skip >= total) {
            hasMore = false;
        }

        if (hasMore) {
            process.stdout.write(`\r   📥 Fetched ${allRecords.length}/${total}...`);
        }
    }

    return allRecords;
}

/**
 * Build a combined idMap from all persisted IdMapStore files.
 * This allows cross-entity reference resolution (e.g., a contact's
 * company field needs the company idMap to resolve).
 *
 * @param {string} domain
 * @param {object} entityDefinitions
 * @returns {object} { [modelName]: { sourceId: destId } }
 */
function buildIdMap(domain, entityDefinitions) {
    const idMap = {};

    // Load all persisted idMaps for cross-entity resolution
    for (const [, def] of Object.entries(entityDefinitions)) {
        const model = def.target;
        if (idMap[model]) continue; // already loaded

        const store = new IdMapStore({ domain, crm: 'prolibu', model }).load();
        if (store.size > 0) {
            // Read the internal map — store._map is the { sourceId: destId } object
            idMap[model] = {};
            // Use the store's get() to build the map
            const storeFilePath = path.join(
                process.cwd(), 'accounts', domain, 'migrations', 'prolibu', 'idMaps', `${model}.json`
            );
            if (fs.existsSync(storeFilePath)) {
                try {
                    idMap[model] = JSON.parse(fs.readFileSync(storeFilePath, 'utf8'));
                } catch {
                    idMap[model] = {};
                }
            }
        }
    }

    // Also load user idMap for assignee resolution
    if (!idMap['user']) {
        const userStorePath = path.join(
            process.cwd(), 'accounts', domain, 'migrations', 'prolibu', 'idMaps', 'user.json'
        );
        if (fs.existsSync(userStorePath)) {
            try {
                idMap['user'] = JSON.parse(fs.readFileSync(userStorePath, 'utf8'));
            } catch {
                idMap['user'] = {};
            }
        }
    }

    return idMap;
}

module.exports = migrate;
