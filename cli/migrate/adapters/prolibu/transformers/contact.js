'use strict';

const { createTransformer } = require('./base');

module.exports = createTransformer({
  refs: {
    company:  'company',
    assignee: 'user',
  },
});
