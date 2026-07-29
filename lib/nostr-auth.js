'use strict';

/**
 * lib/nostr-auth.js
 *
 * NIP-98 (Nostr HTTP Authentication) verification middleware.
 *
 * A client authenticates by sending an HTTP request with the header:
 *   Authorization: Nostr <base64-encoded JSON event>
 *
 * The event MUST be kind 27235 and contain:
 *   - ["u", "<full request URL>"]      tag matching the target URL
 *   - ["method", "<HTTP method>"]      tag matching the HTTP method
 *   - ["payload", "<sha256 hex>"]      optional tag matching the request body hash
 *
 * Verification checks, per nostrbook.dev event rules and NIP-98:
 *   1. event id == sha256 of canonical serialized payload [0, pubkey, created_at, kind, tags, content]
 *   2. schnorr signature over the id is valid for the pubkey
 *   3. kind == 27235
 *   4. created_at is within the configured freshness window
 *   5. the `u` tag matches the full request URL (scheme + host + path + query)
 *   6. the `method` tag matches the HTTP method (case-insensitive)
 *   7. if a `payload` tag is present, it matches sha256(request body)
 */

const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha2');
const { config } = require('../config/env');

const NIP98_KIND = 27235;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function hexToBytes(hex) {
  const clean = hex.toLowerCase();
  if (clean.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function isHexPubkey(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function getTag(event, name) {
  if (!Array.isArray(event?.tags)) return undefined;
  for (const tag of event.tags) {
    if (Array.isArray(tag) && tag[0] === name) return tag[1];
  }
  return undefined;
}

/**
 * Compute the canonical Nostr event id (sha256 of the serialized payload).
 * Payload array order: [0, pubkey, created_at, kind, tags, content]
 */
function computeEventId(event) {
  const payload = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return bytesToHex(sha256(payload));
}

/**
 * Verify a BIP-340 Schnorr signature over the event id for the given pubkey.
 */
function verifySignature(event) {
  try {
    const msg = hexToBytes(event.id);
    const sig = hexToBytes(event.sig);
    const pub = hexToBytes(event.pubkey);
    return schnorr.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

/**
 * Structural validation of a decoded NIP-98 event object.
 */
function validateEventShape(event) {
  if (!event || typeof event !== 'object') return 'event is not an object';
  if (!isHexPubkey(event.pubkey)) return 'pubkey is not a 32-byte hex string';
  if (!Number.isInteger(event.created_at)) return 'created_at is not an integer';
  if (!Number.isInteger(event.kind)) return 'kind is not an integer';
  if (!Array.isArray(event.tags)) return 'tags is not an array';
  if (typeof event.content !== 'string') return 'content is not a string';
  if (typeof event.id !== 'string' || !/^[0-9a-f]{64}$/i.test(event.id)) return 'id is not a 32-byte hex string';
  if (typeof event.sig !== 'string' || !/^[0-9a-f]{128}$/i.test(event.sig)) return 'sig is not a 64-byte hex string';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify a decoded NIP-98 auth event against an Express request.
 *
 * @param {object} event  - decoded Nostr event object
 * @param {object} req    - Express request (needs .method, fullUrl(), rawBody)
 * @returns {{ ok: boolean, pubkey?: string, error?: string }}
 */
function verifyNip98(event, req) {
  const shapeErr = validateEventShape(event);
  if (shapeErr) return { ok: false, error: `invalid event: ${shapeErr}` };

  if (event.kind !== NIP98_KIND) {
    return { ok: false, error: `event kind must be ${NIP98_KIND}, got ${event.kind}` };
  }

  const computedId = computeEventId(event);
  if (computedId !== event.id.toLowerCase()) {
    return { ok: false, error: 'event id does not match payload hash' };
  }

  if (!verifySignature(event)) {
    return { ok: false, error: 'signature verification failed' };
  }

  const now = Math.floor(Date.now() / 1000);
  const maxAge = config.NIP98_MAX_AGE_SECONDS;
  if (Math.abs(now - event.created_at) > maxAge) {
    return { ok: false, error: `auth event created_at is outside the ${maxAge}s freshness window` };
  }

  const fullUrl = req.fullUrl();
  const uTag = getTag(event, 'u');
  if (!uTag) return { ok: false, error: 'missing required "u" tag' };
  if (uTag !== fullUrl) {
    return { ok: false, error: '"u" tag does not match the request URL' };
  }

  const methodTag = getTag(event, 'method');
  if (!methodTag) return { ok: false, error: 'missing required "method" tag' };
  if (methodTag.toUpperCase() !== req.method.toUpperCase()) {
    return { ok: false, error: '"method" tag does not match the HTTP method' };
  }

  const payloadTag = getTag(event, 'payload');
  if (payloadTag) {
    const bodyHash = req.rawBody ? bytesToHex(sha256(req.rawBody)) : bytesToHex(sha256(''));
    if (payloadTag !== bodyHash) {
      return { ok: false, error: '"payload" tag does not match the request body hash' };
    }
  }

  return { ok: true, pubkey: event.pubkey };
}

/**
 * Express middleware that requires a valid NIP-98 auth header.
 * On success, sets `req.authPubkey` to the authenticated Nostr pubkey (hex).
 */
function requireNostrAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const match = /^Nostr\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return res.status(401).json({ error: 'missing or malformed Authorization header; expected "Nostr <base64>"' });
  }

  let event;
  try {
    const json = Buffer.from(match[1], 'base64').toString('utf8');
    event = JSON.parse(json);
  } catch {
    return res.status(401).json({ error: 'Authorization header does not contain a valid base64 JSON event' });
  }

  const result = verifyNip98(event, req);
  if (!result.ok) {
    return res.status(401).json({ error: `NIP-98 authentication failed: ${result.error}` });
  }

  req.authPubkey = result.pubkey;
  req.authEvent = event;
  return next();
}

module.exports = {
  NIP98_KIND,
  computeEventId,
  verifySignature,
  verifyNip98,
  requireNostrAuth,
  isHexPubkey,
};
