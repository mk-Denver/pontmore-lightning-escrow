'use strict';

const { describe, it, expect } = require('vitest');
const { createEscrowClient } = require('../helpers/escrow-client');
const { generateKeypair, bytesToHex } = require('../helpers/keys');
const { schnorr } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha2');

const client = createEscrowClient(process.env.SERVICE_BASE_URL || 'https://standalone-escrow.onrender.com');

function signCanonical({ escrowId, action, recipient, resultHash, nonce, timestamp, privkey }) {
  const message = `pontmore-escrow:v1:${escrowId}:${action}:${recipient}:${resultHash}:${nonce}:${timestamp}`;
  const msgHash = sha256(message);
  const pubkey = bytesToHex(schnorr.getPublicKey(privkey));
  const signature = bytesToHex(schnorr.sign(msgHash, privkey));
  return { pubkey, signature };
}

describe('Release Decisions (Section E)', () => {
  const created = [];

  afterAll(async () => {
    for (const { escrowId, creator } of created) {
      try { await client.cancel(creator, escrowId); } catch {}
    }
  });

  it('empty signatures array is rejected', async () => {
    const creator = generateKeypair();
    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'empty sigs',
    });
    created.push({ escrowId: escrow.escrow_id, creator });

    const { status, data } = await client.release(creator, {
      escrow_id: escrow.escrow_id,
      release_decision: 'operator_decision',
      recipient: 'counterparty',
      nonce: 'empty-sigs-nonce',
      timestamp: Math.floor(Date.now() / 1000),
      signatures: [],
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(data.error).toBeTruthy();
  });

  it('missing release_decision field is rejected', async () => {
    const creator = generateKeypair();
    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'no decision type',
    });
    created.push({ escrowId: escrow.escrow_id, creator });

    const { status, data } = await client.release(creator, {
      escrow_id: escrow.escrow_id,
      recipient: 'counterparty',
      nonce: 'no-type-nonce',
      timestamp: Math.floor(Date.now() / 1000),
      signatures: [],
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(data.error).toMatch(/release_decision/);
  });

  it('stale timestamp is rejected', async () => {
    const creator = generateKeypair();
    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'stale timestamp',
    });
    created.push({ escrowId: escrow.escrow_id, creator });

    const oldTimestamp = Math.floor(Date.now() / 1000) - 86400;
    const { status, data } = await client.release(creator, {
      escrow_id: escrow.escrow_id,
      release_decision: 'operator_decision',
      recipient: 'counterparty',
      nonce: 'stale-nonce',
      timestamp: oldTimestamp,
      signatures: [{ pubkey: creator.pubkey, signature: '00'.repeat(64) }],
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(data.error).toMatch(/timestamp/);
  });

  it('application_signed_result with empty/null result is rejected', async () => {
    const appSigner = generateKeypair();
    const creator = generateKeypair();

    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'app sig empty result',
    });
    created.push({ escrowId: escrow.escrow_id, creator });

    const nonce = 'empty-result-nonce';
    const timestamp = Math.floor(Date.now() / 1000);
    const { pubkey, signature } = signCanonical({
      escrowId: escrow.escrow_id,
      action: 'release',
      recipient: 'counterparty',
      resultHash: 'none',
      nonce,
      timestamp,
      privkey: appSigner.privkey,
    });

    const { status, data } = await client.release(creator, {
      escrow_id: escrow.escrow_id,
      release_decision: 'application_signed_result',
      recipient: 'counterparty',
      nonce,
      timestamp,
      signatures: [{ pubkey, signature }],
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(data.error).toMatch(/result/);
  });

  it('refund requires recipient "creator"', async () => {
    const appSigner = generateKeypair();
    const creator = generateKeypair();
    const nonce = 'refund-creator-nonce';
    const timestamp = Math.floor(Date.now() / 1000);
    const resultHash = 'none';

    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'refund creator check',
    });
    created.push({ escrowId: escrow.escrow_id, creator });

    const { pubkey, signature } = signCanonical({
      escrowId: escrow.escrow_id,
      action: 'refund',
      recipient: 'counterparty',
      resultHash,
      nonce,
      timestamp,
      privkey: appSigner.privkey,
    });

    const { status, data } = await client.refund(creator, {
      escrow_id: escrow.escrow_id,
      release_decision: 'application_signed_result',
      recipient: 'counterparty',
      nonce,
      timestamp,
      result: { reason: 'test' },
      signatures: [{ pubkey, signature }],
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(data.error).toMatch(/recipient/);
  });

  it('invalid operator_decision signature is rejected', async () => {
    const creator = generateKeypair();
    const fakeSigner = generateKeypair();

    const { data: escrow } = await client.create(creator, {
      amount_sats: 100,
      funding_model: 'single_funder',
      description: 'bad operator sig',
    });
    created.push({ escrowId: escrow.escrow_id, creator });

    const nonce = 'bad-op-nonce';
    const timestamp = Math.floor(Date.now() / 1000);
    const { pubkey, signature } = signCanonical({
      escrowId: escrow.escrow_id,
      action: 'release',
      recipient: 'counterparty',
      resultHash: 'none',
      nonce,
      timestamp,
      privkey: fakeSigner.privkey,
    });

    const { status, data } = await client.release(creator, {
      escrow_id: escrow.escrow_id,
      release_decision: 'operator_decision',
      recipient: 'counterparty',
      nonce,
      timestamp,
      signatures: [{ pubkey, signature }],
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(data.error).toBeTruthy();
  });
});
