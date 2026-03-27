/**
 * Prolibu Script Template — Base Skeleton
 * 
 * This is the canonical structure for all Prolibu scripts.
 * Replace the TODOs with your actual implementation.
 */

/* global eventName, eventData, env, axios, variables, localDomain, lifecycleHooks */

const Events = require('../../../lib/vendors/prolibu/EventManager');
const ProlibuApi = require('../../../lib/vendors/prolibu/ProlibuApi');
const { getRequiredVars } = require('../../../lib/utils/variables');

// ══════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════

const vars = getRequiredVars({
    prolibuApiKey: `prolibu-apiKey-${env}`,
    // TODO: Add other credentials as needed
    // sfInstanceUrl: `sf-instanceUrl-${env}`,
    // sfConsumerKey: `sf-consumerKey-${env}`,
    // sfConsumerSecret: `sf-consumerSecret-${env}`,
    // externalApiToken: `external-token-${env}`,
});

const prolibuApi = new ProlibuApi({
    domain: localDomain,
    apiKey: vars.prolibuApiKey,
});

// TODO: Initialize other API clients if needed
// const SalesforceApi = require('../../../lib/vendors/salesforce/SalesforceApi');
// const salesforceApi = new SalesforceApi({
//   instanceUrl: vars.sfInstanceUrl,
//   customerKey: vars.sfConsumerKey,
//   customerSecret: vars.sfConsumerSecret,
//   apiVersion: '58.0',
// });

// ══════════════════════════════════════════════════════════
// FIELD MAPPING (Apex PascalCase → Prolibu camelCase)
// ══════════════════════════════════════════════════════════

const FIELD_MAP = {
    // TODO: Define your field mappings
    // 'FirstName': 'firstName',
    // 'LastName': 'lastName',
    // 'Email': 'email',
    // 'MobilePhone': 'mobile',
    // 'AccountId': 'companyId',
    // 'Id': 'salesforceId',
};

function mapToExternal(doc) {
    const result = {};
    for (const [externalField, prolibuField] of Object.entries(FIELD_MAP)) {
        if (doc[prolibuField] !== undefined) {
            result[externalField] = doc[prolibuField];
        }
    }
    return result;
}

function mapFromExternal(externalDoc) {
    const result = {};
    for (const [externalField, prolibuField] of Object.entries(FIELD_MAP)) {
        if (externalDoc[externalField] !== undefined) {
            result[prolibuField] = externalDoc[externalField];
        }
    }
    return result;
}

// ══════════════════════════════════════════════════════════
// LIFECYCLE HOOKS
// ══════════════════════════════════════════════════════════

// ── beforeCreate ────────────────────────────────────────
// Use for: validation, field defaults, abort creation
Events.on('Contact.beforeCreate', async () => {
    const { doc } = eventData;

    // TODO: Validation — throw to abort
    // if (!doc.email) {
    //   throw new Error('Email is required');
    // }

    // TODO: Set default values
    // doc.source = 'prolibu';
    // doc.createdAt = new Date();
});

// ── afterCreate ─────────────────────────────────────────
// Use for: external sync, notifications (cannot abort)
Events.on('Contact.afterCreate', async () => {
    const { doc } = eventData;

    try {
        // TODO: Sync to external system
        // await salesforceApi.authenticate();
        // const sfResult = await salesforceApi.create('Contact', mapToExternal(doc));
        // await prolibuApi.update('Contact', doc._id, { salesforceId: sfResult.id });

        console.log('afterCreate processed:', doc._id);
    } catch (error) {
        console.error('afterCreate failed:', error.message);
        // Do NOT rethrow — record is already created
    }
});

// ── beforeUpdate ────────────────────────────────────────
// Use for: validation, conditional changes, abort update
Events.on('Contact.beforeUpdate', async () => {
    const { doc, beforeUpdateDoc, payload } = eventData;

    // TODO: Validate specific field changes
    // if (payload.email) {
    //   const existing = await prolibuApi.find('Contact', {
    //     xquery: JSON.stringify({ email: payload.email, _id: { $ne: doc._id } }),
    //     limit: 1,
    //   });
    //   if (existing.data?.length > 0) {
    //     throw new Error('Email already in use');
    //   }
    // }

    // TODO: Track state changes
    // if (payload.status && payload.status !== beforeUpdateDoc.status) {
    //   doc.statusChangedAt = new Date();
    // }
});

// ── afterUpdate ─────────────────────────────────────────
// Use for: sync changes to external systems (cannot abort)
Events.on('Contact.afterUpdate', async () => {
    const { doc, beforeUpdateDoc, payload } = eventData;

    try {
        // TODO: Only sync specific fields
        // const syncFields = ['name', 'email', 'mobile'];
        // const shouldSync = Object.keys(payload).some(key => syncFields.includes(key));
        // if (!shouldSync || !doc.salesforceId) return;

        // await salesforceApi.authenticate();
        // await salesforceApi.update('Contact', doc.salesforceId, mapToExternal(payload));

        console.log('afterUpdate processed:', doc._id);
    } catch (error) {
        console.error('afterUpdate failed:', error.message);
    }
});

// ── beforeDelete ────────────────────────────────────────
// Use for: prevent deletion, check dependencies
Events.on('Contact.beforeDelete', async () => {
    const { doc } = eventData;

    // TODO: Check for dependencies
    // const orders = await prolibuApi.find('Order', {
    //   xquery: JSON.stringify({ contactId: doc._id, status: 'active' }),
    //   limit: 1,
    // });
    // if (orders.data?.length > 0) {
    //   throw new Error('Cannot delete contact with active orders');
    // }
});

// ── afterDelete ─────────────────────────────────────────
// Use for: cascade delete in external systems
Events.on('Contact.afterDelete', async () => {
    const { doc } = eventData;

    try {
        // TODO: Delete from external system
        // if (doc.salesforceId) {
        //   await salesforceApi.authenticate();
        //   await salesforceApi.delete('Contact', doc.salesforceId);
        // }

        console.log('afterDelete processed:', doc._id);
    } catch (error) {
        console.error('afterDelete failed:', error.message);
    }
});

// ══════════════════════════════════════════════════════════
// OTHER EVENT TYPES (uncomment as needed)
// ══════════════════════════════════════════════════════════

// ── ApiRun ──────────────────────────────────────────────
// Manual trigger via POST /v2/script/run
// Events.on('ApiRun', async () => {
//   const { query, body } = eventData;
//   console.log('ApiRun triggered', { query, body });
// });

// ── ScheduledTask ───────────────────────────────────────
// Cron-driven execution (configure periodicity in config.json)
// Events.on('ScheduledTask', async () => {
//   const { scheduledAt, executionCount } = eventData;
//   console.log('ScheduledTask triggered', { scheduledAt, executionCount });
// });

// ── EndpointRequest ─────────────────────────────────────
// Custom HTTP endpoint / webhook receiver
// Events.on('EndpointRequest', async () => {
//   const { headers, query, body, params } = eventData;
//   console.log('EndpointRequest triggered', { headers, query, body, params });
// });

// ══════════════════════════════════════════════════════════
// BOOTSTRAP
// ══════════════════════════════════════════════════════════

(async function main() {
    await Events.init();
})();
