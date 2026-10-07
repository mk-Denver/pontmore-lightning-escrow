'use strict';

/**
 * lib/nostr-event.js
 *
 * Nostr event construction, signing, and verification helpers shared by
 * PIP-01 descriptors and PIP-02 coordination events.
 *
 * Event ID = sha256 of the canonical serialization:
 *   [0, pubkey, created_at, kind, tags, content]
 *
 * Signature = BIP-340 Schnorr over the event ID.
 */

const { schnorr } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');

const KIND_COORDINATION_ROOT = 7300;
const KIND_COORDINATION_ACTION = 7301;

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

/**
 * Sign a Nostr event in-place. Sets `id` and `sig`.
 * @param {object} event - { kind, created_at, tags, content, pubkey }
 * @param {string} privkeyHex - 64-char hex private key
 * @returns {object} the signed event (with id + sig)
 */
function signEvent(event, privkeyHex) {
  if (!event.pubkey) throw new Error('event.pubkey is required for signing');
  const id = computeEventId(event);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(privkeyHex)));
  return { ...event, id, sig };
}

/**
 * Verify a Nostr event's id and signature.
 * @param {object} event - signed Nostr event
 * @returns {boolean}
 */
function verifyEvent(event) {
  if (!event || !event.id || !event.pubkey || !event.sig) return false;
  const computedId = computeEventId(event);
  if (computedId !== event.id) return false;
  try {
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

/**
 * Derive a hex pubkey from a hex privkey.
 */
function getPubkey(privkeyHex) {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(privkeyHex)));
}

/**
 * Find all tags of a given name.
 */
function findTags(event, name) {
  return (event.tags || []).filter((t) => t[0] === name);
}

/**
 * Find the first tag of a given name and return its value array.
 */
function findTag(event, name) {
  const tags = findTags(event, name);
  return tags.length > 0 ? tags[0] : null;
}

module.exports = {
  KIND_COORDINATION_ROOT,
  KIND_COORDINATION_ACTION,
  computeEventId,
  signEvent,
  verifyEvent,
  getPubkey,
  findTags,
  findTag,
  hexToBytes,
  bytesToHex,
};
