'use strict';

const { describe, it, expect } = require('vitest');
const { createEscrowClient } = require('../helpers/escrow-client');
const { generateKeypair } = require('../helpers/keys');

const client = createEscrowClient(process.env.SERVICE_BASE_URL || 'https://standalone-escrow.onrender.com');

describe('Open Enrollment (Section C)', () => {
  const created = [];

  afterAll(async () => {
    for (const { escrowId, creator } of created) {
      try { await client.cancel(creator, escrowId); } catch {}
    }
  });

  it('creator creates two_party without knowing participant pubkeys', async () => {
    const creator = generateKeypair();
    const { status, data } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'two_party',
      description: 'open enrollment',
    });
    expect(status).toBe(201);
    expect(data.escrow_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.state).toBe('created');
    expect(data.creator_pubkey).toBe(creator.pubkey);
    expect(data.funding_model).toBe('two_party');
    expect(data.enrollments).toBeInstanceOf(Array);
    expect(data.enrollments.length).toBe(1);
    expect(typeof data.enrollments[0].enrollment_token).toBe('string');
    expect(data.enrollments[0].enrollment_token.length).toBeGreaterThan(0);
    created.push({ escrowId: data.escrow_id, creator });
  });

  it('joiner redeems enrollment token and gets bound by NIP-98 identity', async () => {
    const creator = generateKeypair();
    const joiner = generateKeypair();

    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'two_party',
      description: 'join bind test',
    });
    created.push({ escrowId: escrow.escrow_id, creator });

    const token = escrow.enrollments[0].enrollment_token;
    const { status: joinStatus, data: joinData } = await client.create(joiner, {
      enrollment_token: token,
    });

    expect(joinStatus).toBe(200);
    expect(joinData.escrow_id).toBe(escrow.escrow_id);
    expect(joinData.counterparty_pubkey).toBe(joiner.pubkey);
    expect(joinData.state).toMatch(/^(created|partially_funded|active)$/);
  });

  it('reusing the same enrollment token is rejected (single-use enforcement)', async () => {
    const creator = generateKeypair();
    const joiner1 = generateKeypair();
    const joiner2 = generateKeypair();

    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'two_party',
      description: 'single-use test',
    });
    created.push({ escrowId: escrow.escrow_id, creator });

    const token = escrow.enrollments[0].enrollment_token;

    const { status: s1 } = await client.create(joiner1, { enrollment_token: token });
    expect(s1).toBe(200);

    const { status: s2, data: d2 } = await client.create(joiner2, { enrollment_token: token });
    expect(s2).toBeGreaterThanOrEqual(400);
    expect(d2.error).toBeTruthy();
  });

  it('fake enrollment token is rejected', async () => {
    const fakeJoiner = generateKeypair();
    const { status, data } = await client.create(fakeJoiner, {
      enrollment_token: 'fake-non-existent-token',
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(data.error).toBeTruthy();
  });

  it('single_funder creates zero enrollment tokens', async () => {
    const creator = generateKeypair();
    const { status, data } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'no tokens',
    });
    expect(status).toBe(201);
    expect(data.enrollments.length).toBe(0);
    created.push({ escrowId: data.escrow_id, creator });
  });

  it('m_of_n creates participant_count - 1 enrollment tokens', async () => {
    const creator = generateKeypair();
    const { status, data } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'm_of_n',
      funding_threshold: 3,
      participant_count: 5,
      description: 'm-of-n tokens',
    });
    expect(status).toBe(201);
    expect(data.enrollments.length).toBe(4);
    created.push({ escrowId: data.escrow_id, creator });
  });

  it('m_of_n rejects if funding_threshold > participant_count', async () => {
    const creator = generateKeypair();
    const { status, data } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'm_of_n',
      funding_threshold: 5,
      participant_count: 3,
      description: 'invalid m-of-n',
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(data.error).toBeTruthy();
  });

  it('two_party rejects funding_threshold and participant_count', async () => {
    const creator = generateKeypair();
    const { status, data } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'two_party',
      funding_threshold: 2,
      participant_count: 2,
      description: 'reject extraneous fields',
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(data.error).toBeTruthy();
  });
});
