/**
 * Base transformer: Salesforce Product2 → Prolibu record.
 *
 * Override this per-domain by creating:
 *   accounts/<domain>/migrations/salesforce/transformers/products.js
 */
function transformProduct(sfRecord) {
  return {
    refId: sfRecord.Id,
    name: sfRecord.Name || '',
    description: sfRecord.Description || '',
    productCode: sfRecord.ProductCode || '',
    isActive: sfRecord.IsActive !== false,
    source: 'salesforce',
  };
}

module.exports = transformProduct;
