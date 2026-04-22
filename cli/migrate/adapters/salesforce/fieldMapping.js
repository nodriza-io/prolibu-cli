'use strict';

/**
 * Convert a vendor map (Prolibu→SF direction) to migrate format (SF→Prolibu).
 *
 * Inverts the key-value pairs from the vendor map, skipping non-string values
 * (transforms, reverseTransforms, etc.), then applies overrides:
 *   - add: { SFField: prolibuField }  — additional mappings
 *   - remove: ['SFField', ...]        — fields to exclude
 *
 * @param {object} vendorMap  - e.g. CompanyMap: { companyName: 'Name', ... }
 * @param {object} [overrides]
 * @param {object} [overrides.add]    - Extra SF→Prolibu mappings to include
 * @param {string[]} [overrides.remove] - SF field names to exclude
 * @returns {object} SF→Prolibu mapping: { Name: 'companyName', ... }
 */
function toMigrateFormat(vendorMap, { add = {}, remove = [] } = {}) {
    const result = {};
    for (const [prolibuField, sfField] of Object.entries(vendorMap)) {
        // Skip non-string entries (transforms, reverseTransforms, etc.)
        if (typeof sfField !== 'string') continue;
        result[sfField] = prolibuField;
    }
    // Apply removals
    for (const key of remove) {
        delete result[key];
    }
    // Apply additions (additions take priority)
    Object.assign(result, add);
    return result;
}

// ─── Vendor maps ───────────────────────────────────────────────
const CompanyMap = require('../../../../lib/vendors/salesforce/maps/CompanyMap');
const ContactMap = require('../../../../lib/vendors/salesforce/maps/ContactMap');
const DealMap = require('../../../../lib/vendors/salesforce/maps/DealMap');
const StageMap = require('../../../../lib/vendors/salesforce/maps/StageMap');
const UserMap = require('../../../../lib/vendors/salesforce/maps/UserMap');

/**
 * Known Salesforce → Prolibu field mappings.
 *
 * Each key is a Salesforce SObject name (matching the entityMapping in metadata.js).
 * The value is an object whose keys are SF field API names and values are the
 * corresponding Prolibu field paths.
 *
 * When a field doesn't have a direct match in the Prolibu core schema, use:
 *   - `customFields.<name>` → will be written to Prolibu custom fields.
 *   - `null`                → explicitly skip (won't auto-match).
 *
 * These mappings are loaded by the UI so the Schema Map page shows
 * pre-populated, known-good defaults that the user can still override.
 */

const fieldMapping = {

    /* ────────────────────────────────────────────────────────────
     * Account → company  (derived from CompanyMap)
     * ──────────────────────────────────────────────────────────── */
    Account: toMigrateFormat(CompanyMap, {
        remove: [
            'BillingLatitude', 'BillingLongitude', 'CurrencyIsoCode', 'Tradestyle',
        ],
        add: {
            Id: 'refId',
            // Vendor map uses postalCode; Prolibu model uses zip
            BillingPostalCode: 'address.zip',
            AccountNumber: 'companyCode',
            Fax: 'phones.fax',
            // Shipping address — explicitly skipped
            ShippingStreet: null,
            ShippingCity: null,
            ShippingState: null,
            ShippingPostalCode: null,
            ShippingCountry: null,
            // Classification
            Industry: 'industry',
            NumberOfEmployees: 'numberOfEmployees',
            // Extra fields to custom
            Description: 'customFields.description',
            Type: 'customFields.accountType',
            AnnualRevenue: 'customFields.annualRevenue',
            Rating: 'customFields.rating',
            OwnerId: { to: 'assignee', ref: 'User' },
        },
    }),

    /* ────────────────────────────────────────────────────────────
     * Contact → contact  (derived from ContactMap)
     * ──────────────────────────────────────────────────────────── */
    Contact: toMigrateFormat(ContactMap, {
        remove: [
            'MailingLatitude', 'MailingLongitude',
        ],
        add: {
            Id: 'refId',
            MailingPostalCode: 'address.zip',
            Phone: 'phones.work',
            AccountId: { to: 'company', ref: 'company' },
            // Social (not standard SF fields — uncomment if org has them)
            // LinkedIn: 'socialNetworks.linkedin',
            // Twitter: 'socialNetworks.twitter',
            // Extra
            Department: 'customFields.department',
            Description: 'customFields.description',
            Birthdate: 'customFields.birthdate',
            LeadSource: 'source',
            OwnerId: { to: 'assignee', ref: 'User' },
        },
    }),

    /* ────────────────────────────────────────────────────────────
     * Lead → contact  (tagged as lead)
     * ──────────────────────────────────────────────────────────── */
    Lead: {
        Id: 'refId',
        FirstName: 'firstName',
        LastName: 'lastName',
        Email: 'email',
        Title: 'jobTitle',
        Phone: 'phones.work',
        MobilePhone: 'mobile',
        Company: 'companyName',
        OwnerId: { to: 'assignee', ref: 'User' },
        Street: 'address.street',
        City: 'address.city',
        State: 'address.state',
        PostalCode: 'address.zip',
        Country: 'address.country',
        LeadSource: 'source',
        Status: 'stage',
        Industry: 'customFields.industry',
        Description: 'customFields.description',
        Website: 'customFields.website',
        AnnualRevenue: 'customFields.annualRevenue',
        NumberOfEmployees: 'customFields.numberOfEmployees',
    },

    /* ────────────────────────────────────────────────────────────
     * Opportunity → deal  (derived from DealMap)
     * ──────────────────────────────────────────────────────────── */
    Opportunity: toMigrateFormat(DealMap, {
        remove: [
            'CurrencyIsoCode',
        ],
        add: {
            Id: 'refId',
            AccountId: { to: 'company', ref: 'company' },
            ContactId: { to: 'contact', ref: 'contact' },
            Description: 'observations',
            OwnerId: { to: 'assignee', ref: 'User' },
        },
    }),

    /* ────────────────────────────────────────────────────────────
     * OpportunityStage → stage  (derived from StageMap)
     * ──────────────────────────────────────────────────────────── */
    OpportunityStage: toMigrateFormat(StageMap, {
        add: {
            Id: 'refId',
            IsWon: 'customFields.isWon',
            ForecastCategoryName: 'customFields.forecastCategory',
            DefaultProbability: 'customFields.defaultProbability',
        },
    }),

    /* ────────────────────────────────────────────────────────────
     * LeadStatus → stage  (lead pipeline stages)
     * ──────────────────────────────────────────────────────────── */
    LeadStatus: {
        Id: 'refId',
        MasterLabel: 'stageName',
        ApiName: 'stageCode',
        SortOrder: 'index',
        IsConverted: 'endFlowStage',
    },

    /* ────────────────────────────────────────────────────────────
     * User → user  (derived from UserMap)
     * Used to resolve assignee references and optionally sync reps.
     * In most migrations Users already exist in Prolibu; the engine
     * matches by email.  IsActive/status is transformed via UserMap.
     * ──────────────────────────────────────────────────────────── */
    User: toMigrateFormat(UserMap, {
        add: {
            Id: 'refId',
            IsActive: 'status',              // bool → 'Active'/'Deactivated' (transform in UserMap)
            Department: 'customFields.department',
            UserRoleId: 'customFields.userRoleId',
            ManagerId: 'customFields.managerId',
            Username: 'customFields.sfUsername',
        },
    }),

    /* ────────────────────────────────────────────────────────────
     * Quote → quote
     * ──────────────────────────────────────────────────────────── */
    Quote: {
        Name: 'quoteName',
        QuoteNumber: 'quoteCode',
        Status: 'customFields.status',
        ExpirationDate: 'endDate',
        OpportunityId: 'customFields.opportunityId',
        ContactId: 'customFields.contactId',
        Description: 'customFields.description',
        GrandTotal: 'customFields.grandTotal',
        Discount: 'customFields.discount',
        Tax: 'customFields.tax',
        ShippingHandling: 'customFields.shippingHandling',
    },

    /* ────────────────────────────────────────────────────────────
     * Contract → contract
     * ──────────────────────────────────────────────────────────── */
    Contract: {
        ContractNumber: 'contractCode',
        ContractTerm: 'customFields.contractTerm',
        StartDate: 'customFields.startDate',
        EndDate: 'customFields.endDate',
        Status: 'status',
        AccountId: 'customFields.accountId',
        OwnerId: 'customFields.ownerId',
        Description: 'customFields.description',
        SpecialTerms: 'customFields.specialTerms',
    },

    /* ────────────────────────────────────────────────────────────
     * Case → ticket
     * ──────────────────────────────────────────────────────────── */
    Case: {
        CaseNumber: 'ticketNumber',
        Subject: 'subject',
        Description: 'description',
        Status: 'stage',
        Priority: 'priority',
        Type: 'caseType',
        Origin: 'channel',
        ContactId: 'requester.contact',
        AccountId: 'customFields.accountId',
        OwnerId: { to: 'assignee', ref: 'User' },
        ClosedDate: 'customFields.closedDate',
        Reason: 'customFields.reason',
    },

    /* ────────────────────────────────────────────────────────────
     * Product2 → product
     * ──────────────────────────────────────────────────────────── */
    Product2: {
        Id: 'refId',
        Name: 'productName',
        ProductCode: 'productCode',
        Description: 'description',
        Family: 'productFamily',
        IsActive: 'active',
        QuantityUnitOfMeasure: 'unitName',
        DisplayUrl: 'customFields.displayUrl',
        ExternalId: 'customFields.externalId',
    },

    /* ────────────────────────────────────────────────────────────
     * Pricebook2 → pricebook
     * ──────────────────────────────────────────────────────────── */
    Pricebook2: {
        Id: 'refId',
        Name: 'pricebookName',
        Description: 'description',
        IsActive: 'active',
        IsStandard: 'isStandard',
    },

    /* ────────────────────────────────────────────────────────────
     * PricebookEntry → pricebookentry
     * ──────────────────────────────────────────────────────────── */
    PricebookEntry: {
        Id: 'refId',
        UnitPrice: 'price',
        IsActive: 'active',
        Product2Id: { to: 'product', ref: 'product' },
        Pricebook2Id: { to: 'pricebook', ref: 'pricebook' },
        UseStandardPrice: 'customFields.useStandardPrice',
    },

    /* ────────────────────────────────────────────────────────────
     * OpportunityLineItem → lineitem
     * ──────────────────────────────────────────────────────────── */
    OpportunityLineItem: {
        Quantity: 'quantity',
        UnitPrice: 'price',
        TotalPrice: 'customFields.totalPrice',
        Discount: 'discountRate',
        Description: 'description',
        Product2Id: 'product',
        PricebookEntryId: 'pricebookEntry',
        ServiceDate: 'startDate',
    },

    /* ────────────────────────────────────────────────────────────
     * Task → task
     * ──────────────────────────────────────────────────────────── */
    Task: {
        Subject: 'title',
        Description: 'description',
        Status: 'stage',
        Priority: 'priority',
        ActivityDate: 'dates.dueAt',
        OwnerId: { to: 'assignee', ref: 'User' },
        WhoId: 'customFields.contactId',
        WhatId: 'customFields.relatedToId',
        ReminderDateTime: 'customFields.reminderDateTime',
        IsReminderSet: 'customFields.isReminderSet',
    },

    /* ────────────────────────────────────────────────────────────
     * Event → meeting
     * ──────────────────────────────────────────────────────────── */
    Event: {
        Subject: 'title',
        Description: 'description',
        StartDateTime: 'dates.startAt',
        EndDateTime: 'dates.endAt',
        Location: 'attendance.address',
        OwnerId: { to: 'assignee', ref: 'User' },
        WhoId: 'customFields.contactId',
        WhatId: 'customFields.relatedToId',
        IsAllDayEvent: 'customFields.isAllDayEvent',
        ShowAs: 'customFields.showAs',
    },

    /* ────────────────────────────────────────────────────────────
     * Note → note
     * ──────────────────────────────────────────────────────────── */
    Note: {
        Title: 'customFields.title',
        Body: 'content',
        ParentId: 'origin.docId',
        IsPrivate: 'customFields.isPrivate',
    },

    /* ────────────────────────────────────────────────────────────
     * Call (SF Task with Type=Call) → call
     * ──────────────────────────────────────────────────────────── */
    Call: {
        Subject: 'summary',
        Description: 'summaryText',
        CallType: 'direction',
        OwnerId: { to: 'assignee', ref: 'User' },
        WhoId: 'contact',
        WhatId: 'origin.docId',
    },

    /* ────────────────────────────────────────────────────────────
     * Campaign → campaign
     * ──────────────────────────────────────────────────────────── */
    Campaign: {
        Name: 'campaignName',
        Description: 'customFields.description',
        Status: 'customFields.status',
        Type: 'customFields.type',
        StartDate: 'customFields.startDate',
        EndDate: 'customFields.endDate',
        BudgetedCost: 'customFields.budgetedCost',
        ActualCost: 'customFields.actualCost',
        ExpectedRevenue: 'customFields.expectedRevenue',
        IsActive: 'customFields.isActive',
    },

    /* ────────────────────────────────────────────────────────────
     * User → user
     * ──────────────────────────────────────────────────────────── */
    User: {
        FirstName: 'firstName',
        LastName: 'lastName',
        Email: 'email',
        Username: 'customFields.username',
        Title: 'jobTitle',
        Phone: 'phone',
        MobilePhone: 'mobile',
        CompanyName: 'company',
        Department: 'customFields.department',
        IsActive: 'status',
        ProfileId: 'customFields.profileId',
        UserRoleId: 'customFields.userRoleId',
        Street: 'address.street',
        City: 'address.city',
        State: 'address.state',
        PostalCode: 'address.zip',
        Country: 'address.country',
    },

    /* ────────────────────────────────────────────────────────────
     * Invoice → invoice
     * ──────────────────────────────────────────────────────────── */
    Invoice: {
        InvoiceNumber: 'invoiceNumber',
        Description: 'title',
        Status: 'stage',
        InvoiceDate: 'issueDate',
        DueDate: 'dueDate',
        TotalAmount: 'customFields.totalAmount',
        Balance: 'customFields.balance',
        AccountId: 'customFields.accountId',
        ContactId: 'contact',
        OwnerId: { to: 'assignee', ref: 'User' },
    },
};

module.exports = fieldMapping;
