const fs = require('fs');
const path = require('path');
const pLimit = require('p-limit');
const credentialStore = require('../../../shared/credentialStore');

/**
 * Phase: discover
 *
 * Connects to Salesforce and introspects:
 *   1. ALL queryable SObjects (fields, relationships, record counts)
 *   2. ALL Apex Classes and Triggers (source code + metadata)
 *
 * Produces artifacts:
 *   - accounts/<domain>/migrations/salesforce/discovery.json
 *   - accounts/<domain>/migrations/salesforce/apex/classes/*.cls
 *   - accounts/<domain>/migrations/salesforce/apex/triggers/*.trigger
 *   - accounts/<domain>/migrations/salesforce/apex/apex-inventory.json
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
async function discover({ domain, adapter, withCount = false, concurrency = 10, onDiscoverProgress }) {
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
                        nillable: f.nillable,
                        createable: f.createable,
                        ...(f.picklistValues?.length
                            ? { picklistValues: f.picklistValues.map((p) => p.value) }
                            : {}),
                        ...(f.type === 'reference' && f.referenceTo?.length
                            ? { referenceTo: f.referenceTo[0] }
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
                if (onDiscoverProgress) {
                    onDiscoverProgress({ done, total: queryable.length });
                }
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
    console.log(`✅ SObject discovery complete — ${Object.keys(objects).length} objects documented`);
    console.log(`   📦 ${describedCustom} custom objects`);
    if (withCount) {
        const withData = Object.values(objects).filter((o) => (o.records ?? 0) > 0).length;
        console.log(`   📊 ${withData} objects with data`);
    }
    if (errCount) console.log(`   ⚠️  ${errCount} objects skipped (describe error)`);
    console.log(`   💾 Saved to: accounts/${domain}/migrations/salesforce/discovery.json`);
    console.log('');

    // ─── Download Apex Classes & Triggers ────────────────────────────

    console.log('📥 Discovering Apex classes and triggers...');

    const baseDir = path.join(process.cwd(), 'accounts', domain, 'migrations', 'salesforce', 'apex');
    const classesDir = path.join(baseDir, 'classes');
    const triggersDir = path.join(baseDir, 'triggers');

    // Ensure directories exist
    fs.mkdirSync(classesDir, { recursive: true });
    fs.mkdirSync(triggersDir, { recursive: true });

    // List all Apex Classes and Triggers
    const [classes, triggers] = await Promise.all([
        adapter.listApexClasses(),
        adapter.listApexTriggers(),
    ]);

    console.log(`   Found ${classes.length} Apex classes`);
    console.log(`   Found ${triggers.length} Apex triggers`);

    if (classes.length === 0 && triggers.length === 0) {
        console.log('   (no Apex code found in this org)');
        console.log('');
        return discovery;
    }

    console.log('');
    console.log('   📦 Downloading Apex source code...');

    // Download all class bodies in parallel
    const apexLimit = pLimit(5); // Lower concurrency for Tooling API
    let apexDownloaded = 0;
    const apexTotal = classes.length + triggers.length;

    const classResults = await Promise.all(
        classes.map((cls) =>
            apexLimit(async () => {
                try {
                    const body = await adapter.fetchApexClassBody(cls.Id);
                    const filename = `${cls.Name}.cls`;
                    const filePath = path.join(classesDir, filename);
                    fs.writeFileSync(filePath, body, 'utf8');
                    apexDownloaded++;
                    process.stdout.write(`\r   Progress: ${apexDownloaded}/${apexTotal}`);
                    return { ...cls, filename, success: true };
                } catch (err) {
                    apexDownloaded++;
                    process.stdout.write(`\r   Progress: ${apexDownloaded}/${apexTotal}`);
                    return { ...cls, error: err.message, success: false };
                }
            })
        )
    );

    const triggerResults = await Promise.all(
        triggers.map((trg) =>
            apexLimit(async () => {
                try {
                    const body = await adapter.fetchApexTriggerBody(trg.Id);
                    const filename = `${trg.Name}.trigger`;
                    const filePath = path.join(triggersDir, filename);
                    fs.writeFileSync(filePath, body, 'utf8');
                    apexDownloaded++;
                    process.stdout.write(`\r   Progress: ${apexDownloaded}/${apexTotal}`);
                    return { ...trg, filename, success: true };
                } catch (err) {
                    apexDownloaded++;
                    process.stdout.write(`\r   Progress: ${apexDownloaded}/${apexTotal}`);
                    return { ...trg, error: err.message, success: false };
                }
            })
        )
    );

    console.log(''); // newline after progress

    // Save Apex inventory metadata
    const apexInventory = {
        fetchedAt: new Date().toISOString(),
        domain,
        classes: classResults.map((c) => ({
            id: c.Id,
            name: c.Name,
            filename: c.filename,
            namespace: c.NamespacePrefix,
            apiVersion: c.ApiVersion,
            status: c.Status,
            isValid: c.IsValid,
            linesOfCode: c.LengthWithoutComments,
            lastModified: c.LastModifiedDate,
            success: c.success,
            ...(c.error ? { error: c.error } : {}),
        })),
        triggers: triggerResults.map((t) => ({
            id: t.Id,
            name: t.Name,
            filename: t.filename,
            sobject: t.TableEnumOrId,
            apiVersion: t.ApiVersion,
            status: t.Status,
            isValid: t.IsValid,
            linesOfCode: t.LengthWithoutComments,
            lastModified: t.LastModifiedDate,
            success: t.success,
            ...(t.error ? { error: t.error } : {}),
        })),
    };

    const inventoryPath = path.join(baseDir, 'apex-inventory.json');
    fs.writeFileSync(inventoryPath, JSON.stringify(apexInventory, null, 2));

    const successClasses = classResults.filter((c) => c.success).length;
    const successTriggers = triggerResults.filter((t) => t.success).length;
    const apexFailedCount = classResults.filter((c) => !c.success).length + triggerResults.filter((t) => !t.success).length;

    console.log('');
    console.log(`✅ Apex discovery complete — ${successClasses + successTriggers} files downloaded`);
    console.log(`   📦 ${successClasses} classes → apex/classes/`);
    console.log(`   ⚡ ${successTriggers} triggers → apex/triggers/`);
    if (apexFailedCount > 0) {
        console.log(`   ⚠️  ${apexFailedCount} downloads failed (check apex-inventory.json)`);
    }
    console.log(`   💾 Inventory saved to: apex/apex-inventory.json`);

    return discovery;
}

module.exports = discover;
