'use strict';

const fs = require('fs');
const path = require('path');
const credentialStore = require('../../../shared/credentialStore');

// Map UI/SF types → valid Prolibu field types
// Based on Prolibu OpenAPI spec: valid types are string, number, boolean, date, objectid
const TYPE_MAP = {
    // text-like
    text: 'string',
    string: 'string',
    email: 'string',
    phone: 'string',
    url: 'string',
    textarea: 'string',
    id: 'string',
    // numeric
    number: 'number',
    double: 'number',
    currency: 'number',
    percent: 'number',
    int: 'number',
    integer: 'number',
    // boolean
    boolean: 'boolean',
    // date
    date: 'date',
    datetime: 'date',
    // relations → objectid (user must set 'ref' to the target Prolibu model)
    relation: 'objectid',
    reference: 'objectid',
    objectid: 'objectid',
    // picklist/select → string with enum values auto-populated
    select: 'string',
    picklist: 'string',
    // multipicklist → array of strings (use mixed or string; user may want to adjust)
    multiselect: 'string',
    multipicklist: 'string',
    // address/location — no direct equivalent, map to string
    address: 'string',
    location: 'string',
    encryptedstring: 'string',
    base64: 'string',
    anytype: 'string',
    combobox: 'string',
    datacategorygroupreference: 'string',
    complexvalue: 'string',
    junctionidlist: 'string',
    time: 'string',
};

// SF types that need a user-provided 'ref' in Prolibu (objectid relations)
const OBJECTID_SF_TYPES = new Set(['relation', 'reference', 'objectid']);

// SF types that produce enum lists automatically from picklist values
const PICKLIST_SF_TYPES = new Set(['picklist', 'select', 'multipicklist', 'multiselect', 'combobox']);

function toProlibuType(t) {
    return TYPE_MAP[(t || '').toLowerCase()] || 'string';
}

// Normalize entity name to PascalCase for file names and objectAssigned/modelName
function toPascalCase(str) {
    if (!str) return str;
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Phase: scaffold
 *
 * Reads the prolibu_setup.json produced by the review phase (or accepts an
 * in-memory setup object) and generates:
 *   accounts/<domain>/objects/Cob/<ModelName>.json       — for each custom object
 *   accounts/<domain>/objects/CustomField/<Entity>.json  — for each entity with custom fields
 *
 * Only the objects and fields the user selected in the review UI are generated.
 * Entries without sourceSObject are also supported (non-SF custom objects added manually).
 *
 * After this phase, run:
 *   prolibu objects push --domain <domain>
 * to register the schema in Prolibu before migrating data.
 *
 * @param {object} context
 * @param {string}  context.domain
 * @param {boolean} [context.force]  — overwrite existing files (default: false)
 * @param {object}  [context.setup]  — in-memory setup object (skips disk read if provided)
 */
async function scaffold({ domain, force = false, setup: inMemorySetup }) {
    const chalk = (await import('chalk')).default;

    let setup;

    if (inMemorySetup) {
        // In-memory setup provided directly (e.g. from scaffold-from-discovery)
        setup = inMemorySetup;
    } else {
        // 1. Locate prolibu_setup.json on disk
        const configPath = credentialStore.getConfigPath(domain, 'salesforce');
        const setupPath = path.join(path.dirname(configPath), 'prolibu_setup.json');

        if (!fs.existsSync(setupPath)) {
            console.error(chalk.red(`\n❌ No prolibu_setup.json found for "${domain}".`));
            console.error(chalk.gray(`   Run first:\n   prolibu migrate salesforce run --domain ${domain} --phase review\n`));
            process.exit(1);
        }

        try {
            setup = JSON.parse(fs.readFileSync(setupPath, 'utf8'));
        } catch (e) {
            console.error(chalk.red(`❌ Could not parse prolibu_setup.json: ${e.message}`));
            process.exit(1);
        }
    }

    const customObjects = setup.customObjects || [];
    const customFields = setup.customFields || [];

    if (!customObjects.length && !customFields.length) {
        console.log(chalk.yellow('\n⚠️  prolibu_setup.json has no custom objects or custom fields to scaffold.'));
        console.log(chalk.gray('   Add entries via the review UI or edit prolibu_setup.json manually.\n'));
        return;
    }

    const accountsDir = path.join(process.cwd(), 'accounts', domain);
    const cobDir = path.join(accountsDir, 'objects', 'Cob');
    const cfDir = path.join(accountsDir, 'objects', 'CustomField');

    let created = 0;
    let skipped = 0;
    const warnings = [];

    // ── 2. Scaffold Custom Objects (Cob) ─────────────────────────────────────
    if (customObjects.length) {
        console.log(chalk.cyan(`\n📦 Scaffolding ${customObjects.length} Custom Object(s)...\n`));
        fs.mkdirSync(cobDir, { recursive: true });

        for (const obj of customObjects) {
            const modelName = toPascalCase(obj.prolibuEntity);
            if (!modelName) {
                console.log(chalk.yellow(`   ⚠️  Skipping entry without prolibuEntity: ${JSON.stringify(obj)}`));
                skipped++;
                continue;
            }

            const filePath = path.join(cobDir, `${modelName}.json`);

            if (fs.existsSync(filePath) && !force) {
                console.log(chalk.gray(`   ⏭  ${modelName}.json already exists — skipping (use --force to overwrite)`));
                skipped++;
                continue;
            }

            const content = {
                modelName,
                active: true,
                ...(obj.sourceSObject ? { _source: { crm: 'salesforce', sObject: obj.sourceSObject } } : {}),
            };

            fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
            const sourceNote = obj.sourceSObject ? chalk.gray(` ← ${obj.sourceSObject}`) : '';
            console.log(chalk.green(`   ✅ objects/Cob/${modelName}.json${sourceNote}`));
            created++;
        }
    }

    // ── 3. Scaffold Custom Fields ─────────────────────────────────────────────
    if (customFields.length) {
        // Group fields by prolibuEntity
        const byEntity = {};
        for (const field of customFields) {
            const entity = toPascalCase(field.prolibuEntity);
            if (!entity) {
                console.log(chalk.yellow(`   ⚠️  Skipping field without prolibuEntity: ${JSON.stringify(field)}`));
                skipped++;
                continue;
            }
            if (!byEntity[entity]) byEntity[entity] = [];
            byEntity[entity].push(field);
        }

        const entityCount = Object.keys(byEntity).length;
        console.log(chalk.cyan(`\n🏷  Scaffolding custom fields for ${entityCount} entit${entityCount === 1 ? 'y' : 'ies'}...\n`));
        fs.mkdirSync(cfDir, { recursive: true });

        for (const [entity, fields] of Object.entries(byEntity)) {
            const filePath = path.join(cfDir, `${entity}.json`);

            // Load existing file if present (merge into it)
            let existing = null;
            if (fs.existsSync(filePath)) {
                if (!force) {
                    // Merge new fields into existing customFields block
                    try {
                        existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    } catch {
                        existing = null;
                    }
                }
            }

            const customFieldsBlock = existing?.customFields || {};

            let addedCount = 0;
            for (const f of fields) {
                const apiName = f.apiName || f.sourceSField?.toLowerCase().replace(/__c$/i, '');
                if (!apiName) continue;

                if (customFieldsBlock[apiName] && !force) {
                    console.log(chalk.gray(`   ⏭  ${entity}.${apiName} already in CustomField file — skipping`));
                    skipped++;
                    continue;
                }

                const sfType = (f.type || '').toLowerCase();
                const prolibuType = toProlibuType(sfType);

                const fieldDef = {
                    isCustomField: true,
                    type: prolibuType,
                    label: f.label || apiName,
                };

                // ── Auto-map: required ─────────────────────────────────────
                // SF nillable=false && createable=true means the field is mandatory
                if (f.required === true) {
                    fieldDef.required = true;
                }

                // ── Auto-map: enum values for picklist/select types ────────
                if (PICKLIST_SF_TYPES.has(sfType) && Array.isArray(f.enum) && f.enum.length) {
                    fieldDef.enum = f.enum;
                    fieldDef.type = 'string'; // picklists always map to string
                } else if (Array.isArray(f.enum) && f.enum.length) {
                    // Caller explicitly provided enum values (e.g. from another source)
                    fieldDef.enum = f.enum;
                }

                // ── Auto-map: objectid relations (ref must be set manually) ─
                if (OBJECTID_SF_TYPES.has(sfType)) {
                    fieldDef.type = 'objectid';
                    // Write null as placeholder — user must edit to the target model name
                    fieldDef.ref = null;
                    const sfTarget = f.referenceTo || f.sourceSField || '?';
                    const warnMsg = `${entity}.${apiName}: type=objectid, references SF '${sfTarget}' — set 'ref' to the target Prolibu model name in objects/CustomField/${entity}.json`;
                    warnings.push({ field: `${entity}.${apiName}`, reason: `objectid: set 'ref' to target Prolibu model (SF references '${sfTarget}')` });
                    console.log(chalk.yellow(`   ⚠️  ${warnMsg}`));
                }

                customFieldsBlock[apiName] = fieldDef;
                addedCount++;
            }

            const content = {
                ...(existing || {}),
                objectAssigned: entity,
                active: true,
                customFields: customFieldsBlock,
            };

            // Remove internal metadata fields that shouldn't be in the source file
            const { _id, __v, createdAt, updatedAt, createdBy, updatedBy, status, ...cleanContent } = content;

            fs.writeFileSync(filePath, JSON.stringify(cleanContent, null, 2));

            if (addedCount > 0) {
                const action = existing ? 'merged into' : 'created';
                console.log(chalk.green(`   ✅ objects/CustomField/${entity}.json — ${addedCount} field(s) ${action}`));
                created++;
            }
        }
    }

    // ── 4. Summary ────────────────────────────────────────────────────────────
    console.log('');
    console.log(chalk.bold(`📋 Scaffold complete — ${created} file(s) created/updated, ${skipped} skipped`));

    if (warnings.length) {
        console.log('');
        console.log(chalk.yellow(`⚠️  ${warnings.length} field(s) need manual attention:`));
        for (const w of warnings) {
            console.log(chalk.yellow(`   • ${w.field}: ${w.reason}`));
        }
        console.log(chalk.gray('   → Open the generated CustomField JSON files and fill in the missing values.'));
    }

    console.log('');
    console.log(chalk.cyan('Next step: push the schema to Prolibu:'));
    console.log(chalk.white(`  prolibu objects push --domain ${domain}`));
    console.log('');
    console.log(chalk.gray('Then run the data migration:'));
    console.log(chalk.gray(`  prolibu migrate salesforce run --domain ${domain} --phase migrate`));
    console.log('');

    return { created, skipped, warnings };
}

module.exports = scaffold;
