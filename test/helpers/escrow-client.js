'use strict';

const { buildSignedAuthEvent } = require('./auth');

/**
 * Create an authenticated escrow API client.
 *
 * @param {string} baseUrl - e.g. "https://standalone-escrow.onrender.com"
 */
function createEscrowClient(baseUrl) {
  const prefix = '/pontmore/v1';
  const base = baseUrl.replace(/\/$/, '');

  /**
   * @param {{ method: string, path: string, body?: object, privkey: string, pubkey: string }} opts
   */
  async function authenticatedRequest({ method, path, body, privkey, pubkey }) {
    const url = base + (path.startsWith('/') ? path : '/' + path);
    const bodyStr = body ? JSON.stringify(body) : undefined;

    const { authHeader } = buildSignedAuthEvent({ method, url, body: bodyStr, privkey, pubkey });

    const headers = { 'Content-Type': 'application/json' };
    if (authHeader) headers['Authorization'] = authHeader;

    const fetchOptions = { method, headers };
    if (bodyStr) fetchOptions.body = bodyStr;

    const response = await fetch(url, fetchOptions);
    const json = await response.json().catch(() => null);
    return { status: response.status, data: json, headers: response.headers };
  }

  /**
   * @param {{ privkey: string, pubkey: string }} keypair
   * @param {object} body - create payload (amount_sats, funding_model, etc. or enrollment_token)
   */
  async function create(keypair, body) {
    return authenticatedRequest({ method: 'POST', path: `${prefix}/create`, body, ...keypair });
  }

  /**
   * @param {{ privkey: string, pubkey: string }} keypair
   */
  async function fundingInstructions(keypair, escrowId) {
    return authenticatedRequest({
      method: 'POST',
      path: `${prefix}/funding_instructions`,
      body: { escrow_id: escrowId },
      ...keypair,
    });
  }

  /**
   * @param {{ privkey: string, pubkey: string }} keypair
   */
  async function fundStatus(keypair, escrowId) {
    return authenticatedRequest({
      method: 'POST',
      path: `${prefix}/fund_status`,
      body: { escrow_id: escrowId },
      ...keypair,
    });
  }

  /**
   * @param {{ privkey: string, pubkey: string }} keypair
   * @param {object} body - release decision payload
   */
  async function release(keypair, body) {
    return authenticatedRequest({ method: 'POST', path: `${prefix}/release`, body, ...keypair });
  }

  /**
   * @param {{ privkey: string, pubkey: string }} keypair
   * @param {object} body - refund decision payload
   */
  async function refund(keypair, body) {
    return authenticatedRequest({ method: 'POST', path: `${prefix}/refund`, body, ...keypair });
  }

  /**
   * @param {{ privkey: string, pubkey: string }} keypair
   */
  async function cancel(keypair, escrowId) {
    return authenticatedRequest({
      method: 'POST',
      path: `${prefix}/cancel`,
      body: { escrow_id: escrowId },
      ...keypair,
    });
  }

  /**
   * @param {{ privkey: string, pubkey: string }} keypair
   * @param {object} body - dispute payload
   */
  async function dispute(keypair, body) {
    return authenticatedRequest({ method: 'POST', path: `${prefix}/disputes`, body, ...keypair });
  }

  async function getDescriptor() {
    const response = await fetch(`${base}${prefix}/descriptor`);
    const json = await response.json();
    return { status: response.status, data: json, headers: response.headers };
  }

  async function getOpenApi() {
    const response = await fetch(`${base}${prefix}/openapi/v1.0.0.json`);
    const json = await response.json();
    return { status: response.status, data: json };
  }

  async function health() {
    const response = await fetch(`${base}/health`);
    const json = await response.json();
    return { status: response.status, data: json };
  }

  return {
    create,
    fundingInstructions,
    fundStatus,
    release,
    refund,
    cancel,
    dispute,
    getDescriptor,
    getOpenApi,
    health,
  };
}

module.exports = { createEscrowClient };
