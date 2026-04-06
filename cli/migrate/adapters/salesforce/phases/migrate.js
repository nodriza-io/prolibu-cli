const credentialStore = require('../../../shared/credentialStore');
const logger = require('../../../shared/migrationLogger');
const PipelineRunner = require('../../../shared/PipelineRunner');
const IdMapStore = require('../../../shared/IdMapStore');
const fs = require('fs');
const path = require('path');

/**
 * Phase: migrate
 *
 * Runs the data migration for a given set of entities.
 * Fetches records from Salesforce, runs them through the entity pipeline
 * (base transformer + any domain overrides), and writes them to Prolibu.
 *
 * Supports N:1 joins: when an entity has `join` config in schema.yml,
 * related records are fetched from Salesforce and attached to each record
 * as `_joined.<alias>` before the transformer runs.
 *
 * @param {object} context
 * @param {string}   context.domain
 * @param {string[]} context.entities          - Ordered list of entity keys to migrate
 * @param {object}   context.adapter           - Authenticated SalesforceAdapter instance
 * @param {object}   context.writer            - ProlibuWriter instance
 * @param {object}   context.log               - Current migration log (from migrationLogger)
 * @param {object}   context.entityDefinitions - ENTITY_DEFINITIONS map from engine.js
 * @param {number}   context.batchSize
 */
async function migrate({
    domain,
    entities,
    adapter,
    writer,
    log,
    entityDefinitions,
    batchSize,
    concurrency,
    onProgress,
    onEntityResult,
}) {
    const domainConfig = credentialStore.getConfig(domain, 'salesforce') || {};
    const entityConfig = domainConfig.entities || {};

    for (const entityKey of entities) {
        // Resolve definition: try direct key, then match by prolibuModel/target, then by sobject/source
        let definition = entityDefinitions[entityKey];
        let resolvedKey = entityKey;
        if (!definition) {
            const byModel = Object.entries(entityDefinitions).find(
                ([, d]) => d.prolibuModel && d.prolibuModel.toLowerCase() === entityKey.toLowerCase()
            );
            if (byModel) {
                [resolvedKey, definition] = byModel;
                console.log(`🔀 Resolved "${entityKey}" → entity key "${resolvedKey}" (by prolibuModel)`);
            }
        }
        if (!definition) {
            const bySobject = Object.entries(entityDefinitions).find(
                ([, d]) => d.sobject && d.sobject.toLowerCase() === entityKey.toLowerCase()
            );
            if (bySobject) {
                [resolvedKey, definition] = bySobject;
                console.log(`🔀 Resolved "${entityKey}" → entity key "${resolvedKey}" (by sobject)`);
            }
        }
        if (!definition) {
            console.warn(`⚠️  Unknown entity "${entityKey}", skipping.`);
            continue;
        }

        const cfg = entityConfig[resolvedKey] || entityConfig[entityKey];
        if (cfg && cfg.enabled === false) {
            console.log(`⏭️  ${resolvedKey}: disabled in config.json, skipping`);
            continue;
        }

        console.log(`📦 Migrating ${resolvedKey}...`);

        // Resolve the base transformer for this entity
        const baseTransformer = definition.baseTransformer();

        // Resolve pipeline (domain override or single-step base fallback)
        const pipeline = PipelineRunner.resolvePipeline(domain, 'salesforce', resolvedKey, baseTransformer);

        // ── Validate SELECT fields against discovery ──────────────────
        // Remove fields from defaultSelect that don't actually exist in this Salesforce org.
        let validatedSelect = definition.defaultSelect;
        const discovery = credentialStore.loadDiscovery(domain, 'salesforce');
        if (discovery && definition.defaultSelect) {
            const discObj = discovery.objects?.[definition.sobject];
            if (discObj?.fieldDetails) {
                const knownFields = new Set(discObj.fieldDetails.map(f => f.name));
                const requestedFields = definition.defaultSelect.split(',').map(f => f.trim()).filter(Boolean);
                const valid = [];
                const removed = [];
                for (const field of requestedFields) {
                    // Allow relationship traversals (e.g. Account.Name)
                    const baseField = field.split('.')[0];
                    if (knownFields.has(baseField)) {
                        valid.push(field);
                    } else {
                        removed.push(field);
                    }
                }
                if (removed.length > 0) {
                    console.log(`   ⚠️  Campos no encontrados en ${definition.sobject}, removidos del SELECT: ${removed.join(', ')}`);
                    validatedSelect = valid.join(', ');
                }
            }
        }

        // Fetch records from Salesforce
        let records;
        if (cfg?.filter) {
            const soql = `SELECT ${validatedSelect} FROM ${definition.sobject} WHERE ${cfg.filter} LIMIT ${batchSize}`;
            const result = await adapter.api.find(definition.sobject, soql);
            records = result?.data || [];
        } else {
            records = await adapter.fetchAll(definition.sobject, {
                select: validatedSelect,
                limit: batchSize,
            });
        }
        console.log(`   Fetched ${records.length} records from Salesforce`);

        // Log raw + transformed data to accounts/<domain>/migrations/salesforce/logs/
        const logsDir = path.join(process.cwd(), 'accounts', domain, 'migrations', 'salesforce', 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        fs.writeFileSync(
            path.join(logsDir, `${resolvedKey}-raw.json`),
            JSON.stringify(records, null, 2)
        );
        console.log(`   📝 Raw data logged to accounts/${domain}/migrations/salesforce/logs/${resolvedKey}-raw.json`);

        // ── N:1 join: fetch related records and attach to each primary record ──
        if (definition.join && definition.join.length > 0) {
            await resolveJoins(adapter, records, definition.join);
        }

        // ── Build idMap: resolve SF IDs → Prolibu _ids for ref fields ──
        // Load (or create) the IdMapStore for this entity's own model
        const idStore = new IdMapStore({
            domain,
            crm: 'salesforce',
            model: definition.prolibuModel,
        }).load();
        if (idStore.size > 0) {
            console.log(`   📦 IdMapStore loaded: ${idStore.size} cached mappings for ${definition.prolibuModel}`);
        }

        const idMap = await buildIdMap(writer.api, definition.fieldMappings || [], records, domain);

        // ── Build pipeline context ──────────────────────────────────────────────
        const pipelineContext = { idMap, api: writer.api };

        // ── Run pipeline.prepare (batch-level hook, runs once before the loop) ──
        if (typeof pipeline.prepare === 'function') {
            await pipeline.prepare(records, pipelineContext);
        }

        // Run records through the pipeline (all steps, with before/after hooks)
        const transformed = await PipelineRunner.runPipeline(pipeline, records, pipelineContext);

        // Log transformed data
        fs.writeFileSync(
            path.join(logsDir, `${resolvedKey}-transformed.json`),
            JSON.stringify(transformed, null, 2)
        );
        console.log(`   📝 Transformed data logged to accounts/${domain}/migrations/salesforce/logs/${resolvedKey}-transformed.json`);

        // Post-process: flatten _joinedArray markers into the target path and filter nulls
        const validRecords = [];
        for (const record of transformed) {
            if (!record) continue;
            flattenJoinedArrays(record);
            validRecords.push(record);
        }

        if (validRecords.length < transformed.length) {
            const skippedCount = transformed.length - validRecords.length;
            console.log(`   ⚠️  ${skippedCount} record(s) skipped (null/invalid, likely missing required fields)`);
        }

        // Write to Prolibu
        const entityProgress = onProgress
            ? (progress) => onProgress({ entity: resolvedKey, ...progress })
            : undefined;
        const result = await writer.writeBatch(definition.prolibuModel, validRecords, {
            idField: definition.idField,
            onProgress: entityProgress,
            idStore,
            concurrency,
        });

        logger.recordEntityResult(log, resolvedKey, result);
        if (onEntityResult) onEntityResult(resolvedKey, result);
        const updatedMsg = result.updated > 0 ? `, 🔄 ${result.updated} updated` : '';
        const createdMsg = result.created > 0 ? `, ➕ ${result.created} created` : '';
        console.log(`   ✅ ${result.migrated} migrated${createdMsg}${updatedMsg}, ⏭️ ${result.skipped} skipped, ❌ ${result.errors.length} errors`);
    }
}

// ─── idMap helper ─────────────────────────────────────────────

/**
 * Build a map of { refModel: { sfId: prolibuId } } for all fields with a `ref`.
 * Queries Prolibu in chunks of 200 using $in on refId.
 * Pre-populates from persisted IdMapStore files to minimize API calls.
 *
 * @param {object}   api           - ProlibuApi instance
 * @param {object[]} fieldMappings - Entity field mappings (may include { from, to, ref })
 * @param {object[]} records       - SF records to migrate (used to extract unique SF IDs)
 * @param {string}   domain        - Prolibu domain (for IdMapStore file path)
 * @returns {Promise<object>}      - { [refModel]: { [sfId]: prolibuId } }
 */
async function buildIdMap(api, fieldMappings, records, domain) {
    const idMap = {};
    const refFields = fieldMappings.filter(m => m.ref && m.from);
    if (!refFields.length || !records.length) return idMap;

    // Group by refModel — collect unique SF IDs per model
    const byModel = {};
    for (const mapping of refFields) {
        const model = mapping.ref;
        if (!byModel[model]) byModel[model] = new Set();
        for (const rec of records) {
            const val = rec[mapping.from];
            if (val) byModel[model].add(val);
        }
    }

    // For each refModel, load cached mappings then fetch only what's missing
    const CHUNK_SIZE = 200;
    for (const [model, sfIdSet] of Object.entries(byModel)) {
        const sfIds = [...sfIdSet];
        idMap[model] = {};

        // Load any already-known mappings from the persisted IdMapStore
        const store = new IdMapStore({ domain, crm: 'salesforce', model }).load();
        let cachedCount = 0;
        for (const sfId of sfIds) {
            const cached = store.get(sfId);
            if (cached) {
                idMap[model][sfId] = cached;
                cachedCount++;
            }
        }

        const toFetch = store.missing(sfIds);
        let resolved = cachedCount;

        for (let i = 0; i < toFetch.length; i += CHUNK_SIZE) {
            const chunk = toFetch.slice(i, i + CHUNK_SIZE);
            try {
                const res = await api.find(model, {
                    select: '_id refId',
                    xquery: { refId: { $in: chunk } },
                    limit: CHUNK_SIZE,
                });
                const rows = res?.data || res || [];
                for (const row of rows) {
                    if (row.refId && row._id) {
                        idMap[model][row.refId] = row._id;
                        store.set(row.refId, row._id);
                        resolved++;
                    }
                }
            } catch (err) {
                console.warn(`   ⚠️  idMap[${model}]: error fetching chunk — ${err.message}`);
            }
        }

        // Persist any newly fetched mappings back to disk
        if (store.isDirty) store.save();

        const cacheMsg = cachedCount > 0 ? ` (${cachedCount} from cache)` : '';
        console.log(`   🔗 idMap[${model}]: ${resolved}/${sfIds.length} resolved${cacheMsg}`);
    }

    return idMap;
}

// ─── Join helpers ──────────────────────────────────────────────

/**
 * Resolve all join definitions for a set of primary records.
 * Fetches related CRM records and attaches them as `record._joined.<alias>`.
 *
 * Supports two join modes:
 * - Direct join: foreignKey references the primary record's Id
 * - Chained join (parentJoin): foreignKey references a previously resolved join's Id
 *
 * @param {object}   adapter  - CRM adapter with query capability
 * @param {object[]} records  - Primary records (mutated in place)
 * @param {object[]} joins    - Join definitions from schema.yml
 */
async function resolveJoins(adapter, records, joins) {
    if (!records.length) return;

    // Sort joins: direct joins first, then chained joins (parentJoin)
    const directJoins = joins.filter(j => !j.parentJoin);
    const chainedJoins = joins.filter(j => j.parentJoin);

    // Initialize _joined on all records
    for (const record of records) {
        record._joined = record._joined || {};
    }

    // ── Direct joins (foreignKey → primary record's Id) ──
    for (const join of directJoins) {
        const ids = records.map(r => r.Id).filter(Boolean);
        if (!ids.length) continue;

        console.log(`   🔗 Joining ${join.source} (${join.strategy || 'latest'}) via ${join.foreignKey}...`);

        const joinedRecords = await fetchJoinedRecords(adapter, join, ids);
        const grouped = groupBy(joinedRecords, join.foreignKey);

        for (const record of records) {
            const related = grouped[record.Id] || [];
            record._joined[join.as] = pickByStrategy(related, join.strategy);
        }

        const matchCount = records.filter(r => r._joined[join.as] != null).length;
        console.log(`      ${matchCount}/${records.length} records matched`);
    }

    // ── Chained joins (foreignKey → a previously resolved join's Id) ──
    for (const join of chainedJoins) {
        const parentAlias = join.parentJoin;
        // Collect all resolved parent IDs
        const parentIds = records
            .map(r => {
                const parent = r._joined[parentAlias];
                return parent && !Array.isArray(parent) ? parent.Id : null;
            })
            .filter(Boolean);

        if (!parentIds.length) {
            console.log(`   🔗 Joining ${join.source}: no parent ${parentAlias} records resolved, skipping`);
            continue;
        }

        console.log(`   🔗 Joining ${join.source} (${join.strategy || 'latest'}) via ${join.foreignKey} → ${parentAlias}.Id...`);

        const joinedRecords = await fetchJoinedRecords(adapter, join, parentIds);
        const grouped = groupBy(joinedRecords, join.foreignKey);

        for (const record of records) {
            const parent = record._joined[parentAlias];
            const parentId = parent && !Array.isArray(parent) ? parent.Id : null;
            const related = parentId ? (grouped[parentId] || []) : [];
            record._joined[join.as] = pickByStrategy(related, join.strategy);
        }

        const matchCount = records.filter(r => {
            const v = r._joined[join.as];
            return v != null && (!Array.isArray(v) || v.length > 0);
        }).length;
        console.log(`      ${matchCount}/${records.length} records matched`);
    }
}

/**
 * Fetch related records from CRM for a join definition.
 * Batches IDs into chunks to avoid SOQL length limits.
 */
async function fetchJoinedRecords(adapter, join, parentIds) {
    const select = join.select || 'FIELDS(STANDARD)';
    const chunkSize = 200; // SF SOQL IN clause limit
    const allRecords = [];

    for (let i = 0; i < parentIds.length; i += chunkSize) {
        const chunk = parentIds.slice(i, i + chunkSize);
        const idList = chunk.map(id => `'${id}'`).join(',');
        const soql = `SELECT ${select} FROM ${join.source} WHERE ${join.foreignKey} IN (${idList}) ORDER BY CreatedDate DESC`;

        try {
            const result = await adapter.query(soql);
            const data = result?.records || result?.data || result || [];
            allRecords.push(...(Array.isArray(data) ? data : []));
        } catch (err) {
            console.warn(`      ⚠️  Failed to fetch ${join.source}: ${err.message}`);
        }
    }

    return allRecords;
}

/**
 * Pick record(s) from a related set based on strategy.
 * @param {object[]} records - Related records (sorted by CreatedDate DESC)
 * @param {string}   strategy - "latest" | "primary" | "all"
 * @returns {object|object[]|null}
 */
function pickByStrategy(records, strategy = 'latest') {
    if (!records.length) return null;

    switch (strategy) {
        case 'all':
            return records;
        case 'primary': {
            // Try to find the primary/syncing record; fall back to latest
            const primary = records.find(r => r.IsSyncing === true || r.Status === 'Accepted');
            return primary || records[0];
        }
        case 'latest':
        default:
            return records[0]; // already sorted by CreatedDate DESC
    }
}

/**
 * Group an array of records by a key field.
 * @returns {Object<string, object[]>}
 */
function groupBy(records, keyField) {
    const map = {};
    for (const record of records) {
        const key = record[keyField];
        if (!key) continue;
        if (!map[key]) map[key] = [];
        map[key].push(record);
    }
    return map;
}

/**
 * Post-transform: flatten `_joinedArray:<alias>` markers into the
 * proper nested path. The markers are set by buildTransformer when
 * processing "all" strategy joins.
 *
 * Example: if mappings produce `_joinedArray:lineItems` with value
 *   [{quantity:1, price:10}, ...]
 * and the first mapping's `to` starts with "proposal.quote.lineItems",
 * we write result["proposal.quote.lineItems"] = items.
 * Otherwise we store under a sensible default key.
 */
function flattenJoinedArrays(record) {
    const marker = '_joinedArray:';
    for (const key of Object.keys(record)) {
        if (!key.startsWith(marker)) continue;
        const alias = key.slice(marker.length);
        const items = record[key];
        delete record[key];

        // Normalize lineItems: convert discount percentages to decimals (SF: 15 → Prolibu: 0.15)
        if (Array.isArray(items)) {
            for (const item of items) {
                if (item.discountRate != null && item.discountRate > 1) {
                    item.discountRate = item.discountRate / 100;
                }
            }
        }

        // Store as proposal.quote.lineItems for Deal, or as <alias> for others
        // The downstream writer handles dot-notation expansion
        record[`proposal.quote.${alias}`] = items;
    }
}

module.exports = migrate;
