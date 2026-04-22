'use strict';

const { createTransformer, SYSTEM_FIELDS } = require('./base');

/**
 * Deal transformer for Prolibu → Prolibu.
 *
 * Deals are the most complex entity because they contain nested
 * proposal.quote.lineItems where each line item references products
 * and other entities by _id that need to be resolved.
 *
 * Relationship fields resolved:
 *   - deal.company   → idMap['company']
 *   - deal.contact   → idMap['contact']
 *   - deal.stage     → idMap['stage']
 *   - deal.assignee  → idMap['user']
 *   - lineItem.product         → idMap['product']
 *   - lineItem.pricebook       → idMap['pricebook']
 *   - lineItem.pricebookEntry  → idMap['pricebookentry']
 *
 * Computed fields stripped (recalculated by Prolibu):
 *   proposal.quote: subTotal, discountAmount, netTotal, taxAmount, total, convertedTotal
 *   lineItem: subTotal, total, netUnitPrice, specialPrice
 */

const DEAL_COMPUTED_FIELDS = [
  'proposal',  // handled manually below
];

const QUOTE_COMPUTED_FIELDS = [
  'subTotal', 'discountAmount', 'netTotal', 'taxAmount', 'total', 'convertedTotal',
];

const LINE_ITEM_COMPUTED_FIELDS = [
  'subTotal', 'total', 'netUnitPrice', 'specialPrice', 'exchangeRate',
  'lineId', 'id', 'uuid', 'index', 'parent',
];

const baseTransform = createTransformer({
  refs: {
    company:  'company',
    contact:  'contact',
    stage:    'stage',
    assignee: 'user',
  },
  stripFields: ['proposal'],
});

function transformDeal(sourceRecord, context = {}) {
  const record = baseTransform(sourceRecord, context);
  if (!record) return null;

  // Process proposal if present
  const proposal = sourceRecord.proposal;
  if (!proposal) return record;

  const resultProposal = {};

  // Copy top-level proposal fields (skip template — layout IDs won't exist in dest)
  if (proposal.enabled != null) resultProposal.enabled = proposal.enabled;
  if (proposal.title) resultProposal.title = proposal.title;
  if (proposal.expirationDate) resultProposal.expirationDate = proposal.expirationDate;

  // Process quote
  const quote = proposal.quote;
  if (quote) {
    const resultQuote = {};

    // Copy non-computed quote fields
    for (const [key, value] of Object.entries(quote)) {
      if (QUOTE_COMPUTED_FIELDS.includes(key)) continue;
      if (key === 'lineItems') continue; // handled below
      resultQuote[key] = value;
    }

    // Process lineItems
    if (Array.isArray(quote.lineItems)) {
      const idMap = context?.idMap || {};

      resultQuote.lineItems = quote.lineItems.map((item) => {
        const resultItem = {};

        for (const [key, value] of Object.entries(item)) {
          if (LINE_ITEM_COMPUTED_FIELDS.includes(key)) continue;
          if (SYSTEM_FIELDS.includes(key)) continue;

          // Resolve product ref
          if (key === 'product' && value) {
            const sourceId = typeof value === 'object' && value._id ? value._id : value;
            resultItem.product = idMap['product']?.[String(sourceId)] ?? null;
            continue;
          }

          // Resolve pricebook ref
          if (key === 'pricebook' && value) {
            const sourceId = typeof value === 'object' && value._id ? value._id : value;
            resultItem.pricebook = idMap['pricebook']?.[String(sourceId)] ?? null;
            continue;
          }

          // Resolve pricebookEntry ref
          if (key === 'pricebookEntry' && value) {
            const sourceId = typeof value === 'object' && value._id ? value._id : value;
            resultItem.pricebookEntry = idMap['pricebookentry']?.[String(sourceId)] ?? null;
            continue;
          }

          // Resolve productFamily ref
          if (key === 'productFamily' && value) {
            const sourceId = typeof value === 'object' && value._id ? value._id : value;
            resultItem.productFamily = idMap['productfamily']?.[String(sourceId)] ?? null;
            continue;
          }

          resultItem[key] = value;
        }

        return resultItem;
      });
    }

    resultProposal.quote = resultQuote;
  }

  record.proposal = resultProposal;
  return record;
}

module.exports = transformDeal;
