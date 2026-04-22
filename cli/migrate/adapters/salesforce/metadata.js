'use strict';

/**
 * Salesforce CRM metadata for the generic migration UI.
 *
 * Every CRM adapter folder should export a metadata.js with the same shape
 * so the UI server can load it dynamically.
 */

/**
 * Human-friendly label shown in the dashboard.
 */
exports.label = 'Salesforce';

/**
 * Default SObject → Prolibu entity mapping.
 * Used by the Schema Map page to show recommended mappings.
 */
exports.entityMapping = {
    // Core CRM objects
    Account: { entityKey: 'accounts', prolibu: 'company', notes: 'Companies / customers' },
    Contact: { entityKey: 'contacts', prolibu: 'contact', notes: 'People linked to companies' },
    Lead: { entityKey: 'leads', prolibu: 'contact', notes: 'Unqualified contacts — tag as lead' },
    Opportunity: { entityKey: 'opportunities', prolibu: 'deal', notes: 'Sales pipeline opportunities' },
    OpportunityStage: { entityKey: 'stages', prolibu: 'stage', notes: 'Pipeline stages' },
    LeadStatus: { entityKey: 'leadStages', prolibu: 'stage', notes: 'Lead pipeline stages' },
    Quote: { entityKey: 'quotes', prolibu: 'quote', notes: 'Commercial proposals' },
    Contract: { entityKey: 'contracts', prolibu: 'contract', notes: 'Signed agreements' },
    Case: { entityKey: 'cases', prolibu: 'ticket', notes: 'Support / service cases' },
    // Products & pricing
    Product2: { entityKey: 'products', prolibu: 'product', notes: 'Product catalog' },
    Pricebook2: { entityKey: 'pricebooks', prolibu: 'pricebook', notes: 'Price books' },
    PricebookEntry: { entityKey: 'pricebookentries', prolibu: 'pricebookentry', notes: 'Price per product per pricebook' },
    OpportunityLineItem: { entityKey: 'lineitems', prolibu: 'lineitem', notes: 'Line items in deals/quotes' },
    // Activities
    Task: { entityKey: 'tasks', prolibu: 'task', notes: 'Tasks and to-dos' },
    Event: { entityKey: 'events', prolibu: 'meeting', notes: 'Calendar events / meetings' },
    Note: { entityKey: 'notes', prolibu: 'note', notes: 'Notes attached to records' },
    Call: { entityKey: 'calls', prolibu: 'call', notes: 'Call logs' },
    // Marketing
    Campaign: { entityKey: 'campaigns', prolibu: 'campaign', notes: 'Marketing campaigns' },
    // People & teams
    User: { entityKey: 'users', prolibu: 'user', notes: 'Internal users / reps' },
    // Invoicing
    Invoice: { entityKey: 'invoices', prolibu: 'invoice', notes: 'Invoices (if SF Billing active)' },
};

/**
 * Name of the adapter module (relative to the CRM folder).
 * The UI server will require(`./salesforce/${adapterModule}`) to create an adapter.
 */
exports.adapterModule = 'SalesforceAdapter';

/**
 * Credential keys required for this CRM (used for UI prompts / status checks).
 */
exports.credentialFields = ['instanceUrl', 'clientKey', 'clientSecret'];
