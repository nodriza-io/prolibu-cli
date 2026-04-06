/**
 * Data mapping between Prolibu Deal and Salesforce Opportunity
 * 
 * reverse: false (default) → Prolibu Deal → Salesforce Opportunity
 * reverse: true → Salesforce Opportunity → Prolibu Deal
 */

module.exports = {
  // Basic mappings: prolibuField → salesforceField
  dealName: 'Name',
  closeDate: 'CloseDate',
  assignee: 'OwnerId',
  contact: 'ContactId',
  company: 'AccountId',
  stage: 'StageName',
  source: 'LeadSource',
  'proposal.quote.total': 'Amount',
  'proposal.quote.quoteCurrency': 'CurrencyIsoCode',
  // Additional mappings
  // 'proposal.title': 'Description',
  
  transforms: {
    // ── FORWARD TRANSFORMS (Prolibu → Salesforce) ────────────────────

    // CloseDate: Prolibu Date/ISO → Salesforce YYYY-MM-DD
    CloseDate: (value) => {
      if (!value) return null;
      const date = new Date(value);
      if (isNaN(date.getTime())) return null;
      return date.toISOString().split('T')[0];
    },

    // Amount: extract from proposal.quote if not a direct number
    Amount: (value, sourceData) => {
      if (value !== undefined && value !== null) return parseFloat(value);
      const quote = sourceData?.proposal?.quote;
      if (quote?.total) return parseFloat(quote.total);
      if (quote?.subtotal) return parseFloat(quote.subtotal);
      return null;
    },

    // ── REVERSE TRANSFORMS (Salesforce → Prolibu) ────────────────────

    // CloseDate: Salesforce "YYYY-MM-DD" → JS Date
    closeDate: (value) => {
      if (!value) return null;
      const date = new Date(value);
      if (isNaN(date.getTime())) return null;
      return date;
    },

    // stage: SF StageName string → Prolibu stageCode slug
    // The migration engine will use this slug to look up (or create) the Stage doc.
    stage: (value) => {
      if (!value) return null;
      return value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    },
  },
};