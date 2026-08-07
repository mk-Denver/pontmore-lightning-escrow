'use strict';

/**
 * scripts/list-descriptors.js
 *
 * Queries Nostr relays for every kind 30361 escrow descriptor event published
 * by this operator and prints the event ids. Use those ids with the server
 * /unpublish endpoint, or pass --delete to sign and broadcast a kind 5
 * deletion covering all discovered events in one step.
 *
 * Usage:
 *   node scripts/list-descriptors.js            # list event ids
 *   node scripts/list-descriptors.js --delete   # list + broadcast kind 5 deletion
 *
 * Requires OPERATOR_NSEC in .env.
 */

const { schnorr } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');
const WebSocket = require('ws');
const { config } = require('../config/env');
const { decodeNsec } = require('../lib/nostr-keys');

const KIND_ESCROW_DESCRIPTOR = 30361;
const RELAYS = ['wss://nos.lol', 'wss://relay.damus.io'];

function hx(bytes) { return Buffer.from(bytes).toString('hex'); }
function bx(hex) { return Buffer.from(hex, 'hex'); }

function queryRelay(relay, pubkeyHex) {
  return new Promise((resolve) => {
    const events = [];
    const subId = `desc-${Math.random().toString(36).slice(2)}`;
    let ws;
    try { ws = new WebSocket(relay); }
    catch (e) { console.warn(`[list] ${relay}: connect failed:`, e.message); resolve([]); return; }

    const timer = setTimeout(() => {
      try { ws.send(JSON.stringify(['CLOSE', subId])); ws.close(); } catch {}
      resolve(events);
    }, 8000);

    ws.on('open', () => {
      ws.send(JSON.stringify([
        'REQ', subId, { authors: [pubkeyHex], kinds: [KIND_ESCROW_DESCRIPTOR] },
      ]));
    });

    ws.on('message', (data) => {
      try {
        const [type, , payload] = JSON.parse(data.toString());
        if (type === 'EVENT' && payload && payload.kind === KIND_ESCROW_DESCRIPTOR) {
          events.push(payload);
        }
        if (type === 'EOSE') {
          clearTimeout(timer);
          try { ws.send(JSON.stringify(['CLOSE', subId])); ws.close(); } catch {}
          resolve(events);
        }
      } catch {}
    });

    ws.on('error', () => { clearTimeout(timer); resolve(events); });
    ws.on('close', () => { clearTimeout(timer); resolve(events); });
  });
}

function buildDeletionEvent(eventIds, pubkeyHex, privkeyHex) {
  const tags = eventIds.map((id) => ['e', id]);
  tags.push(['k', String(KIND_ESCROW_DESCRIPTOR)]);
  const event = {
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: 'Escrow service listing deleted by operator',
    pubkey: pubkeyHex,
  };
  const canonical = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  event.id = hx(sha256(canonical));
  event.sig = hx(schnorr.sign(bx(event.id), privkeyHex));
  return event;
}

function broadcastDeletion(delEvent) {
  return Promise.all(RELAYS.map((relay) => new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(relay); }
    catch (e) { resolve({ relay, ok: false, message: e.message }); return; }
    let result = null;
    const timer = setTimeout(() => { try { ws.close(); } catch {}; resolve(result || { relay, ok: false, message: 'timeout' }); }, 8000);
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', delEvent])));
    ws.on('message', (data) => {
      try {
        const [type, , ok, msg] = JSON.parse(data.toString());
        if (type === 'OK') { result = { relay, ok, message: msg || '' }; clearTimeout(timer); try { ws.close(); } catch {}; resolve(result); }
      } catch {}
    });
    ws.on('error', (err) => { clearTimeout(timer); resolve({ relay, ok: false, message: err.message }); });
  })));
}

async function main() {
  const doDelete = process.argv.includes('--delete');

  if (!config.OPERATOR_NSEC) {
    console.error('[list] OPERATOR_NSEC is not set in .env; cannot derive operator pubkey');
    process.exit(1);
  }

  const privkeyHex = decodeNsec(config.OPERATOR_NSEC);
  const pubkeyHex = hx(schnorr.getPublicKey(privkeyHex)).slice(2);

  console.log('[list] Operator pubkey:', pubkeyHex);
  console.log('[list] Querying relays for kind 30361 events...');

  const perRelay = await Promise.all(RELAYS.map((r) => queryRelay(r, pubkeyHex)));
  const byId = new Map();
  for (const events of perRelay) {
    for (const ev of events) byId.set(ev.id, ev);
  }

  const found = [...byId.values()].sort((a, b) => b.created_at - a.created_at);

  if (found.length === 0) {
    console.log('[list] No kind 30361 events found for this operator on the configured relays.');
    return;
  }

  console.log(`\n[list] Found ${found.length} descriptor event(s):\n`);
  for (const ev of found) {
    const dTag = (ev.tags.find((t) => t[0] === 'd') || [])[1] || '(none)';
    console.log(`  id:         ${ev.id}`);
    console.log(`  created_at: ${new Date(ev.created_at * 1000).toISOString()}`);
    console.log(`  d-tag:      ${dTag}`);
    console.log('');
  }

  const eventIds = found.map((ev) => ev.id);

  if (doDelete) {
    console.log('[list] --delete: building and broadcasting kind 5 deletion...');
    const delEvent = buildDeletionEvent(eventIds, pubkeyHex, privkeyHex);
    console.log('[list] Deletion event id:', delEvent.id);
    const results = await broadcastDeletion(delEvent);
    for (const r of results) {
      console.log(`  ${r.relay}: ${r.ok ? 'accepted' : 'rejected'}${r.message ? ' - ' + r.message : ''}`);
    }
    console.log('\n[list] Done. Relays should hide the referenced descriptor events.');
  } else {
    console.log('[list] Event ids to delete:');
    console.log(JSON.stringify(eventIds, null, 2));
    console.log('\n[list] To delete, run:  node scripts/list-descriptors.js --delete');
    console.log('[list] Or POST the ids to the /unpublish endpoint as { "event_ids": [...] }.');
  }
}

main().catch((err) => {
  console.error('[list] FATAL:', err.message);
  process.exit(1);
});
