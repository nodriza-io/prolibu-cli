'use strict';

/**
 * System fields that must never be sent to the destination.
 * The destination generates its own _id, timestamps, and version.
 */
const SYSTEM_FIELDS = ['_id', '__v', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'];

/**
 * Create a base transformer for Prolibu → Prolibu migration.
 *
 * - Strips system fields
 * - Sets refId = source _id (for upsert tracking)
 * - Resolves relationship fields via idMap
 * - Strips computed fields if specified
 *
 * @param {object}   [options]
 * @param {object}   [options.refs]           - Map of fieldName → refModel for relationship fields
 * @param {string[]} [options.stripFields]    - Additional fields to strip from the record
 * @param {Function} [options.postTransform]  - Extra transform fn(record, source, context) after base processing
 * @returns {Function} Transformer function (sourceRecord, context) → transformedRecord
 */
function createTransformer({ refs = {}, stripFields = [], postTransform } = {}) {
  return function transform(sourceRecord, context = {}) {
    if (!sourceRecord || typeof sourceRecord !== 'object') return null;

    const record = {};

    for (const [key, value] of Object.entries(sourceRecord)) {
      // Skip system fields
      if (SYSTEM_FIELDS.includes(key)) continue;
      // Skip extra strip fields
      if (stripFields.includes(key)) continue;

      // Resolve relationship fields via idMap
      if (refs[key] && value) {
        const refModel = refs[key];
        const idMap = context?.idMap?.[refModel] || {};
        // Value can be a string _id or a populated object with _id
        const sourceId = typeof value === 'object' && value._id ? value._id : value;
        const resolved = idMap[String(sourceId)] ?? null;
        record[key] = resolved;
        continue;
      }

      record[key] = value;
    }

    // Set refId = source _id for upsert tracking
    if (sourceRecord._id) {
      record.refId = String(sourceRecord._id);
    }

    // Apply optional post-transform hook
    if (typeof postTransform === 'function') {
      return postTransform(record, sourceRecord, context);
    }

    return record;
  };
}

module.exports = { createTransformer, SYSTEM_FIELDS };
