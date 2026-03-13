'use strict';

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
     * Account → company
     * ──────────────────────────────────────────────────────────── */
    Account: {
        // Identity
        Name: 'companyName',
        Website: 'website',
        AccountNumber: 'companyCode',
        // Contact info
        Phone: 'primaryPhone',
        Fax: 'phones.fax',
        // Billing address
        BillingStreet: 'address.street',
        BillingCity: 'address.city',
        BillingState: 'address.state',
        BillingPostalCode: 'address.zip',
        BillingCountry: 'address.country',
        // Shipping address (map to same address — user can adjust)
        ShippingStreet: null,
        ShippingCity: null,
        ShippingState: null,
        ShippingPostalCode: null,
        ShippingCountry: null,
        // Classification
        Industry: 'industry',
        NumberOfEmployees: 'numberOfEmployees',
        // Owner
        OwnerId: 'assignee',
        Description: 'customFields.description',
        Type: 'customFields.accountType',
        AnnualRevenue: 'customFields.annualRevenue',
        Rating: 'customFields.rating',
    },

    /* ────────────────────────────────────────────────────────────
     * Contact → contact
     * ──────────────────────────────────────────────────────────── */
    Contact: {
        FirstName: 'firstName',
        LastName: 'lastName',
        Email: 'email',
        Title: 'jobTitle',
        Phone: 'phones.work',
        MobilePhone: 'mobile',
        AccountId: 'company',
        OwnerId: 'assignee',
        // Mailing address
        MailingStreet: 'address.street',
        MailingCity: 'address.city',
        MailingState: 'address.state',
        MailingPostalCode: 'address.zip',
        MailingCountry: 'address.country',
        // Social
        LinkedIn: 'socialNetworks.linkedin',
        Twitter: 'socialNetworks.twitter',
        // Extra
        Department: 'customFields.department',
        Description: 'customFields.description',
        Birthdate: 'customFields.birthdate',
        LeadSource: 'source',
    },

    /* ────────────────────────────────────────────────────────────
     * Lead → contact  (tagged as lead)
     * ──────────────────────────────────────────────────────────── */
    Lead: {
        FirstName: 'firstName',
        LastName: 'lastName',
        Email: 'email',
        Title: 'jobTitle',
        Phone: 'phones.work',
        MobilePhone: 'mobile',
        Company: 'companyName',
        OwnerId: 'assignee',
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
     * Opportunity → deal
     * ──────────────────────────────────────────────────────────── */
    Opportunity: {
        Name: 'dealName',
        CloseDate: 'closeDate',
        StageName: 'stage',
        Amount: 'customFields.amount',
        Probability: 'customFields.probability',
        OwnerId: 'assignee',
        AccountId: 'customFields.accountId',
        ContactId: 'contact',
        Description: 'observations',
        Type: 'customFields.opportunityType',
        LeadSource: 'customFields.leadSource',
        NextStep: 'customFields.nextStep',
        ForecastCategoryName: 'customFields.forecastCategory',
        CampaignId: 'customFields.campaignId',
    },

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
        OwnerId: 'assignee',
        ClosedDate: 'customFields.closedDate',
        Reason: 'customFields.reason',
    },

    /* ────────────────────────────────────────────────────────────
     * Product2 → product
     * ──────────────────────────────────────────────────────────── */
    Product2: {
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
        Name: 'pricebookName',
        Description: 'description',
        IsActive: 'active',
        IsStandard: 'isStandard',
    },

    /* ────────────────────────────────────────────────────────────
     * PricebookEntry → pricebookentry
     * ──────────────────────────────────────────────────────────── */
    PricebookEntry: {
        UnitPrice: 'price',
        IsActive: 'active',
        Product2Id: 'product',
        Pricebook2Id: 'pricebook',
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
        OwnerId: 'assignee',
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
        OwnerId: 'assignee',
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
        OwnerId: 'assignee',
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
        OwnerId: 'assignee',
    },
};

module.exports = fieldMapping;
