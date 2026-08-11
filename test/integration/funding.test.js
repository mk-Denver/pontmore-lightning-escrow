'use strict';

const { describe, it, expect } = require('vitest');
const { createEscrowClient } = require('../helpers/escrow-client');
const { generateKeypair } = require('../helpers/keys');

const client = createEscrowClient(process.env.SERVICE_BASE_URL || 'https://standalone-escrow.onrender.com');

describe('Funding (Section D)', () => {
  const created = [];

  afterAll(async () => {
    for (const { escrowId, creator } of created) {
      try { await client.cancel(creator, escrowId); } catch {}
    }
  });

  it('fund_status returns correct shape for newly created escrow', async () => {
    const creator = generateKeypair();
    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'two_party',
      description: 'fundstatus shape',
    });
    created.push({ escrowId: escrow.escrow_id, creator });

    const { status, data } = await client.fundStatus(creator, escrow.escrow_id);
    expect(status).toBe(200);
    expect(data.escrow_id).toBe(escrow.escrow_id);
    expect(data.state).toBe('created');
    expect(data.total_funders).toBeGreaterThanOrEqual(0);
    expect(data.funded_count).toBe(0);
    expect(data).toHaveProperty('counterparty_pubkey');
    expect(data).toHaveProperty('funding_model');
  });

  it('funding_instructions returns a BOLT11 invoice for single_funder', async () => {
    const creator = generateKeypair();
    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'bolt11 invoice',
    });
    created.push({ escrowId: escrow.escrow_id, creator });

    const { status, data } = await client.fundingInstructions(creator, escrow.escrow_id);
    expect(status).toBe(200);
    expect(data.escrow_id).toBe(escrow.escrow_id);
    expect(data.payment_request).toMatch(/^ln/);
    expect(data.payment_hash).toBeTruthy();
    expect(data.amount_sats).toBeGreaterThan(100);
    expect(data.funding_model).toBe('single_funder');
  });

  it('funding_instructions returns per-funder invoices for two_party after join', async () => {
    const creator = generateKeypair();
    const joiner = generateKeypair();

    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'two_party',
      description: 'per-funder invoices',
    });
    created.push({ escrowId: escrow.escrow_id, creator });

    await client.create(joiner, { enrollment_token: escrow.enrollments[0].enrollment_token });

    const { data: creatorInv } = await client.fundingInstructions(creator, escrow.escrow_id);
    expect(creatorInv.funder_pubkey).toBe(creator.pubkey);

    const { data: joinerInv } = await client.fundingInstructions(joiner, escrow.escrow_id);
    expect(joinerInv.funder_pubkey).toBe(joiner.pubkey);
  });

  it('non-participant cannot get funding instructions', async () => {
    const creator = generateKeypair();
    const stranger = generateKeypair();

    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'two_party',
      description: 'stranger check',
    });
    created.push({ escrowId: escrow.escrow_id, creator });

    const { status } = await client.fundingInstructions(stranger, escrow.escrow_id);
    expect(status).toBeGreaterThanOrEqual(400);
  });
});
