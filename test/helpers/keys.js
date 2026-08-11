'use strict';

const { schnorr } = require('@noble/curves/secp256k1');

/** @param {Uint8Array} bytes */
function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/** @param {string} hex */
function hexToBytes(hex) {
  const clean = hex.toLowerCase();
  if (clean.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Generate a fresh secp256k1 keypair using crypto.randomBytes via the
 * @noble/hashes utils. Returns { privkey, pubkey } as hex.
 */
function generateKeypair() {
  const { randomBytes } = require('@noble/hashes/utils');
  const privkey = bytesToHex(randomBytes(32));
  const pubkeyBuffer = schnorr.getPublicKey(privkey);
  const pubkey = bytesToHex(pubkeyBuffer);
  return { privkey, pubkey };
}

module.exports = { bytesToHex, hexToBytes, generateKeypair };
