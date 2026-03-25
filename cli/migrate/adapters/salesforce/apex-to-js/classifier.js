/**
 * Apex → Prolibu Script Classifier
 *
 * Analyzes Salesforce Apex code (classes, triggers, scheduled jobs, REST endpoints)
 * and determines what type of Prolibu script it should become, including lifecycle
 * hooks, event types, and project structure.
 *
 * Flow:
 *   1. classify()  — sends Apex code to AI, gets back a classification JSON
 *   2. The converter uses the classification to pick the right system prompt
 *      and scaffold the correct Prolibu project structure
 */

'use strict';

const AIProviderFactory = require('../../../../../lib/vendors/ai/AIProviderFactory');

// ─── Salesforce → Prolibu mapping reference (embedded in the prompt) ─────────

const MAPPING_TABLE = `
## Salesforce → Prolibu Mapping Reference

### Apex Trigger → Prolibu Lifecycle Hook Script
| Salesforce                        | Prolibu                                      |
|-----------------------------------|----------------------------------------------|
| Trigger on Account                | lifecycleHooks: ["Company"]                  |
| Trigger on Contact                | lifecycleHooks: ["Contact"]                  |
| Trigger on Opportunity            | lifecycleHooks: ["Deal"]                     |
| Trigger on Quote / Quote__c       | lifecycleHooks: ["Quote"]                    |
| Trigger on Product2               | lifecycleHooks: ["Product"]                  |
| Trigger on Contract               | lifecycleHooks: ["Contract"]                 |
| Trigger on Lead                   | lifecycleHooks: ["Contact"] (tag as lead)    |
| Trigger on Case                   | lifecycleHooks: ["Ticket"]                   |
| Trigger on Task                   | lifecycleHooks: ["Task"]                     |
| Trigger on Event                  | lifecycleHooks: ["Meeting"]                  |
| Trigger on Custom Object          | lifecycleHooks: ["CustomObjectName"]         |
| before insert                     | Events.on('Entity.beforeCreate', handler)    |
| after insert                      | Events.on('Entity.afterCreate', handler)     |
| before update                     | Events.on('Entity.beforeUpdate', handler)    |
| after update                      | Events.on('Entity.afterUpdate', handler)     |
| before delete                     | Events.on('Entity.beforeDelete', handler)    |
| after delete                      | Events.on('Entity.afterDelete', handler)     |
| Trigger.new                       | doc (first arg of handler)                   |
| Trigger.old / Trigger.oldMap      | beforeUpdateDoc (second arg in update hooks) |
| Trigger.newMap                    | { [doc._id]: doc }                           |

### @RestResource / Web Service → Prolibu EndpointRequest Script
| Salesforce                        | Prolibu                                      |
|-----------------------------------|----------------------------------------------|
| @RestResource(urlMapping='/x')    | EndpointRequest route: /x                   |
| @HttpGet                          | Events.on('EndpointRequest', handler) + check eventData.endpoint.method === 'GET' |
| @HttpPost                         | check method === 'POST'                      |
| @HttpPut                          | check method === 'PUT'                       |
| @HttpDelete                       | check method === 'DELETE'                    |
| RestContext.request.params        | eventData.params                             |
| RestContext.request.requestBody   | eventData.body                               |
| RestContext.request.headers       | eventData.headers                            |
| RestContext.response.statusCode   | return { statusCode, body, headers }         |

### Schedulable / Batch / Queueable → Prolibu ScheduledTask Script
| Salesforce                        | Prolibu                                      |
|-----------------------------------|----------------------------------------------|
| implements Schedulable            | Events.on('ScheduledTask', handler)          |
| execute(SchedulableContext)       | handler receives eventData.scheduledAt, etc  |
| System.schedule(cron, job)        | Script.periodicity = '<cron>'                |
| implements Database.Batchable     | ScheduledTask with batched API calls         |
| start() → QueryLocator           | Prolibu API find() with pagination           |
| execute(BC, scope)                | Process batch in a loop                      |
| finish(BC)                        | After loop completes                         |
| implements Queueable              | ScheduledTask or ApiRun (depends on trigger) |
| System.enqueueJob()               | POST /v2/script/run (from another script)    |

### Apex class with HTTP callouts → Prolibu ApiRun Script
| Salesforce                        | Prolibu                                      |
|-----------------------------------|----------------------------------------------|
| HttpRequest / Http.send()         | fetch() or axios                             |
| @future(callout=true)             | async function (runs immediately)            |
| Apex class (utility/service)      | ApiRun if ad-hoc, or lib/ module if shared   |

### Salesforce Entity → Prolibu Entity
| SObject         | Prolibu Model     |
|-----------------|-------------------|
| Account         | Company           |
| Contact         | Contact           |
| Lead            | Contact (tagged)  |
| Opportunity     | Deal              |
| Quote           | Quote             |
| Contract        | Contract          |
| Case            | Ticket            |
| Product2        | Product           |
| Pricebook2      | Pricebook         |
| PricebookEntry  | PricebookEntry    |
| Task            | Task              |
| Event           | Meeting           |
| User            | User              |
| Campaign        | Campaign          |
| Note            | Note              |
| Custom__c       | Custom Object     |

### Prolibu Script Handler Signatures
| Hook            | Signature                                                         |
|-----------------|-------------------------------------------------------------------|
| beforeCreate    | async (doc, { API, requestUser, logger }) => {}                   |
| afterCreate     | async (doc, { API, requestUser, logger }) => {}                   |
| beforeUpdate    | async (doc, beforeUpdateDoc, payload, { API, requestUser, logger }) => {} |
| afterUpdate     | async (doc, beforeUpdateDoc, payload, { API, requestUser, logger }) => {} |
| beforeDelete    | async (doc, { API, requestUser, logger }) => {}                   |
| afterDelete     | async (doc, { API, requestUser, logger }) => {}                   |

### Prolibu Script Globals
- eventName, eventData, env, axios, variables, setVariable, lifecycleHooks
- API object: API.prolibu (find, findOne, create, update, delete), API.salesforce (SOQL query, CRUD)
- getVariable(key), getRequiredVars({ alias: 'VAR_NAME' })
`;

const CLASSIFIER_PROMPT = `You are an expert Salesforce-to-Prolibu migration architect.

Analyze the provided Salesforce Apex code and classify it for migration to the Prolibu scripting platform.

${MAPPING_TABLE}

## Your Task

Analyze the Apex code and return a JSON object with this EXACT structure (no markdown, no explanation, just JSON):

{
  "classification": {
    "sfType": "<trigger|restResource|schedulable|batchable|queueable|serviceClass|utilityClass|controller|testClass>",
    "sfEntities": ["<SObject names referenced, e.g. Account, Contact, Opportunity>"],
    "sfTriggerEvents": ["<if trigger: before insert, after update, etc.>"],
    "sfEndpoints": ["<if REST: urlMapping paths>"],
    "sfSchedule": "<if schedulable: suggested cron expression or null>"
  },
  "prolibu": {
    "scriptType": "<lifecycleHook|endpointRequest|scheduledTask|apiRun|library>",
    "eventHandlers": [
      {
        "eventName": "<e.g. Contact.afterCreate, EndpointRequest, ScheduledTask, ApiRun>",
        "description": "<what this handler does in one line>"
      }
    ],
    "lifecycleHooks": ["<Prolibu model names if lifecycleHook, e.g. Company, Contact, Deal>"],
    "endpointRoute": "<if endpointRequest: suggested route path or null>",
    "endpointMethod": "<GET|POST|PUT|DELETE or null>",
    "periodicity": "<if scheduledTask: cron expression or null>",
    "variables": [
      { "key": "<VAR_NAME>", "value": "", "description": "<what this var holds>" }
    ],
    "dependencies": ["<external services or APIs used, e.g. Salesforce API, SendGrid, etc.>"],
    "suggestedName": "<kebab-case script prefix, e.g. sf-contact-sync>",
    "notes": ["<migration notes, warnings, or TODOs>"]
  },
  "complexity": "<simple|moderate|complex>",
  "estimatedEffort": "<description: trivial, small, medium, large>"
}

Rules:
1. If the Apex code is a Trigger, map it to lifecycleHook. Map SObjects to Prolibu entity names.
2. If it's a @RestResource, map to endpointRequest with the appropriate route and method.
3. If it implements Schedulable or Database.Batchable, map to scheduledTask.
4. If it's a utility/service class with callouts, map to apiRun or library.
5. If it's a test class (@isTest), classify as testClass with scriptType "library" and add a note.
6. If a class handles multiple concerns (e.g. trigger handler with scheduled cleanup), list ALL eventHandlers.
7. Always list required variables (API keys, URLs, config values) that should be extracted.
8. SOQL queries that reference custom fields (__c) should get a TODO note about field mapping.
9. Output ONLY valid JSON. No markdown fences, no explanation text.`;


/**
 * Classify Apex code to determine how it maps to Prolibu's scripting system.
 *
 * @param {string} apexCode - Apex source code
 * @param {Object} options
 * @param {string} options.apiKey - AI provider API key
 * @param {string} [options.provider='deepseek']
 * @param {string} [options.model]
 * @returns {Promise<{classification: Object, usage: Object}>}
 */
async function classify(apexCode, { apiKey, provider = 'deepseek', model }) {
    const ai = AIProviderFactory.create(provider, { apiKey });

    const result = await ai.complete({
        prompt: apexCode,
        systemPrompt: CLASSIFIER_PROMPT,
        temperature: 0.1,
        maxTokens: 4000,
        ...(model && { model }),
    });

    let text = result.text.trim();
    // Strip markdown fences if present
    text = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/, '');

    const classification = JSON.parse(text);
    return { classification, usage: result.usage };
}

module.exports = { classify, MAPPING_TABLE };
