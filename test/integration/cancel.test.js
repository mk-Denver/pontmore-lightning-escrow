'use strict';

const { createEscrowClient } = require('../helpers/escrow-client');
const { generateKeypair } = require('../helpers/keys');

const client = createEscrowClient(process.env.SERVICE_BASE_URL || 'https://standalone-escrow.onrender.com');

describe('Cancel (Sections F-G)', () => {
  it('created escrow can be canceled by its creator', async () => {
    const creator = generateKeypair();
    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'cancel test',
    });

    const { status, data } = await client.cancel(creator, escrow.escrow_id);
    expect(status).toBe(200);
    expect(data.state).toBe('canceled');
  });

  it('non-creator cannot cancel', async () => {
    const creator = generateKeypair();
    const attacker = generateKeypair();
    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'auth cancel',
    });

    const { status } = await client.cancel(attacker, escrow.escrow_id);
    expect(status).toBeGreaterThanOrEqual(400);

    await client.cancel(creator, escrow.escrow_id);
  });

  it('canceled escrow cannot be canceled again', async () => {
    const creator = generateKeypair();
    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'double cancel',
    });

    await client.cancel(creator, escrow.escrow_id);

    const { status, data } = await client.cancel(creator, escrow.escrow_id);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(data.error).toBeTruthy();
  });
});
