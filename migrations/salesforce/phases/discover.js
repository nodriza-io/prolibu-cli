const pLimit = require('p-limit');
const credentialStore = require('../../shared/credentialStore');

/**
 * Phase: discover
 *
 * Connects to Salesforce and introspects ALL queryable SObjects using the REST
 * Metadata API (describeGlobal + describeSObject in parallel).
 * Produces a discovery.json artifact saved under:
 *   accounts/<domain>/migrations/salesforce/discovery.json
 *
 * discovery.json shape:
 * {
 *   "discoveredAt": "ISO string",
 *   "withCount": true|false,
 *   "objects": {
 *     "Contact": {
 *       "type": "standard",
 *       "label": "Contact",
 *       "fields": 87,
 *       "fieldDetails": [ { "name": "Id", "type": "id", "custom": false, "label": "..." }, ... ],
 *       "relationships": [ { "name": "AccountId", "referenceTo": "Account", "type": "Lookup" } ],
 *       "records": 4200   // only present when withCount=true
 *     },
 *     "ClienteVIP__c": { "type": "custom", ... }
 *   }
 * }
 *
 * @param {object} context
 * @param {string}  context.domain
 * @param {object}  context.adapter       - Authenticated SalesforceAdapter instance
 * @param {boolean} [context.withCount]   - Fetch record count per object (default: false)
 * @param {number}  [context.concurrency] - Parallel describe requests (default: 10)
 */
async function discover({ domain, adapter, withCount = false, concurrency = 10 }) {
    console.log('🔍 Starting Salesforce discovery...');
    if (withCount) console.log('   (record counts enabled — this will take longer)');
    console.log('');

    // 1. List all queryable SObjects
    const sobjects = await adapter.describeGlobal();
    const queryable = sobjects.filter((s) => s.queryable && s.retrieveable !== false);

    const customCount = queryable.filter((s) => s.name.endsWith('__c')).length;
    console.log(`   Found ${queryable.length} queryable SObjects (${customCount} custom)`);
    console.log('');

    // 2. Describe all in parallel with concurrency limit to avoid SF rate limits
    const limit = pLimit(concurrency);
    const objects = {};
    let done = 0;

    await Promise.all(
        queryable.map((sobject) =>
            limit(async () => {
                const name = sobject.name;
                const isCustom = name.endsWith('__c');

                try {
                    const describe = await adapter.describeSObject(name);
                    const fields = describe?.fields || [];

                    const fieldDetails = fields.map((f) => ({
                        name: f.name,
                        label: f.label,
                        type: f.type,
                        custom: f.custom,
                        ...(f.picklistValues?.length
                            ? { picklistValues: f.picklistValues.map((p) => p.value) }
                            : {}),
                    }));

                    const relationships = fields
                        .filter((f) => f.type === 'reference' && f.referenceTo?.length)
                        .map((f) => ({
                            name: f.name,
                            referenceTo: f.referenceTo[0],
                            type: f.cascadeDelete ? 'MasterDetail' : 'Lookup',
                        }));

                    let recordCount;
                    if (withCount) {
                        try {
                            const countResult = await adapter.api.find(name, `SELECT COUNT() FROM ${name}`);
                            recordCount = countResult?.pagination?.count ?? 0;
                        } catch {
                            recordCount = 0;
                        }
                    }

                    objects[name] = {
                        type: isCustom ? 'custom' : 'standard',
                        label: sobject.label,
                        fields: fieldDetails.length,
                        fieldDetails,
                        relationships,
                        ...(withCount ? { records: recordCount } : {}),
                    };
                } catch (err) {
                    objects[name] = {
                        type: isCustom ? 'custom' : 'standard',
                        label: sobject.label,
                        error: err.message,
                    };
                }

                done++;
                process.stdout.write(`\r   Progress: ${done}/${queryable.length}`);
            })
        )
    );

    console.log(''); // newline after progress line

    const discovery = {
        discoveredAt: new Date().toISOString(),
        withCount,
        objects,
    };

    credentialStore.saveDiscovery(domain, 'salesforce', discovery);

    const describedCustom = Object.values(objects).filter((o) => o.type === 'custom' && !o.error).length;
    const errCount = Object.values(objects).filter((o) => o.error).length;

    console.log('');
    console.log(`✅ Discovery complete — ${Object.keys(objects).length} objects documented`);
    console.log(`   📦 ${describedCustom} custom objects`);
    if (withCount) {
        const withData = Object.values(objects).filter((o) => (o.records ?? 0) > 0).length;
        console.log(`   📊 ${withData} objects with data`);
    }
    if (errCount) console.log(`   ⚠️  ${errCount} objects skipped (describe error)`);
    console.log(`   💾 Saved to: accounts/${domain}/migrations/salesforce/discovery.json`);

    return discovery;
}

module.exports = discover;
