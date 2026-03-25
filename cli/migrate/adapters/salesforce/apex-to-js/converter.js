/**
 * Apex-to-JS Converter
 *
 * Uses an AI provider (DeepSeek by default) to convert Salesforce Apex code
 * to equivalent Node.js JavaScript, structured as a proper Prolibu script.
 *
 * Two modes:
 *   1. Simple:   apex-to-js --file <path>                        → raw JS conversion
 *   2. Scaffold: apex-to-js --file <path> --domain <d> --scaffold → classify + convert + create Prolibu project
 *
 * Usage:
 *   prolibu migrate salesforce apex-to-js --file <path> [--domain <d>] [--scaffold] [--api-key <key>] [--provider <provider>] [--output <path>]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const AIProviderFactory = require('../../../../../lib/vendors/ai/AIProviderFactory');
const { classify, MAPPING_TABLE } = require('./classifier');

// ─── System prompts per Prolibu script type ──────────────────────────────────

const BASE_TRANSLATION_RULES = `
Apply these Apex → JS translation rules strictly:

| Apex                                    | JavaScript                              |
|-----------------------------------------|-----------------------------------------|
| HttpRequest / Http / HttpResponse       | fetch() (native Node 18+)              |
| JSON.serialize()                        | JSON.stringify()                        |
| JSON.deserializeUntyped()               | JSON.parse()                            |
| Map<String, Object>                     | plain object {}                         |
| List<T>                                 | array []                                |
| Set<Id>                                 | new Set()                               |
| System.debug()                          | console.log()                           |
| System.assert / assertEquals            | if + throw                              |
| EncodingUtil.urlEncode(x, 'UTF-8')      | encodeURIComponent(x)                   |
| Database.setSavepoint / rollback        | try/catch (no native savepoints in JS)  |
| SOQL inline queries                     | API.salesforce.query() or API.prolibu.find() |
| DML insert                              | API.prolibu.create() or API.salesforce.create() |
| DML update                              | API.prolibu.update() or API.salesforce.update() |
| DML delete                              | API.prolibu.delete() or API.salesforce.delete() |
| @future / Queueable / Batch            | async functions                         |
| Trigger context variables               | handler function parameters             |
| static variables                        | module-level constants / let            |
| String.isBlank() / isNotBlank()         | !str?.trim() / str?.trim()              |
| for (Type x : list)                     | for (const x of list)                   |
| try/catch (DmlException e)              | try/catch (error)                       |
| UserInfo.getTimezone()                  | Not needed (REST API returns UTC)        |`;

const PROMPTS = {
  lifecycleHook: (classification) => `You are an expert Salesforce Apex developer migrating code to the Prolibu scripting platform.
Convert the provided Apex trigger/trigger-handler code into a Prolibu Lifecycle Hook script.

${BASE_TRANSLATION_RULES}

## Prolibu Lifecycle Hook Script Structure

The script MUST use the Prolibu EventManager pattern:

\`\`\`javascript
/* global eventName, eventData, env, axios, variables, setVariable, lifecycleHooks */
const Events = require('lib/vendors/prolibu/EventManager');
const { getVariable } = require('lib/utils/variables');

// Register lifecycle hook handlers
Events.on('Entity.afterCreate', async (doc, { API, requestUser, logger }) => {
  // doc = the created document
});

Events.on('Entity.afterUpdate', async (doc, beforeUpdateDoc, payload, { API, requestUser, logger }) => {
  // doc = current document, beforeUpdateDoc = previous state, payload = changed fields
});

Events.on('Entity.beforeDelete', async (doc, { API, requestUser, logger }) => {
  // throw to abort deletion
});

(async function main() { await Events.init(); })();
\`\`\`

## Hook signatures:
- beforeCreate/afterCreate/beforeDelete/afterDelete: (doc, { API, requestUser, logger })
- beforeUpdate/afterUpdate: (doc, beforeUpdateDoc, payload, { API, requestUser, logger })
- before* hooks can throw to abort the operation

## Entity mapping for this code:
${JSON.stringify(classification.prolibu.lifecycleHooks)} → use these as the entity prefix (e.g. "Contact.afterCreate")

## Event handlers needed:
${classification.prolibu.eventHandlers.map(h => `- ${h.eventName}: ${h.description}`).join('\n')}

## Important:
- Use API.prolibu for Prolibu CRUD, API.salesforce for Salesforce CRUD
- Use getVariable() for any hardcoded URLs, keys, or config values
- Prevent infinite loops: check payload fields or use a sync flag before making changes
- Output ONLY the JavaScript code, no explanations or markdown fences`,

  endpointRequest: (classification) => `You are an expert Salesforce Apex developer migrating code to the Prolibu scripting platform.
Convert the provided @RestResource Apex class into a Prolibu EndpointRequest script.

${BASE_TRANSLATION_RULES}

## Prolibu EndpointRequest Script Structure

\`\`\`javascript
/* global eventName, eventData, env, axios, variables, setVariable */
const Events = require('lib/vendors/prolibu/EventManager');
const { getVariable } = require('lib/utils/variables');

Events.on('EndpointRequest', async () => {
  const { endpoint, body, query, params, headers, ip } = eventData;
  const method = endpoint.method; // GET, POST, PUT, DELETE

  // Route: ${classification.prolibu.endpointRoute || '/migrated-endpoint'}
  // Return response:
  return {
    statusCode: 200,
    body: { success: true, data: result },
    headers: { 'Content-Type': 'application/json' }
  };
});

(async function main() { await Events.init(); })();
\`\`\`

## Endpoint mapping:
- Original SF route: ${classification.classification.sfEndpoints?.join(', ') || 'N/A'}
- Prolibu route: ${classification.prolibu.endpointRoute || 'TBD'}
- Method: ${classification.prolibu.endpointMethod || 'POST'}

## Important:
- RestContext.request.requestBody → eventData.body
- RestContext.request.params → eventData.params
- RestContext.response.statusCode → return { statusCode, body }
- Use getVariable() for any hardcoded URLs, keys, or config values
- Output ONLY the JavaScript code, no explanations or markdown fences`,

  scheduledTask: (classification) => `You are an expert Salesforce Apex developer migrating code to the Prolibu scripting platform.
Convert the provided Schedulable/Batchable Apex class into a Prolibu ScheduledTask script.

${BASE_TRANSLATION_RULES}

## Prolibu ScheduledTask Script Structure

\`\`\`javascript
/* global eventName, eventData, env, axios, variables, setVariable */
const Events = require('lib/vendors/prolibu/EventManager');
const { getVariable } = require('lib/utils/variables');

Events.on('ScheduledTask', async () => {
  const { scheduledAt, periodicity, executionCount, lastExecution } = eventData;

  // Batch processing: use API.prolibu.find() with pagination
  // instead of Database.Batchable start/execute/finish pattern
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const results = await API.prolibu.find('entity', { query, page, limit: 200 });
    // process batch...
    hasMore = results.length === 200;
    page++;
  }
});

(async function main() { await Events.init(); })();
\`\`\`

## Schedule mapping:
- Suggested cron: ${classification.prolibu.periodicity || '0 2 * * *'}
- Original SF pattern: ${classification.classification.sfType}

## Important:
- Database.Batchable start() → find() with pagination loop
- Database.Batchable execute(scope) → process each page inside the loop
- Database.Batchable finish() → code after the loop
- Use getVariable() for any hardcoded URLs, keys, or config values
- Output ONLY the JavaScript code, no explanations or markdown fences`,

  apiRun: (classification) => `You are an expert Salesforce Apex developer migrating code to the Prolibu scripting platform.
Convert the provided Apex class into a Prolibu ApiRun script.

${BASE_TRANSLATION_RULES}

## Prolibu ApiRun Script Structure

\`\`\`javascript
/* global eventName, eventData, env, axios, variables, setVariable */
const Events = require('lib/vendors/prolibu/EventManager');
const { getVariable } = require('lib/utils/variables');

Events.on('ApiRun', async () => {
  const { query, body } = eventData;

  // Your converted logic here
  // Use API.prolibu for Prolibu CRUD
  // Use API.salesforce for SF CRUD
  // Use fetch() or axios for external HTTP calls
});

(async function main() { await Events.init(); })();
\`\`\`

## Important:
- Use getVariable() for any hardcoded URLs, keys, or config values
- HttpRequest/Http → fetch() or axios (both available)
- Output ONLY the JavaScript code, no explanations or markdown fences`,

  library: () => `You are an expert Salesforce Apex developer migrating code to Node.js.
Convert the provided Apex utility/service class into a reusable Node.js CommonJS module.

${BASE_TRANSLATION_RULES}

## Output format:
- 'use strict' at the top
- Export all public methods via module.exports
- Use async/await for all async operations
- Use getVariable() for hardcoded config values
- Output ONLY the JavaScript code, no explanations or markdown fences`,
};

/**
 * Get the appropriate system prompt based on classification.
 */
function getSystemPrompt(classification) {
    const type = classification?.prolibu?.scriptType || 'apiRun';
    const promptFn = PROMPTS[type] || PROMPTS.apiRun;
    return promptFn(classification);
}

/**
 * Convert Apex code to JavaScript using an AI provider.
 *
 * @param {string} apexCode - The Apex source code to convert
 * @param {Object} options
 * @param {string} options.apiKey - AI provider API key
 * @param {string} [options.provider='deepseek'] - AI provider name
 * @param {string} [options.model] - Specific model to use
 * @param {Object} [options.classification] - Pre-computed classification (if available)
 * @returns {Promise<{code: string, usage: Object}>}
 */
async function convert(apexCode, { apiKey, provider = 'deepseek', model, classification }) {
    const ai = AIProviderFactory.create(provider, { apiKey });

    const systemPrompt = classification
        ? getSystemPrompt(classification)
        : PROMPTS.apiRun({ prolibu: { eventHandlers: [] } });

    const result = await ai.complete({
        prompt: apexCode,
        systemPrompt,
        temperature: 0.2,
        maxTokens: 8000,
        ...(model && { model }),
    });

    // Strip markdown fences if the model wraps output in them
    let code = result.text;
    code = code.replace(/^```(?:javascript|js)?\n/i, '').replace(/\n```\s*$/, '');

    return { code, usage: result.usage };
}

/**
 * Scaffold a complete Prolibu script project from a classification.
 */
function scaffold(outputDir, classification, jsCode) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(path.join(outputDir, 'lib'), { recursive: true });

    // index.js — the converted code
    fs.writeFileSync(path.join(outputDir, 'index.js'), jsCode);

    // config.json
    const config = { variables: [], lifecycleHooks: [], readme: '', git: { repositoryUrl: '' } };
    const p = classification.prolibu;

    if (p.variables?.length) {
        config.variables = p.variables.map(v => ({ key: v.key, value: v.value || '' }));
    }
    if (p.lifecycleHooks?.length) {
        config.lifecycleHooks = p.lifecycleHooks;
    }

    fs.writeFileSync(path.join(outputDir, 'config.json'), JSON.stringify(config, null, 2));

    // settings.json
    fs.writeFileSync(path.join(outputDir, 'settings.json'), JSON.stringify({
        minifyProductionCode: false,
        removeComments: false,
    }, null, 2));

    // README.md
    const readme = buildReadme(classification);
    fs.writeFileSync(path.join(outputDir, 'README.md'), readme);

    // lib/utils.js placeholder
    fs.writeFileSync(path.join(outputDir, 'lib', 'utils.js'), `module.exports = {\n  // Add shared helpers here\n};\n`);

    return outputDir;
}

function buildReadme(classification) {
    const c = classification.classification;
    const p = classification.prolibu;
    const lines = [
        `# ${p.suggestedName || 'migrated-script'}`,
        '',
        `> Migrated from Salesforce ${c.sfType} → Prolibu ${p.scriptType}`,
        '',
        `## Type: ${p.scriptType}`,
        '',
    ];

    if (p.eventHandlers?.length) {
        lines.push('## Event Handlers', '');
        for (const h of p.eventHandlers) {
            lines.push(`- **${h.eventName}** — ${h.description}`);
        }
        lines.push('');
    }
    if (p.lifecycleHooks?.length) {
        lines.push(`## Lifecycle Hooks: ${p.lifecycleHooks.join(', ')}`, '');
    }
    if (p.periodicity) {
        lines.push(`## Schedule: \`${p.periodicity}\``, '');
    }
    if (p.endpointRoute) {
        lines.push(`## Endpoint: ${p.endpointMethod || 'POST'} ${p.endpointRoute}`, '');
    }
    if (p.variables?.length) {
        lines.push('## Variables', '');
        for (const v of p.variables) {
            lines.push(`- \`${v.key}\` — ${v.description || ''}`);
        }
        lines.push('');
    }
    if (p.dependencies?.length) {
        lines.push(`## Dependencies: ${p.dependencies.join(', ')}`, '');
    }
    if (p.notes?.length) {
        lines.push('## Migration Notes', '');
        for (const n of p.notes) {
            lines.push(`- ${n}`);
        }
        lines.push('');
    }
    lines.push(`## Complexity: ${classification.complexity || 'unknown'}`, '');
    lines.push(`## Estimated Effort: ${classification.estimatedEffort || 'unknown'}`, '');

    return lines.join('\n');
}

/**
 * Resolve AI API key from flags, env, or domain credentials.
 */
function resolveApiKey(flags) {
    let apiKey = flags['api-key'] || flags.apiKey || process.env.DEEPSEEK_API_KEY;

    if (!apiKey && flags.domain) {
        const credentialStore = require('../../../shared/credentialStore');
        const creds = credentialStore.getCredentials(flags.domain, 'salesforce');
        if (creds) apiKey = creds.deepseekApiKey || creds.openaiApiKey || creds.anthropicApiKey;
    }

    return apiKey;
}

/**
 * CLI handler for `prolibu migrate salesforce apex-to-js`
 */
async function handler(flags) {
    const filePath = flags.file;
    if (!filePath) {
        console.error('❌ --file <path> is required (path to an .apex or .cls file)');
        process.exit(1);
    }

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
        console.error(`❌ File not found: ${resolved}`);
        process.exit(1);
    }

    const apiKey = resolveApiKey(flags);
    if (!apiKey) {
        console.error('❌ API key required. Provide --api-key <key>, set DEEPSEEK_API_KEY env var, or use --domain.');
        console.log('');
        console.log('Get a key at https://platform.deepseek.com/');
        console.log('DeepSeek is very cheap (~$0.14/M input tokens, ~$0.28/M output tokens).');
        process.exit(1);
    }

    const provider = flags.provider || 'deepseek';
    const apexCode = fs.readFileSync(resolved, 'utf8');
    const doScaffold = flags.scaffold || flags.s;
    let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    try {
        // ── Step 1: Classify ────────────────────────────────────
        console.log(`🔍 Classifying Apex code using ${provider}...`);
        const { classification, usage: classifyUsage } = await classify(apexCode, {
            apiKey, provider, model: flags.model,
        });
        totalUsage.promptTokens += classifyUsage.promptTokens;
        totalUsage.completionTokens += classifyUsage.completionTokens;
        totalUsage.totalTokens += classifyUsage.totalTokens;

        const p = classification.prolibu;
        const c = classification.classification;

        console.log(`   SF Type:      ${c.sfType}`);
        console.log(`   SF Entities:  ${c.sfEntities?.join(', ') || 'none'}`);
        console.log(`   → Prolibu:    ${p.scriptType}`);
        if (p.lifecycleHooks?.length) console.log(`   Hooks:        ${p.lifecycleHooks.join(', ')}`);
        if (p.endpointRoute) console.log(`   Endpoint:     ${p.endpointMethod || 'POST'} ${p.endpointRoute}`);
        if (p.periodicity) console.log(`   Schedule:     ${p.periodicity}`);
        if (p.eventHandlers?.length) {
            console.log(`   Handlers:`);
            for (const h of p.eventHandlers) {
                console.log(`     • ${h.eventName} → ${h.description}`);
            }
        }
        console.log('');

        // ── Step 2: Convert ─────────────────────────────────────
        console.log(`🔄 Converting Apex → Prolibu ${p.scriptType} script...`);
        const { code, usage: convertUsage } = await convert(apexCode, {
            apiKey, provider, model: flags.model, classification,
        });
        totalUsage.promptTokens += convertUsage.promptTokens;
        totalUsage.completionTokens += convertUsage.completionTokens;
        totalUsage.totalTokens += convertUsage.totalTokens;

        // ── Step 3: Output ──────────────────────────────────────
        if (doScaffold) {
            const scriptName = p.suggestedName || path.basename(resolved, path.extname(resolved)).toLowerCase().replace(/[^a-z0-9]+/g, '-');
            const domain = flags.domain || 'local';
            const outputDir = flags.output || path.join(process.cwd(), 'accounts', domain, scriptName);

            scaffold(outputDir, classification, code);

            console.log('');
            console.log(`✅ Prolibu script project scaffolded!`);
            console.log(`   📁 ${outputDir}`);
            console.log(`   ├── index.js        (converted code)`);
            console.log(`   ├── config.json     (variables, lifecycleHooks)`);
            console.log(`   ├── settings.json   (build settings)`);
            console.log(`   ├── README.md       (migration docs)`);
            console.log(`   └── lib/utils.js    (shared helpers)`);
            console.log('');
            console.log(`   Next: prolibu script dev --domain ${domain} --prefix ${scriptName}`);
        } else {
            const outputPath = flags.output || flags.o
                || resolved.replace(/\.(apex|cls|trigger)$/i, '.js');
            fs.writeFileSync(outputPath, code);
            console.log(`✅ Conversion complete → ${outputPath}`);
        }

        // ── Summary ─────────────────────────────────────────────
        console.log(`   Tokens: ${totalUsage.totalTokens} (prompt: ${totalUsage.promptTokens}, completion: ${totalUsage.completionTokens})`);
        if (p.notes?.length) {
            console.log('');
            console.log('⚠️  Migration notes:');
            for (const note of p.notes) {
                console.log(`   • ${note}`);
            }
        }
    } catch (err) {
        console.error(`❌ Failed: ${err.message}`);
        process.exit(1);
    }
}

module.exports = { convert, classify, scaffold, handler };
