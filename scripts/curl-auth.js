'use strict';

/**
 * scripts/curl-auth.js
 *
 * Generates a ready-to-run curl command with a signed NIP-98 auth header.
 *
 * Usage:
 *   node scripts/curl-auth.js <method> <path> [json-body]
 *
 * Examples:
 *   node scripts/curl-auth.js GET /pontmore/v1/descriptor
 *   node scripts/curl-auth.js POST /pontmore/v1/create '{"amount_sats":1000,"description":"test"}'
 *   node scripts/curl-auth.js POST /pontmore/v1/fund_status '{"escrow_id":"<uuid>"}'
 *
 * Requires OPERATOR_NSEC in .env (nsec or hex privkey).
 * Uses SERVICE_BASE_URL from .env (defaults to http://localhost:3000).
 */

const { bech32 } = require('@scure/base');
const { schnorr } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');
const { config } = require('../config/env');

const NIP98_KIND = 27235;

function hx(bytes) { return Buffer.from(bytes).toString('hex'); }
function bx(hex)   { return Buffer.from(hex, 'hex'); }

function decodeNsec(nsec) {
  if (!nsec) throw new Error('OPERATOR_NSEC is not set in .env');
  if (/^[0-9a-f]{64}$/i.test(nsec)) return nsec.toLowerCase();
  if (nsec.startsWith('nsec1')) {
    const decoded = bech32.decodeToBytes(nsec);
    if (decoded.prefix !== 'nsec') throw new Error('Not a valid nsec');
    return hx(decoded.bytes);
  }
  throw new Error('OPERATOR_NSEC must be nsec1... or 64-char hex');
}

function buildSignedEvent(url, method, bodyStr) {
  const privkey = decodeNsec(config.OPERATOR_NSEC);
  const pubkey  = hx(schnorr.getPublicKey(privkey));

  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];

  let content = '';
  if (bodyStr) {
    const hash = hx(sha256(bodyStr));
    tags.push(['payload', hash]);
    content = bodyStr;
  }

  const event = { kind: NIP98_KIND, created_at: Math.floor(Date.now() / 1000), tags, content, pubkey };

  const canonical = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  event.id  = hx(sha256(canonical));
  event.sig = hx(schnorr.sign(bx(event.id), privkey));

  return event;
}

function main() {
  const [,, method, reqPath, bodyStr] = process.argv;

  if (!method || !reqPath) {
    console.error('Usage: node scripts/curl-auth.js <method> <path> [json-body]');
    console.error('Example: node scripts/curl-auth.js GET /pontmore/v1/descriptor');
    process.exit(1);
  }

  const baseUrl  = config.SERVICE_BASE_URL.replace(/\/$/, '');
  const fullUrl  = baseUrl + (reqPath.startsWith('/') ? reqPath : '/' + reqPath);

  let parsedBody = '';
  if (bodyStr) {
    try { parsedBody = JSON.stringify(JSON.parse(bodyStr)); }
    catch { throw new Error('json-body is not valid JSON'); }
  }

  const event       = buildSignedEvent(fullUrl, method.toUpperCase(), parsedBody || undefined);
  const authHeader  = 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64');

  const parts = ['curl -s', `-X ${method.toUpperCase()}`];
  parts.push(`-H "Authorization: ${authHeader}"`);
  if (parsedBody) parts.push(`-H "Content-Type: application/json"`, `-d '${parsedBody}'`);
  parts.push(`"${fullUrl}"`);

  console.log(parts.join(' \\\n  '));
  console.log('\n# Auth pubkey:', hx(schnorr.getPublicKey(decodeNsec(config.OPERATOR_NSEC))));
}

main();
