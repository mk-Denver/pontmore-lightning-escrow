'use strict';

/**
 * services/blink.js
 *
 * Backend selector. Exports the real Blink GraphQL client when BLINK_MODE=real
 * (default), or the in-memory mock when BLINK_MODE=mock. Both modules expose
 * the same surface so callers (escrow.js, server.js, cron jobs) are mode-agnostic.
 */

const { config } = require('../config/env');

module.exports = config.BLINK_MODE === 'mock'
  ? require('./blink-mock')
  : require('./blink-real');
