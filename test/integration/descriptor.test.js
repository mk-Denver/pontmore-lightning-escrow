'use strict';

const { describe, it, expect } = require('vitest');
const { createEscrowClient } = require('../helpers/escrow-client');

const BASE_URL = process.env.SERVICE_BASE_URL || 'https://standalone-escrow.onrender.com';
const client = createEscrowClient(BASE_URL);

describe('Descriptor and Discovery (Section A)', () => {
  let descriptor;

  beforeAll(async () => {
    const res = await client.getDescriptor();
    expect(res.status).toBe(200);
    descriptor = res.data;
  });

  it('returns version 1 and correct escrow_type', () => {
    expect(descriptor.version).toBe(1);
    expect(descriptor.escrow_type).toBe('custodial_escrow');
  });

  it('has correct transport, interface, and auth', () => {
    expect(descriptor.service.transport).toContain('https');
    expect(descriptor.service.interface).toBe('pontmore_escrow_http_v1');
    expect(descriptor.service.auth).toContain('nostr_http_auth');
  });

  it('endpoint is a live URL matching SERVICE_BASE_URL', () => {
    expect(descriptor.service.endpoint).toMatch(/^https:\/\/.+\.onrender\.com\/pontmore\/v1$/);
  });

  it('schema_url resolves to valid OpenAPI JSON', async () => {
    expect(descriptor.service.schema_url).toMatch(/\/pontmore\/v1\/openapi\/v1\.0\.0\.json$/);
    const schemaRes = await client.getOpenApi();
    expect(schemaRes.status).toBe(200);
    expect(schemaRes.data.openapi).toBe('3.1.0');
    expect(schemaRes.data.info.title).toContain('Pontmore');
  });

  it('advertises all six canonical PIP-01 operations', () => {
    const ops = descriptor.service.operations;
    expect(ops).toContain('create');
    expect(ops).toContain('funding_instructions');
    expect(ops).toContain('fund_status');
    expect(ops).toContain('release');
    expect(ops).toContain('refund');
    expect(ops).toContain('cancel');
  });

  it('funding_model is a non-empty valid enumeration', () => {
    const models = descriptor.service.funding_model;
    expect(models.length).toBeGreaterThanOrEqual(1);
    models.forEach(m => {
      expect(['single_funder', 'two_party', 'm_of_n']).toContain(m);
    });
  });

  it('release_decisions is a non-empty subset of known types', () => {
    const known = [
      'mutual_consent',
      'operator_decision',
      'oracle_signature',
      'application_signed_result',
      'threshold_participant_signatures',
    ];
    descriptor.service.release_decisions.forEach(r => {
      expect(known).toContain(r);
    });
  });

  it('decision_signers block has correct structure', () => {
    const ds = descriptor.service.decision_signers;
    expect(ds).toHaveProperty('operator_pubkey');
    expect(ds).toHaveProperty('application_pubkeys');
    expect(ds).toHaveProperty('oracle_pubkeys');
    expect(ds.application_pubkeys).toBeNull();
    if (ds.operator_pubkey !== null) {
      expect(ds.operator_pubkey).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('Cache-Control header is no-store', async () => {
    const res = await fetch(`${BASE_URL}/pontmore/v1/descriptor`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('updated_at is a recent Unix timestamp', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(descriptor.updated_at).toBeGreaterThan(now - 86400);
    expect(descriptor.updated_at).toBeLessThanOrEqual(now + 10);
  });

  it('funding_rules.funding_timeout is set with _seconds suffix', () => {
    expect(descriptor.funding_rules.funding_timeout).toMatch(/_seconds$/);
  });

  it('networks includes lightning', () => {
    expect(descriptor.networks).toContain('lightning');
  });
});
