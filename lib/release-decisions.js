'use strict';

/**
 * lib/release-decisions.js
 *
 * Verifies the generic release-decision formats advertised by this service.
 *
 * Canonical signed payload (the string each signer signs with their Nostr key):
 *   pontmore-escrow:v1:<escrow_id>:<action>:<recipient>:<result_hash>:<nonce>:<timestamp>
 *
 * - action:     "release" | "refund"
 * - recipient:  "creator" | "counterparty"
 * - result_hash: sha256 hex of the optional result payload, or "none" when absent
 * - nonce:      unique per decision (replay protection)
 * - timestamp:  unix seconds
 *
 * The signature is a BIP-340 Schnorr signature over sha256(canonical_message).
 */

const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha2');
const { config } = require('../config/env');
const { isHexPubkey } = require('./nostr-auth');

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function sha256Hex(str) {
  return bytesToHex(sha256(str));
}

function buildCanonicalMessage({ escrowId, action, recipient, resultHash, nonce, timestamp }) {
  return `pontmore-escrow:v1:${escrowId}:${action}:${recipient}:${resultHash}:${nonce}:${timestamp}`;
}

function verifySchnorrSignature(pubkeyHex, signatureHex, messageStr) {
  try {
    const msgHash = sha256(messageStr);
    const sig = hexToBytes(signatureHex);
    const pub = hexToBytes(pubkeyHex);
    return schnorr.verify(sig, msgHash, pub);
  } catch {
    return false;
  }
}

/**
 * Determine which pubkeys are the participants for an escrow instance.
 *
 * PIP-01 two-party escrow: the creator and the single counterparty are the
 * declared funding participants and the only bound participants.
 */
function participantRoles(escrow) {
  const creator = escrow.creator_pubkey;
  const counterparty = escrow.counterparty_pubkey;
  const all = [creator, counterparty].filter(Boolean);
  return { creator, counterparty, all, funders: all };
}

/**
 * Verify a release/refund decision against an escrow instance.
 *
 * @param {object} escrow    - escrow instance row
 * @param {string} action    - "release" | "refund"
 * @param {object} body      - parsed request body
 * @returns {{ ok: boolean, recipient?: string, error?: string, decision?: object }}
 */
function verifyDecision(escrow, action, body) {
  const decisionType = body.release_decision;
  if (!decisionType) return { ok: false, error: 'missing "release_decision" field' };

  if (!config.ACCEPTED_RELEASE_DECISIONS.includes(decisionType)) {
    return { ok: false, error: `release_decision "${decisionType}" is not accepted by this service` };
  }

  const roles = participantRoles(escrow);

  const recipient = body.recipient;
  if (recipient !== 'creator' && recipient !== 'counterparty') {
    return { ok: false, error: '"recipient" must be "creator" or "counterparty"' };
  }

  if (action === 'refund' && recipient !== 'creator') {
    return { ok: false, error: 'refund recipient must be the funder ("creator")' };
  }

  const nonce = body.nonce;
  const timestamp = body.timestamp;
  if (!nonce || typeof nonce !== 'string') return { ok: false, error: 'missing string "nonce"' };
  if (!Number.isInteger(timestamp)) return { ok: false, error: '"timestamp" must be a unix integer' };
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > config.DECISION_MAX_AGE_SECONDS) {
    return { ok: false, error: `decision timestamp must be within ${config.DECISION_MAX_AGE_SECONDS} seconds` };
  }

  // Result binding (application_signed_result requires a verifiable result).
  const resultStr = body.result ? JSON.stringify(body.result) : '';
  const resultHash = resultStr ? sha256Hex(resultStr) : 'none';

  const canonical = buildCanonicalMessage({
    escrowId: escrow.escrow_id,
    action,
    recipient,
    resultHash,
    nonce,
    timestamp,
  });

  const signatures = Array.isArray(body.signatures) ? body.signatures : [];
  if (decisionType === 'mutual_consent') {
    if (signatures.length < roles.all.length) {
      return { ok: false, error: `mutual_consent requires signatures from all ${roles.all.length} bound participants` };
    }
    for (const expectedPub of roles.all) {
      const sigEntry = signatures.find((s) => s.pubkey === expectedPub);
      if (!sigEntry) return { ok: false, error: `missing signature from participant ${expectedPub}` };
      if (!verifySchnorrSignature(expectedPub, sigEntry.signature, canonical)) {
        return { ok: false, error: `invalid signature from participant ${expectedPub}` };
      }
    }
    return { ok: true, recipient, decision: { type: decisionType, canonical, nonce, timestamp, resultHash } };
  }

  if (decisionType === 'operator_decision') {
    if (!config.OPERATOR_PUBKEY) {
      return { ok: false, error: 'service has no OPERATOR_PUBKEY configured for operator_decision' };
    }
    const sigEntry = signatures.find((s) => s.pubkey === config.OPERATOR_PUBKEY);
    if (!sigEntry) return { ok: false, error: 'missing signature from the configured operator pubkey' };
    if (!verifySchnorrSignature(config.OPERATOR_PUBKEY, sigEntry.signature, canonical)) {
      return { ok: false, error: 'invalid operator signature' };
    }
    return { ok: true, recipient, decision: { type: decisionType, canonical, nonce, timestamp, resultHash } };
  }

  if (decisionType === 'application_signed_result') {
    if (!resultStr) return { ok: false, error: 'application_signed_result requires a non-empty "result" payload' };
    const validSigner = signatures.find((sigEntry) => (
      isHexPubkey(sigEntry?.pubkey)
      && verifySchnorrSignature(sigEntry.pubkey, sigEntry.signature, canonical)
    ));
    if (!validSigner) {
      return { ok: false, error: 'no valid application signature' };
    }
    return { ok: true, recipient, decision: { type: decisionType, canonical, nonce, timestamp, resultHash, signer: validSigner.pubkey } };
  }

  if (decisionType === 'threshold_participant_signatures') {
    const threshold = roles.all.length;
    let validCount = 0;
    const seen = new Set();
    for (const sigEntry of signatures) {
      if (!isHexPubkey(sigEntry.pubkey) || seen.has(sigEntry.pubkey)) continue;
      if (!roles.all.includes(sigEntry.pubkey)) continue;
      if (verifySchnorrSignature(sigEntry.pubkey, sigEntry.signature, canonical)) {
        validCount++;
        seen.add(sigEntry.pubkey);
      }
    }
    if (validCount < threshold) {
      return { ok: false, error: `threshold ${threshold} not met; only ${validCount} valid distinct participant signatures` };
    }
    return { ok: true, recipient, decision: { type: decisionType, canonical, nonce, timestamp, resultHash, threshold, validCount } };
  }

  if (decisionType === 'oracle_signature') {
    const oraclePubkey = body.oracle_pubkey;
    if (!oraclePubkey || !isHexPubkey(oraclePubkey)) {
      return { ok: false, error: 'oracle_signature requires a valid hex "oracle_pubkey"' };
    }
    if (!config.ORACLE_PUBKEYS.includes(oraclePubkey)) {
      return { ok: false, error: 'oracle_pubkey is not registered by this service' };
    }
    const sigEntry = signatures.find((s) => s.pubkey === oraclePubkey);
    if (!sigEntry) return { ok: false, error: 'missing signature from the referenced oracle pubkey' };
    if (!verifySchnorrSignature(oraclePubkey, sigEntry.signature, canonical)) {
      return { ok: false, error: 'invalid oracle signature' };
    }
    return { ok: true, recipient, decision: { type: decisionType, canonical, nonce, timestamp, resultHash, oraclePubkey } };
  }

  return { ok: false, error: `unsupported release_decision "${decisionType}"` };
}

module.exports = {
  buildCanonicalMessage,
  verifySchnorrSignature,
  verifyDecision,
  sha256Hex,
};
