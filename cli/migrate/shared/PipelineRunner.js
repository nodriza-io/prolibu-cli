const credentialStore = require('./credentialStore');

/**
 * Resolve the pipeline for a given entity in a domain.
 *
 * If the domain has a pipeline override file at:
 *   accounts/<domain>/migrations/<crm>/pipelines/<entity>.js
 * it is loaded and returned.
 *
 * If no override exists, the baseTransformer is wrapped into a single-step
 * pipeline so the runner always works with the same shape (retrocompatible).
 *
 * Pipeline file format:
 * ```js
 * module.exports = {
 *   steps: [
 *     {
 *       name: 'normalizeRaw',         // optional, used in logs
 *       before: async (sfRecord) => { ... return sfRecord },   // mutate before transform
 *       transform: async (record) => { ... return record },    // map to new shape
 *       after: async (record) => { ... return record },        // enrich after transform
 *     },
 *     { name: 'base' },               // reserved: injects the engine's baseTransformer
 *   ]
 * }
 * ```
 *
 * Rules:
 * - `name: 'base'` is reserved → runner injects baseTransformer at that slot
 * - `before`, `transform`, `after` are all optional per step
 * - If transform is omitted the record passes through unchanged
 * - Any function can be async
 *
 * @param {string} domain
 * @param {string} crm
 * @param {string} entityKey
 * @param {Function} baseTransformer   - The engine's compiled base transformer for this entity
 * @returns {{ steps: object[] }}
 */
function resolvePipeline(domain, crm, entityKey, baseTransformer) {
    const pipeline = credentialStore.loadPipeline(domain, crm, entityKey);

    if (pipeline) {
        // Inject baseTransformer into any step named 'base'
        const hasBase = pipeline.steps.some((s) => s.name === 'base');
        const steps = hasBase
            ? pipeline.steps
            : [{ name: 'base' }, ...pipeline.steps];

        const hydratedSteps = steps.map((step) => {
            if (step.name === 'base') {
                return { ...step, transform: baseTransformer };
            }
            return step;
        });
        return { steps: hydratedSteps, prepare: pipeline.prepare };
    }

    // No pipeline override — wrap base transformer as single-step pipeline
    return {
        steps: [{ name: 'base', transform: baseTransformer }],
    };
}

/**
 * Run a pipeline over an array of records.
 *
 * For each record, executes all steps in order:
 *   before(record) → transform(record) → after(record)
 *
 * The output of each step is the input of the next.
 * All hook functions can be sync or async.
 *
 * @param {{ steps: object[] }} pipeline
 * @param {object[]} records
 * @param {object} [context={}] - Extra context passed to each step (e.g. { idMap })
 * @returns {Promise<object[]>}
 */
async function runPipeline(pipeline, records, context = {}) {
    const results = [];

    for (const record of records) {
        let current = record;

        for (const step of pipeline.steps) {
            // before: mutate input before transform
            if (typeof step.before === 'function') {
                current = await step.before(current, context);
            }

            // transform: map to new shape (pass-through if not defined)
            if (typeof step.transform === 'function') {
                current = await step.transform(current, context);
            }

            // after: enrich the result after transform
            if (typeof step.after === 'function') {
                current = await step.after(current, context);
            }
        }

        results.push(current);
    }

    return results;
}

module.exports = { resolvePipeline, runPipeline };
