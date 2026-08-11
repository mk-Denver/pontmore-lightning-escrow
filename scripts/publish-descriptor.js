'use strict';

/**
 * scripts/publish-descriptor.js
 *
 * Builds, signs, and broadcasts a kind 30361 escrow descriptor event to Nostr
 * relays so the service becomes discoverable on poc.pontmore.xyz.
 *
 * Usage:
 *   node scripts/publish-descriptor.js              # build + sign, print event
 *   node scripts/publish-descriptor.js --publish    # build + sign + broadcast to relays
 *
 * Requires OPERATOR_NSEC in .env (nsec or hex privkey).
 * SERVICE_BASE_URL in .env must be a publicly reachable URL for the service
 * block to be useful to remote clients.
 */

const fs = require('fs');
const path = require('path');
const { bech32 } = require('@scure/base');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');
const { config } = require('../config/env');

const KIND_ESCROW_DESCRIPTOR = 30361;

function hx(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function bx(hex) {
  return Buffer.from(hex, 'hex');
}

function decodeNsec(nsec) {
  return require('../lib/nostr-keys').decodeNsec(nsec);
}

function buildDescriptorEvent(descriptor, pubkeyHex, privkeyHex) {
  const event = {
    kind: KIND_ESCROW_DESCRIPTOR,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', 'escrow'],
      ['network', 'lightning'],
    ],
    content: JSON.stringify(descriptor),
    pubkey: pubkeyHex,
  };

  const canonical = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);

  event.id = hx(sha256(canonical));
  event.sig = hx(schnorr.sign(bx(event.id), privkeyHex));

  const valid = schnorr.verify(bx(event.sig), bx(event.id), bx(pubkeyHex));
  if (!valid) throw new Error('Self-verification of signed event failed');

  return event;
}

async function broadcastToRelays(signedEvent) {
  const relays = ['wss://nos.lol', 'wss://relay.damus.io'];

  // Try the POC API first (convenient proxy)
  try {
    console.log('[publish] Broadcasting via poc.pontmore.xyz API...');
    const res = await fetch('https://poc.pontmore.xyz/api/escrows/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relays, event: signedEvent }),
    });
    const result = await res.json();
    console.log('[publish] poc.pontmore.xyz result:', JSON.stringify(result, null, 2));
    return result;
  } catch (err) {
    console.warn('[publish] poc.pontmore.xyz API failed:', err.message);
    console.log('[publish] Falling back to direct relay broadcast...');
  }

  // Fallback: direct WebSocket broadcast to each relay
  for (const relay of relays) {
    await new Promise((resolve, reject) => {
      const WebSocket = require('ws');
      let ws;
      try {
        ws = new WebSocket(relay);
      } catch (e) { console.warn(`[publish] ${relay}: failed to connect:`, e.message); resolve(); return; }

      ws.on('open', () => {
        ws.send(JSON.stringify(['EVENT', signedEvent]));
      });

      ws.on('message', (data) => {
        try {
          const [type, subId, ok, message] = JSON.parse(data.toString());
          if (type === 'OK') {
            console.log(`[publish] ${relay}: ${ok ? 'accepted' : 'rejected'}${message ? ' - ' + message : ''}`);
            ws.close();
            resolve();
          }
        } catch {}
      });

      ws.on('error', (err) => {
        console.warn(`[publish] ${relay}: error:`, err.message);
        resolve();
      });

      setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 10000);
    });
  }
}

async function main() {
  const publish = process.argv.includes('--publish');

  // Read the descriptor from the static file
  const descriptorPath = path.join(__dirname, '..', 'public', 'descriptor.json');
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));

  // Rewrite schema url from config (same as server.js does at serve time)
  if (descriptor.service && descriptor.service.schema) {
    descriptor.service.schema.url = config.SCHEMA_URL;
  }
  descriptor.funding_rules.funding_model = config.ACCEPTED_FUNDING_MODELS;
  descriptor.funding_rules.funding_timeout = `${config.FUNDING_TIMEOUT_SECONDS}_seconds`;
  descriptor.updated_at = Math.floor(Date.now() / 1000);

  const privkeyHex = decodeNsec(config.OPERATOR_NSEC);
  const pubkeyHex = hx(secp256k1.getPublicKey(privkeyHex)).slice(2);

  if (config.OPERATOR_PUBKEY && pubkeyHex !== config.OPERATOR_PUBKEY) {
    console.error('[publish] WARNING: derived pubkey from OPERATOR_NSEC does not match OPERATOR_PUBKEY');
    console.error(`  derived:  ${pubkeyHex}`);
    console.error(`  expected: ${config.OPERATOR_PUBKEY}`);
    process.exit(1);
  }

  console.log('[publish] Operator pubkey:', pubkeyHex);
  console.log('[publish] Schema URL:', config.SCHEMA_URL);

  const signedEvent = buildDescriptorEvent(descriptor, pubkeyHex, privkeyHex);
  console.log('[publish] Signed event id:', signedEvent.id);
  console.log('[publish] Tags:', JSON.stringify(signedEvent.tags));

  if (!publish) {
    console.log('\n--- Signed Nostr Event (kind 30361) ---');
    console.log(JSON.stringify(signedEvent, null, 2));
    console.log('\n[publish] Run with --publish to broadcast to relays.');
    console.log('[publish] Or paste the event above into https://poc.pontmore.xyz (Escrow Publish tab).');
    return;
  }

  await broadcastToRelays(signedEvent);

  console.log('\n[publish] Done. Check https://poc.pontmore.xyz (Escrow Discovery tab)');
  console.log(`[publish] Look for pubkey ${pubkeyHex.slice(0, 8)}… or d-tag "escrow"`);
}

main().catch((err) => {
  console.error('[publish] FATAL:', err.message);
  process.exit(1);
});
