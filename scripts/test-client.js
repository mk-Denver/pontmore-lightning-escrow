'use strict';

/**
 * scripts/test-client.js
 *
 * End-to-end test client for the Pontmore escrow service. Exercises all three
 * funding models (single_funder, two_party, n_of_m) against a running service
 * configured with BLINK_MODE=mock, so no real Lightning funds are spent.
 *
 * Flow per model:
 *   create → join counterparties → funding_instructions (each funder)
 *   → POST /test/pay-escrow (simulate invoice payment)
 *   → fund_status (expect FUNDED) → release (operator_decision) → expect SETTLED
 *
 * Requirements:
 *   - The target service must be started with BLINK_MODE=mock (enables /test/*).
 *   - Supabase must be configured (persistence is real; only Lightning is mocked).
 *   - OPERATOR_NSEC in .env must match the service's OPERATOR_PUBKEY (used to sign
 *     operator_decision release decisions).
 *
 * Usage:
 *   node scripts/test-client.js                       # uses SERVICE_BASE_URL from .env
 *   node scripts/test-client.js https://host.onrender.com   # override base URL
 *   node scripts/test-client.js --base https://host.onrender.com
 *
 * Exit code is non-zero if any scenario fails.
 */

const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');
const { config } = require('../config/env');
const { decodeNsec } = require('../lib/nostr-keys');
const { buildCanonicalMessage } = require('../lib/release-decisions');

const NIP98_KIND = 27235;
const PREFIX = config.SERVICE_PATH_PREFIX;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function hx(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function bx(hex) {
  const u = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return u;
}

function genKeypair() {
  const priv = secp256k1.utils.randomPrivateKey();
  const pub = hx(schnorr.getPublicKey(priv));
  return { priv: hx(priv), pub };
}

function computeEventId(event) {
  const canonical = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  return hx(sha256(canonical));
}

function signEvent(event, privHex) {
  event.id = computeEventId(event);
  event.sig = hx(schnorr.sign(bx(event.id), bx(privHex)));
  return event;
}

function nip98Header(privHex, method, url, bodyStr) {
  const tags = [['u', url], ['method', method.toUpperCase()]];
  let content = '';
  if (bodyStr) {
    tags.push(['payload', hx(sha256(bodyStr))]);
    content = bodyStr;
  }
  const event = signEvent({
    kind: NIP98_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
    pubkey: genPubkey(privHex),
  }, privHex);
  return 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64');
}

function genPubkey(privHex) {
  return hx(schnorr.getPublicKey(bx(privHex)));
}

async function api(method, path, body, privHex) {
  const url = API_ROOT + path;
  const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
  const headers = {
    Authorization: nip98Header(privHex, method, url, bodyStr),
  };
  if (bodyStr) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: bodyStr });
  let data;
  try { data = await res.json(); } catch { data = await res.text(); }
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : res.statusText;
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${msg}`);
  }
  return data;
}

// Sign an operator_decision release/refund decision over the canonical message.
function operatorDecisionSignature(operatorPrivHex, { escrowId, action, recipient, nonce, timestamp }) {
  const canonical = buildCanonicalMessage({
    escrowId, action, recipient, resultHash: 'none', nonce, timestamp,
  });
  return hx(schnorr.sign(sha256(canonical), bx(operatorPrivHex)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario runner
// ─────────────────────────────────────────────────────────────────────────────

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function runScenario({ name, model, threshold, participantCount }) {
  const log = (m) => console.log(`  ${m}`);
  log(`─ model=${model}${threshold ? ` threshold=${threshold}/${participantCount}` : ''}`);

  const creator = genKeypair();
  const creatorLn = `creator-${creator.pub.slice(0, 6)}@blink.sv`;

  // Number of counterparties to join.
  let joinersNeeded;
  if (model === 'single_funder') joinersNeeded = 1;
  else if (model === 'two_party') joinersNeeded = 1;
  else joinersNeeded = (participantCount - 1); // creator counts as 1

  // 1. create
  const createBody = {
    amount_sats: 1000,
    description: `e2e test (${model})`,
    refund_ln_address: creatorLn,
  };
  if (model !== 'single_funder') createBody.funding_model = model;
  if (model === 'n_of_m') {
    createBody.funding_threshold = threshold;
    createBody.participant_count = participantCount;
  }
  const created = await api('POST', '/create', createBody, creator.priv);
  assert(created.state === 'CREATED' || created.state === 'PENDING_FUNDING', `create state=${created.state}`);
  const escrowId = created.escrow_id;
  const token = created.invitation_token;
  log(`create → escrow ${escrowId.slice(0, 8)}… state=${created.state}`);

  // 2. join counterparties
  const joiners = [];
  for (let i = 0; i < joinersNeeded; i++) {
    const j = genKeypair();
    const joinBody = {
      amount_sats: 1000,
      invitation_token: token,
      refund_ln_address: `joiner-${j.pub.slice(0, 6)}@blink.sv`,
    };
    const joined = await api('POST', '/create', joinBody, j.priv);
    joiners.push(j);
    log(`join #${i + 1} → state=${joined.state} counterparty=${(joined.counterparty_pubkey || '').slice(0, 8)}…`);
  }

  // 3. funding_instructions for every funder
  //    single_funder: only the creator is a funder.
  //    two_party / n_of_m: creator + all joiners are funders.
  const funders = (model === 'single_funder') ? [creator] : [creator, ...joiners];
  for (const f of funders) {
    const fi = await api('POST', '/funding_instructions', { escrow_id: escrowId }, f.priv);
    assert(fi.payment_request, 'funding_instructions returned a payment_request');
    log(`funding_instructions (${f.pub.slice(0, 8)}…) → ${fi.payment_request.slice(0, 24)}…`);
  }

  // 4. simulate invoice payment via test endpoint
  const paid = await api('POST', '/test/pay-escrow', { escrow_id: escrowId }, creator.priv);
  assert(paid.count >= (model === 'single_funder' ? 1 : (model === 'two_party' ? 2 : threshold)),
    `pay-escrow marked ${paid.count} invoices paid`);
  log(`test/pay-escrow → ${paid.count} invoice(s) marked PAID`);

  // 5. fund_status → FUNDED
  const status = await api('POST', '/fund_status', { escrow_id: escrowId }, creator.priv);
  assert(status.funded === true, `fund_status funded=${status.funded}`);
  assert(status.state === 'FUNDED', `fund_status state=${status.state}`);
  log(`fund_status → state=${status.state} funded=${status.funded}` +
    (status.funded_count != null ? ` (${status.funded_count}/${status.total_funders})` : ''));

  // 6. release to counterparty with operator_decision
  const operatorPub = genPubkey(OPERATOR_PRIV);
  const nonce = `nonce-${escrowId.slice(0, 8)}-${Date.now()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = operatorDecisionSignature(OPERATOR_PRIV, {
    escrowId, action: 'release', recipient: 'counterparty', nonce, timestamp,
  });
  const releaseBody = {
    escrow_id: escrowId,
    release_decision: 'operator_decision',
    recipient: 'counterparty',
    nonce,
    timestamp,
    signatures: [{ pubkey: operatorPub, signature }],
  };
  const released = await api('POST', '/release', releaseBody, creator.priv);
  assert(released.state === 'SETTLED', `release state=${released.state}`);
  log(`release → state=${released.state} recipient=${released.recipient} payout=${JSON.stringify(released.payout)}`);

  return { escrowId, state: released.state };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

let API_ROOT;
let OPERATOR_PRIV;

function parseArgs(argv) {
  let base;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') base = argv[++i];
    else if (/^https?:\/\//.test(a)) base = a.replace(/\/$/, '');
  }
  return { base };
}

async function main() {
  const { base } = parseArgs(process.argv);
  const rawBase = (base || config.SERVICE_BASE_URL).replace(/\/$/, '');
  API_ROOT = rawBase.endsWith(PREFIX) ? rawBase : rawBase + PREFIX;

  if (!config.OPERATOR_NSEC) {
    console.error('FATAL: OPERATOR_NSEC is not set in .env (needed to sign operator_decision release decisions).');
    process.exit(1);
  }
  OPERATOR_PRIV = decodeNsec(config.OPERATOR_NSEC);
  const operatorPub = genPubkey(OPERATOR_PRIV);
  if (config.OPERATOR_PUBKEY && operatorPub !== config.OPERATOR_PUBKEY) {
    console.error('FATAL: OPERATOR_NSEC does not derive the configured OPERATOR_PUBKEY.');
    process.exit(1);
  }

  console.log(`\nPontmore escrow e2e test client`);
  console.log(`Target:   ${API_ROOT}`);
  console.log(`Operator: ${operatorPub.slice(0, 12)}…\n`);

  // Preflight: confirm the service is in mock mode (test endpoints available).
  try {
    const health = await fetch(`${API_ROOT.replace(PREFIX, '')}/health`).then((r) => r.json());
    console.log(`Health:   ${JSON.stringify(health)}`);
    if (health.backend_configured === false) {
      console.error('FATAL: target backend is not configured. Start the service with BLINK_MODE=mock + Supabase.');
      process.exit(1);
    }
  } catch (err) {
    console.error('FATAL: could not reach /health:', err.message);
    process.exit(1);
  }

  const scenarios = [
    { name: 'single_funder', model: 'single_funder' },
    { name: 'two_party', model: 'two_party' },
    { name: 'n_of_m (2 of 3)', model: 'n_of_m', threshold: 2, participantCount: 3 },
  ];

  const results = [];
  for (const s of scenarios) {
    console.log(`\n[${s.name}]`);
    try {
      const r = await runScenario(s);
      results.push({ name: s.name, ok: true, ...r });
      console.log(`  ✓ PASS\n`);
    } catch (err) {
      results.push({ name: s.name, ok: false, error: err.message });
      console.log(`  ✗ FAIL: ${err.message}\n`);
    }
  }

  console.log('─'.repeat(50));
  console.log('Summary:');
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' — ' + r.error}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} scenarios passed.`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
