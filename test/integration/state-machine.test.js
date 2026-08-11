'use strict';

const { describe, it, expect } = require('vitest');
const { createEscrowClient } = require('../helpers/escrow-client');
const { generateKeypair } = require('../helpers/keys');

const client = createEscrowClient(process.env.SERVICE_BASE_URL || 'https://standalone-escrow.onrender.com');

describe('State Machine Correctness (Section I)', () => {
  it('created escrow initial state', async () => {
    const creator = generateKeypair();
    const { status, data } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'state check',
    });
    expect(status).toBe(201);
    expect(data.state).toBe('created');

    await client.cancel(creator, data.escrow_id);
  });

  it('canceled escrow is forbidden from further transitions', async () => {
    const creator = generateKeypair();
    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'terminal state',
    });

    await client.cancel(creator, escrow.escrow_id);

    const { status, data } = await client.cancel(creator, escrow.escrow_id);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(data.error).toBeTruthy();
  });

  it('fund_status reflects the escrow state', async () => {
    const creator = generateKeypair();
    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'state in fundstatus',
    });

    const { data: fs } = await client.fundStatus(creator, escrow.escrow_id);
    expect(fs.state).toBe('created');

    await client.cancel(creator, escrow.escrow_id);

    const { data: fs2 } = await client.fundStatus(creator, escrow.escrow_id);
    expect(fs2.state).toBe('canceled');
  });
});
