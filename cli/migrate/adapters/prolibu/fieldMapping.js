'use strict';

/**
 * Prolibu → Prolibu field mappings.
 *
 * Since source and target are both Prolibu, mappings are 1:1.
 * The key difference is relationship fields — source _ids don't exist
 * in the destination, so they must be resolved via IdMapStore.
 *
 * Relationship fields use the { to, ref } syntax:
 *   { to: 'fieldName', ref: 'ModelName' }
 *
 * System fields (_id, __v, createdAt, updatedAt, createdBy, updatedBy)
 * are excluded — they're managed by the destination.
 */

const SYSTEM_FIELDS = ['_id', '__v', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'];

/**
 * Build a 1:1 passthrough mapping for a list of field names.
 * Ref fields are marked with { to, ref } syntax.
 *
 * @param {string[]} fields     - Field names to include
 * @param {object}   [refs={}]  - Map of fieldName → refModel for relationship fields
 * @returns {object} Mapping object: { fieldName: 'fieldName' | { to, ref } }
 */
function passthrough(fields, refs = {}) {
  const mapping = {};
  for (const f of fields) {
    if (SYSTEM_FIELDS.includes(f)) continue;
    if (refs[f]) {
      mapping[f] = { to: refs[f].to || f, ref: refs[f].ref };
    } else {
      mapping[f] = f;
    }
  }
  return mapping;
}

const fieldMapping = {

  /* ────────────────────────────────────────────────────────────
   * stage → stage
   * ──────────────────────────────────────────────────────────── */
  stage: passthrough([
    '_id', 'stageName', 'stageCode', 'color', 'order', 'type', 'active',
  ]),

  /* ────────────────────────────────────────────────────────────
   * company → company
   * ──────────────────────────────────────────────────────────── */
  company: passthrough([
    '_id', 'companyName', 'companyCode', 'email', 'website',
    'phones', 'address', 'industry', 'numberOfEmployees',
    'taxId', 'description', 'active', 'customFields',
    'assignee',
  ], {
    assignee: { ref: 'user' },
  }),

  /* ────────────────────────────────────────────────────────────
   * contact → contact
   * ──────────────────────────────────────────────────────────── */
  contact: passthrough([
    '_id', 'firstName', 'lastName', 'email', 'phones', 'address',
    'title', 'company', 'active', 'customFields',
    'assignee',
  ], {
    company:  { ref: 'company' },
    assignee: { ref: 'user' },
  }),

  /* ────────────────────────────────────────────────────────────
   * product → product
   * ──────────────────────────────────────────────────────────── */
  product: passthrough([
    '_id', 'productName', 'productCode', 'description', 'price',
    'cost', 'currency', 'active', 'productFamily',
    'customFields',
  ]),

  /* ────────────────────────────────────────────────────────────
   * pricebook → pricebook
   * ──────────────────────────────────────────────────────────── */
  pricebook: passthrough([
    '_id', 'pricebookName', 'pricebookCode', 'currency', 'active',
    'description', 'customFields',
  ]),

  /* ────────────────────────────────────────────────────────────
   * pricebookentry → pricebookentry
   * ──────────────────────────────────────────────────────────── */
  pricebookentry: passthrough([
    '_id', 'pricebookEntryCode', 'price', 'currency', 'active',
    'product', 'pricebook',
  ], {
    product:   { ref: 'product' },
    pricebook: { ref: 'pricebook' },
  }),

  /* ────────────────────────────────────────────────────────────
   * deal → deal
   * ──────────────────────────────────────────────────────────── */
  deal: passthrough([
    '_id', 'dealName', 'dealCode', 'company', 'contact', 'stage',
    'assignee', 'amount', 'closeDate', 'probability',
    'customFields',
  ], {
    company:  { ref: 'company' },
    contact:  { ref: 'contact' },
    stage:    { ref: 'stage' },
    assignee: { ref: 'user' },
  }),
};

module.exports = fieldMapping;
