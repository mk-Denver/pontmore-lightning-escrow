'use strict';

const { describe, it, expect } = require('vitest');
const { createEscrowClient } = require('../helpers/escrow-client');

const client = createEscrowClient(process.env.SERVICE_BASE_URL || 'https://standalone-escrow.onrender.com');

describe('Health endpoint', () => {
  it('returns ok with backend_configured and correct interface', async () => {
    const { status, data } = await client.health();
    expect(status).toBe(200);
    expect(data.status).toBe('ok');
    expect(data.interface).toBe('pontmore_escrow_http_v1');
    expect(typeof data.backend_configured).toBe('boolean');
    if (data.backend_configured === false) {
      expect(data.message).toBeTruthy();
    }
  });
});
