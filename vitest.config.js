'use strict';

const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
    hookTimeout: 15000,
    env: {
      SERVICE_BASE_URL: process.env.SERVICE_BASE_URL || 'https://standalone-escrow.onrender.com',
    },
  },
});
