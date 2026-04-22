'use strict';

const { createTransformer } = require('./base');

module.exports = createTransformer({
  refs: {
    product:   'product',
    pricebook: 'pricebook',
  },
});
