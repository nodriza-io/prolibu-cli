const credentialStore = require('../../shared/credentialStore');
const logger = require('../../shared/migrationLogger');
const PipelineRunner = require('../../shared/PipelineRunner');

/**
 * Phase: migrate
 *
 * Runs the data migration for a given set of entities.
 * Fetches records from Salesforce, runs them through the entity pipeline
 * (base transformer + any domain overrides), and writes them to Prolibu.
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
}) {
    const domainConfig = credentialStore.getConfig(domain, 'salesforce') || {};
    const entityConfig = domainConfig.entities || {};

    for (const entityKey of entities) {
        const definition = entityDefinitions[entityKey];
        if (!definition) {
            console.warn(`⚠️  Unknown entity "${entityKey}", skipping.`);
            continue;
        }

        const cfg = entityConfig[entityKey];
        if (cfg && cfg.enabled === false) {
            console.log(`⏭️  ${entityKey}: disabled in config.json, skipping`);
            continue;
        }

        console.log(`📦 Migrating ${entityKey}...`);

        // Resolve the base transformer for this entity
        const baseTransformer = definition.baseTransformer();

        // Resolve pipeline (domain override or single-step base fallback)
        const pipeline = PipelineRunner.resolvePipeline(domain, 'salesforce', entityKey, baseTransformer);

        // Fetch records from Salesforce
        let records;
        if (cfg?.filter) {
            const soql = `SELECT ${definition.defaultSelect} FROM ${definition.sobject} WHERE ${cfg.filter} LIMIT ${batchSize}`;
            const result = await adapter.api.find(definition.sobject, soql);
            records = result?.data || [];
        } else {
            records = await adapter.fetchAll(definition.sobject, {
                select: definition.defaultSelect,
                limit: batchSize,
            });
        }
        console.log(`   Fetched ${records.length} records from Salesforce`);

        // Run records through the pipeline (all steps, with before/after hooks)
        const transformed = await PipelineRunner.runPipeline(pipeline, records);

        // Write to Prolibu
        const result = await writer.writeBatch(definition.prolibuModel, transformed, {
            idField: definition.idField,
        });

        logger.recordEntityResult(log, entityKey, result);
        console.log(`   ✅ ${result.migrated} migrated, ⏭️ ${result.skipped} skipped, ❌ ${result.errors.length} errors`);
    }
}

module.exports = migrate;
