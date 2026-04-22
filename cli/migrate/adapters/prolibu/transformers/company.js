'use strict';

const { createTransformer } = require('./base');

module.exports = createTransformer({
  refs: {
    assignee: 'user',
  },
});
