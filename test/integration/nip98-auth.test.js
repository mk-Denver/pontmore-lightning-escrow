'use strict';

const { describe, it, expect } = require('vitest');
const { createEscrowClient } = require('../helpers/escrow-client');
const { generateKeypair } = require('../helpers/keys');

const BASE_URL = process.env.SERVICE_BASE_URL || 'https://standalone-escrow.onrender.com';
const client = createEscrowClient(BASE_URL);
const prefix = '/pontmore/v1';

describe('NIP-98 Auth Verification (Section B)', () => {
  it('returns 401 without Authorization header', async () => {
    const res = await fetch(`${BASE_URL}${prefix}/fund_status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ escrow_id: '00000000-0000-0000-0000-000000000000' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with malformed Authorization scheme', async () => {
    const res = await fetch(`${BASE_URL}${prefix}/fund_status`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer n0ns3ns3',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ escrow_id: '00000000-0000-0000-0000-000000000000' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with invalid base64 in Nostr header', async () => {
    const res = await fetch(`${BASE_URL}${prefix}/fund_status`, {
      method: 'POST',
      headers: {
        Authorization: 'Nostr !!!n0t-valid-base64!!!',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ escrow_id: '00000000-0000-0000-0000-000000000000' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for event with corrupted id', async () => {
    const kp = generateKeypair();
    const { data: created } = await client.create(kp, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'tamper test',
    });

    const url = `${BASE_URL}${prefix}/cancel`;
    const body = JSON.stringify({ escrow_id: created.escrow_id });
    const { authHeader } = require('../helpers/auth').buildSignedAuthEvent({
      method: 'POST', url, body, ...kp,
    });

    const [, b64] = authHeader.split(' ');
    const event = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    event.id = '00'.repeat(32);
    const tamperedAuth = 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64');

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: tamperedAuth, 'Content-Type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);

    await client.cancel(kp, created.escrow_id);
  });

  it('valid NIP-98 auth succeeds with a fresh keypair', async () => {
    const kp = generateKeypair();
    const { status, data } = await client.create(kp, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'valid auth test',
    });
    expect(status).toBe(201);
    expect(data.escrow_id).toBeTruthy();
    await client.cancel(kp, data.escrow_id);
  });
});
