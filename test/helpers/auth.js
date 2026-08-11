'use strict';

const { schnorr } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');
const { bytesToHex, hexToBytes } = require('./keys');

const NIP98_KIND = 27235;

/**
 * Build a signed NIP-98 (kind 27235) auth event for an HTTP request.
 *
 * @param {{ method: string, url: string, body?: string, privkey: string, pubkey: string }} opts
 * @returns {{ event: object, authHeader: string }}
 */
function buildSignedAuthEvent({ method, url, body, privkey, pubkey }) {
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];

  const content = body || '';

  if (content) {
    const hash = bytesToHex(sha256(content));
    tags.push(['payload', hash]);
  }

  const event = {
    kind: NIP98_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
    pubkey,
  };

  const canonical = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  event.id = bytesToHex(sha256(canonical));
  event.sig = bytesToHex(schnorr.sign(hexToBytes(event.id), privkey));

  const authHeader = 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64');
  return { event, authHeader };
}

module.exports = { NIP98_KIND, buildSignedAuthEvent };
