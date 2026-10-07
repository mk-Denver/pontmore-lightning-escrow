'use strict';

/**
 * lib/pip01.js
 *
 * PIP-01: Escrow Descriptor validation.
 *
 * Validates Nostr kind 30361 addressable descriptor events per the current
 * Pontmore PIP-01 specification. A descriptor is a compatibility/discovery
 * object: version, escrow_type, networks, expires_at, and an optional
 * service.schema pointer. Service behavior is owned by the referenced
 * schema, NOT by the descriptor.
 */

const { schnorr } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');

const KIND_ESCROW_DESCRIPTOR = 30361;

const VALID_ESCROW_TYPES = new Set([
  'lightning_hold_invoice',
  'custodial_escrow',
  'cashu_escrow',
]);

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

function computeEventId(event) {
  const canonical = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return bytesToHex(sha256(canonical));
}

function verifyEventSignature(event) {
  if (!event.id || !event.pubkey || !event.sig) return false;
  const computedId = computeEventId(event);
  if (computedId !== event.id) return false;
  try {
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

/**
 * Validate a kind 30361 escrow descriptor event.
 *
 * @param {object} event - Nostr event (kind 30361)
 * @param {object} [opts] - { now: <unix seconds>, allowExpired: bool }
 * @returns {{ valid: boolean, errors: string[], descriptor: object|null }}
 */
function validateDescriptorEvent(event, opts = {}) {
  const errors = [];
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  if (!event || typeof event !== 'object') {
    return { valid: false, errors: ['event is not an object'], descriptor: null };
  }

  if (event.kind !== KIND_ESCROW_DESCRIPTOR) {
    errors.push(`event kind must be ${KIND_ESCROW_DESCRIPTOR}, got ${event.kind}`);
  }

  if (!event.pubkey || !/^[0-9a-f]{64}$/.test(event.pubkey)) {
    errors.push('event.pubkey must be a 64-char hex string');
  }

  if (!verifyEventSignature(event)) {
    errors.push('event signature verification failed');
  }

  // d tag (addressable)
  const dTags = (event.tags || []).filter((t) => t[0] === 'd');
  if (dTags.length !== 1) {
    errors.push('event must contain exactly one "d" tag');
  } else if (!dTags[0][1] || typeof dTags[0][1] !== 'string') {
    errors.push('"d" tag value must be a non-empty string');
  }

  // Parse content
  let content;
  try {
    content = JSON.parse(event.content);
  } catch {
    errors.push('event.content is not valid JSON');
    return { valid: false, errors, descriptor: null };
  }

  if (typeof content !== 'object' || content === null) {
    errors.push('event.content must be a JSON object');
    return { valid: false, errors, descriptor: null };
  }

  // version (integer)
  if (!Number.isInteger(content.version)) {
    errors.push('content.version must be an integer');
  }

  // escrow_type (non-empty, lowercase)
  if (typeof content.escrow_type !== 'string' || content.escrow_type.length === 0 || content.escrow_type !== content.escrow_type.toLowerCase()) {
    errors.push('content.escrow_type must be a non-empty lowercase string');
  }

  // networks (non-empty array of lowercase strings)
  if (!Array.isArray(content.networks) || content.networks.length === 0) {
    errors.push('content.networks must be a non-empty array');
  } else {
    for (const net of content.networks) {
      if (typeof net !== 'string' || net.length === 0 || net !== net.toLowerCase()) {
        errors.push(`content.networks entry "${net}" must be a non-empty lowercase string`);
      }
    }
  }

  // expires_at (Unix timestamp, integer)
  if (!Number.isInteger(content.expires_at) || content.expires_at <= 0) {
    errors.push('content.expires_at must be a positive Unix timestamp integer');
  } else if (!opts.allowExpired && content.expires_at <= now) {
    errors.push('descriptor has expired (expires_at is not later than validation time)');
  }

  // t tags MUST match content.networks
  const tTags = (event.tags || [])
    .filter((t) => t[0] === 't' && typeof t[1] === 'string' && t[1].startsWith('pontmore-network:'))
    .map((t) => t[1].slice('pontmore-network:'.length));

  if (content.networks && Array.isArray(content.networks)) {
    for (const net of content.networks) {
      if (!tTags.includes(net)) {
        errors.push(`content.networks entry "${net}" has no matching "t" tag (pontmore-network:${net})`);
      }
    }
    for (const net of tTags) {
      if (!content.networks.includes(net)) {
        errors.push(`"t" tag pontmore-network:${net} claims a network absent from content.networks`);
      }
    }
  }

  // service (optional, but if present must contain ONLY schema)
  if (content.service !== undefined) {
    if (typeof content.service !== 'object' || content.service === null) {
      errors.push('content.service must be an object');
    } else {
      const serviceKeys = Object.keys(content.service);
      if (serviceKeys.length !== 1 || serviceKeys[0] !== 'schema') {
        errors.push('content.service must contain only "schema"');
      }
      const schema = content.service.schema;
      if (!schema || typeof schema !== 'object') {
        errors.push('content.service.schema must be an object');
      } else {
        if (schema.type !== 'openapi' && schema.type !== 'asyncapi') {
          errors.push('content.service.schema.type must be "openapi" or "asyncapi"');
        }
        if (typeof schema.url !== 'string' || !schema.url.startsWith('https://')) {
          errors.push('content.service.schema.url must be an absolute https:// URL');
        }
      }
    }
  }

  // Reject disallowed top-level fields (spec says content MUST have the
  // listed fields; funding_rules, dispute_rules, reference_format, updated_at
  // etc. are NOT part of the current descriptor and belong in the schema).
  const allowedFields = new Set(['version', 'escrow_type', 'networks', 'expires_at', 'service']);
  for (const key of Object.keys(content)) {
    if (!allowedFields.has(key)) {
      errors.push(`content contains disallowed field "${key}" (service behavior belongs in the referenced schema)`);
    }
  }

  return { valid: errors.length === 0, errors, descriptor: content };
}

/**
 * Check whether a descriptor is selectable for a new coordination.
 *
 * @param {object} descriptor - parsed content of the descriptor event
 * @param {number} now - current unix time
 * @returns {boolean}
 */
function isSelectable(descriptor, now = Math.floor(Date.now() / 1000)) {
  if (!descriptor || !Number.isInteger(descriptor.expires_at)) return false;
  return descriptor.expires_at > now;
}

module.exports = {
  KIND_ESCROW_DESCRIPTOR,
  computeEventId,
  verifyEventSignature,
  validateDescriptorEvent,
  isSelectable,
  VALID_ESCROW_TYPES,
};
