'use strict';

const { createEscrowClient } = require('../helpers/escrow-client');
const { generateKeypair } = require('../helpers/keys');

const client = createEscrowClient(process.env.SERVICE_BASE_URL || 'https://standalone-escrow.onrender.com');

describe('OpenAPI Schema Compliance', () => {
  const created = [];

  afterAll(async () => {
    for (const { escrowId, creator } of created) {
      try { await client.cancel(creator, escrowId); } catch {}
    }
  });

  it('CreateResponse has all required fields', async () => {
    const kp = generateKeypair();
    const { status, data } = await client.create(kp, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'openapi create response',
    });
    expect(status).toBe(200);
    for (const field of [
      'escrow_id', 'state', 'creator_pubkey',
      'amount_sats', 'funding_model', 'enrollments', 'funding_deadline',
    ]) {
      expect(data).toHaveProperty(field);
    }
    expect(data.enrollments).toBeInstanceOf(Array);
    expect(data.funding_deadline).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    created.push({ escrowId: data.escrow_id, creator: kp });
  });

  it('funding_model is required on create (not optional)', async () => {
    const kp = generateKeypair();
    const { status, data } = await client.create(kp, {
      amount_sats: 100,
      description: 'no model',
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(data.error).toMatch(/funding_model/);
  });

  it('m_of_n requires funding_threshold and participant_count', async () => {
    const kp = generateKeypair();
    const { status, data } = await client.create(kp, {
      amount_sats: 100,
      funding_model: 'm_of_n',
      description: 'bad m-of-n',
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(data.error).toMatch(/funding_threshold|participant_count/);
  });

  it('two_party rejects funding_threshold and participant_count fields', async () => {
    const kp = generateKeypair();
    const { status, data } = await client.create(kp, {
      amount_sats: 100,
      funding_model: 'two_party',
      funding_threshold: 2,
      participant_count: 2,
      description: 'extraneous fields',
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(data.error).toMatch(/funding_threshold|participant_count/);
  });

  it('FundStatusResponse has at least the documented fields', async () => {
    const kp = generateKeypair();
    const { data: escrow } = await client.create(kp, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'fundstatus openapi',
    });
    created.push({ escrowId: escrow.escrow_id, creator: kp });

    await client.fundingInstructions(kp, escrow.escrow_id);

    const { status, data } = await client.fundStatus(kp, escrow.escrow_id);
    expect(status).toBe(200);
    for (const field of ['escrow_id', 'state', 'funded', 'funding_model']) {
      expect(data).toHaveProperty(field);
    }
    expect(typeof data.funded).toBe('boolean');
  });

  it('JoinResponse has all required fields', async () => {
    const creator = generateKeypair();
    const joiner = generateKeypair();

    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'two_party',
      description: 'join openapi',
    });
    created.push({ escrowId: escrow.escrow_id, creator });

    const token = escrow.enrollments[0].enrollment_token;
    const { status, data } = await client.create(joiner, { enrollment_token: token });

    expect(status).toBe(200);
    expect(data.escrow_id).toBe(escrow.escrow_id);
    expect(data.creator_pubkey).toBeTruthy();
    expect(data.counterparty_pubkey).toBeTruthy();
    expect(data.amount_sats).toBeGreaterThan(0);
    expect(data.funding_model).toBe('two_party');
  });
});
