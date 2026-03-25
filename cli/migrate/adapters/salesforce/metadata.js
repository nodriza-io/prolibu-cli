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
    Account: { prolibu: 'company', notes: 'Companies / customers' },
    Contact: { prolibu: 'contact', notes: 'People linked to companies' },
    Lead: { prolibu: 'contact', notes: 'Unqualified contacts — tag as lead' },
    Opportunity: { prolibu: 'deal', notes: 'Sales pipeline opportunities' },
    Quote: { prolibu: 'quote', notes: 'Commercial proposals' },
    Contract: { prolibu: 'contract', notes: 'Signed agreements' },
    Case: { prolibu: 'ticket', notes: 'Support / service cases' },
    // Products & pricing
    Product2: { prolibu: 'product', notes: 'Product catalog' },
    Pricebook2: { prolibu: 'pricebook', notes: 'Price books' },
    PricebookEntry: { prolibu: 'pricebookentry', notes: 'Price per product per pricebook' },
    OpportunityLineItem: { prolibu: 'lineitem', notes: 'Line items in deals/quotes' },
    ProductFamily: { prolibu: 'productfamily', notes: 'Product families' },
    // Activities
    Task: { prolibu: 'task', notes: 'Tasks and to-dos' },
    Event: { prolibu: 'meeting', notes: 'Calendar events / meetings' },
    Note: { prolibu: 'note', notes: 'Notes attached to records' },
    Call: { prolibu: 'call', notes: 'Call logs' },
    // Marketing
    Campaign: { prolibu: 'campaign', notes: 'Marketing campaigns' },
    CampaignMember: { prolibu: 'attendee', notes: 'Campaign participants' },
    // People & teams
    User: { prolibu: 'user', notes: 'Internal users / reps' },
    Group: { prolibu: 'group', notes: 'User groups / teams' },
    // Invoicing
    Invoice: { prolibu: 'invoice', notes: 'Invoices (if SF Billing active)' },
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
