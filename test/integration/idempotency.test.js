'use strict';

const { createEscrowClient } = require('../helpers/escrow-client');
const { generateKeypair } = require('../helpers/keys');

const client = createEscrowClient(process.env.SERVICE_BASE_URL || 'https://standalone-escrow.onrender.com');

describe('Idempotency (Section H)', () => {
  const created = [];

  afterAll(async () => {
    for (const { escrowId, creator } of created) {
      try { await client.cancel(creator, escrowId); } catch {}
    }
  });

  it('same idempotency_key from same creator returns same escrow_id', async () => {
    const creator = generateKeypair();
    const idemKey = `test-idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const { data: first } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'idempotent 1',
      idempotency_key: idemKey,
    });
    expect(first.escrow_id).toBeTruthy();
    created.push({ escrowId: first.escrow_id, creator });

    const { status, data: second } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'idempotent 2',
      idempotency_key: idemKey,
    });
    expect(status).toBe(200);
    expect(second.escrow_id).toBe(first.escrow_id);
  });

  it('different creator with same idempotency_key creates a new escrow', async () => {
    const creator1 = generateKeypair();
    const creator2 = generateKeypair();
    const idemKey = `test-idem-diff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const { data: first } = await client.create(creator1, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'diff creator 1',
      idempotency_key: idemKey,
    });
    created.push({ escrowId: first.escrow_id, creator: creator1 });

    const { data: second } = await client.create(creator2, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'diff creator 2',
      idempotency_key: idemKey,
    });

    expect(second.escrow_id).not.toBe(first.escrow_id);
    created.push({ escrowId: second.escrow_id, creator: creator2 });
  });
});
