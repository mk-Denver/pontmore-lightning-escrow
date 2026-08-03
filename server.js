'use strict';

/**
 * server.js
 *
 * PIP-01 conformant custodial escrow service over HTTPS.
 *
 * Public endpoints (no auth):
 *   GET  /health                      — liveness
 *   GET  /pontmore/v1/descriptor      — the PIP-01 escrow descriptor (service block)
 *   GET  /pontmore/v1/openapi.json    — the normative wire contract (schema_url)
 *
 * Protected endpoints (NIP-98 auth required):
 *   POST /pontmore/v1/create
 *   POST /pontmore/v1/funding_instructions
 *   POST /pontmore/v1/fund_status
 *   POST /pontmore/v1/release
 *   POST /pontmore/v1/refund
 *   POST /pontmore/v1/cancel
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');

const { config, hasBackend, isMockMode } = require('./config/env');
const { requireNostrAuth } = require('./lib/nostr-auth');
const { decodeNsec } = require('./lib/nostr-keys');
const escrow = require('./lib/escrow');
const { StateConflictError, NotFoundError, ValidationError } = require('./services/supabase');

const {
  listEscrowInstances,
  getEscrowInstance,
  fileDispute,
  resolveDispute,
  setPayoutSuccessful,
  listFunders,
} = require('./services/supabase');
const blink = require('./services/blink');

const { schnorr } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');
const WebSocket = require('ws');

const NOSTR_RELAYS = ['wss://nos.lol', 'wss://relay.damus.io'];

// ─────────────────────────────────────────────────────────────────────────────
// App setup
// ─────────────────────────────────────────────────────────────────────────────

const app = express();

// Honor X-Forwarded-Proto / X-Forwarded-Host from the hosting proxy (e.g. Render)
// so req.protocol and req.get('host') match the URL the client signed in NIP-98.
app.set('trust proxy', 1);

// CORS: allow browser-based clients (e.g. the test UI) to call the API cross-origin.
// NIP-98 auth is the real security layer; CORS only governs browser reachability.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Capture the raw request body (for NIP-98 payload hash verification) before JSON parse.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// Helper: Express has no built-in full URL; add one for NIP-98 `u` tag matching.
app.use((req, _res, next) => {
  req.fullUrl = () => {
    const proto = req.protocol;
    const host = req.get('host');
    return `${proto}://${host}${req.originalUrl}`;
  };
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Public routes
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    backend_configured: hasBackend(),
    interface: config.SERVICE_INTERFACE,
  });
});

// Serve the descriptor. The endpoint/schema_url fields are rewritten at serve
// time to reflect the configured SERVICE_BASE_URL so the document is self-consistent.
app.get(path.join(config.SERVICE_PATH_PREFIX, 'descriptor'), (_req, res) => {
  const descriptorPath = path.join(__dirname, 'public', 'descriptor.json');
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));

  if (descriptor.service) {
    descriptor.service.endpoint  = config.SERVICE_ENDPOINT;
    descriptor.service.schema_url = config.SCHEMA_URL;
    descriptor.service.transport  = ['https'];
    descriptor.service.interface  = config.SERVICE_INTERFACE;
    descriptor.service.operations = ['create', 'funding_instructions', 'fund_status', 'release', 'refund', 'cancel'];
    descriptor.service.auth       = ['nostr_http_auth'];
    descriptor.service.funding_model     = config.ACCEPTED_FUNDING_MODELS;
    descriptor.service.default_funding_model = config.FUNDING_MODEL;
    descriptor.service.funding_threshold = config.FUNDING_THRESHOLD;
    descriptor.service.participant_count = config.PARTICIPANT_COUNT;
    descriptor.service.release_decisions = config.ACCEPTED_RELEASE_DECISIONS;
  }
  descriptor.updated_at = Math.floor(Date.now() / 1000);
  res.json(descriptor);
});

// Serve the OpenAPI wire contract (the schema_url target).
app.get(path.join(config.SERVICE_PATH_PREFIX, 'openapi.json'), (_req, res) => {
  const schemaPath = path.join(__dirname, 'public', 'openapi.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

  // Rewrite the server URL to the configured endpoint so the served schema matches.
  if (Array.isArray(schema.servers) && schema.servers.length > 0) {
    schema.servers[0].url = config.SERVICE_ENDPOINT;
  }
  res.json(schema);
});

// ─────────────────────────────────────────────────────────────────────────────
// Operator web UI (static, no auth)
// ─────────────────────────────────────────────────────────────────────────────

app.use('/operator', express.static(path.join(__dirname, 'public', 'operator')));

// ─────────────────────────────────────────────────────────────────────────────
// Protected routes — all require NIP-98 auth
// ─────────────────────────────────────────────────────────────────────────────

const PREFIX = config.SERVICE_PATH_PREFIX;

// Middleware: refuse mutating operations when the backend is not configured.
function requireBackend(req, res, next) {
  if (!hasBackend()) {
    return res.status(503).json({ error: 'escrow backend not configured (Supabase/Blink credentials are blank in .env)' });
  }
  next();
}

// Middleware: require NIP-98 auth AND the pubkey must match the configured OPERATOR_PUBKEY.
function requireOperator(req, res, next) {
  if (!config.OPERATOR_PUBKEY) {
    return res.status(503).json({ error: 'OPERATOR_PUBKEY is not configured in .env' });
  }
  if (req.authPubkey !== config.OPERATOR_PUBKEY) {
    return res.status(403).json({ error: 'only the configured operator pubkey may access this endpoint' });
  }
  next();
}

app.post(path.join(PREFIX, 'create'), requireBackend, requireNostrAuth, async (req, res) => {
  try {
    const result = await escrow.create({
      authPubkey:       req.authPubkey,
      amountSats:       req.body.amount_sats,
      description:      req.body.description,
      refundLnAddress:  req.body.refund_ln_address,
      idempotencyKey:   req.body.idempotency_key,
      invitationToken:  req.body.invitation_token,
      fundingModel:     req.body.funding_model,
      fundingThreshold: req.body.funding_threshold,
      participantCount: req.body.participant_count,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

app.post(path.join(PREFIX, 'funding_instructions'), requireBackend, requireNostrAuth, async (req, res) => {
  try {
    const result = await escrow.fundingInstructions({
      escrowId:   req.body.escrow_id,
      authPubkey: req.authPubkey,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

app.post(path.join(PREFIX, 'fund_status'), requireBackend, requireNostrAuth, async (req, res) => {
  try {
    const result = await escrow.fundStatus({
      escrowId:   req.body.escrow_id,
      authPubkey: req.authPubkey,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

app.post(path.join(PREFIX, 'release'), requireBackend, requireNostrAuth, async (req, res) => {
  try {
    const result = await escrow.release({
      escrowId:      req.body.escrow_id,
      authPubkey:    req.authPubkey,
      decisionBody:  req.body.decision ?? req.body,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

app.post(path.join(PREFIX, 'refund'), requireBackend, requireNostrAuth, async (req, res) => {
  try {
    const result = await escrow.refund({
      escrowId:      req.body.escrow_id,
      authPubkey:    req.authPubkey,
      decisionBody:  req.body.decision ?? req.body,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

app.post(path.join(PREFIX, 'cancel'), requireBackend, requireNostrAuth, async (req, res) => {
  try {
    const result = await escrow.cancel({
      escrowId:   req.body.escrow_id,
      authPubkey: req.authPubkey,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Operator dashboard (NIP-98 + operator pubkey required)
// ─────────────────────────────────────────────────────────────────────────────

app.get(path.join(PREFIX, 'operator', 'escrows'), requireBackend, requireNostrAuth, requireOperator, async (req, res) => {
  try {
    const rows = await listEscrowInstances({ state: req.query.state || null, limit: 200 });
    res.json(
      rows.map((r) => ({
        escrow_id:             r.escrow_id,
        state:                 r.state,
        funding_model:         r.funding_model,
        creator_pubkey:        r.creator_pubkey,
        counterparty_pubkey:   r.counterparty_pubkey,
        amount_sats:           r.amount_sats,
        payout_successful:     r.payout_successful,
        dispute_class:         r.dispute_class,
        dispute_opened_at:     r.dispute_opened_at,
        dispute_resolution_mode: r.dispute_resolution_mode,
        created_at:            r.created_at,
        updated_at:            r.updated_at,
      }))
    );
  } catch (err) {
    handleError(res, err);
  }
});

app.get(path.join(PREFIX, 'operator', 'escrows', ':escrowId'), requireBackend, requireNostrAuth, requireOperator, async (req, res) => {
  try {
    const r = await getEscrowInstance(req.params.escrowId);
    // Strip internal payment fields from public listing
    const { blink_payment_hash, blink_payment_request, ...safe } = r;
    res.json(safe);
  } catch (err) {
    handleError(res, err);
  }
});

app.post(path.join(PREFIX, 'operator', 'disputes'), requireBackend, requireNostrAuth, requireOperator, async (req, res) => {
  try {
    const result = await fileDispute(req.body.escrow_id, {
      disputeClass: req.body.dispute_class,
      summary:      req.body.summary,
      openedBy:     req.authPubkey,
    });
    res.json({
      escrow_id:      result.escrow_id,
      state:          result.state,
      dispute_class:  result.dispute_class,
      dispute_opened_at: result.dispute_opened_at,
    });
  } catch (err) {
    handleError(res, err);
  }
});

app.post(path.join(PREFIX, 'operator', 'disputes', ':escrowId', 'resolve'), requireBackend, requireNostrAuth, requireOperator, async (req, res) => {
  try {
    const escrowId = req.params.escrowId;
    const { outcome, resolution_mode, note } = req.body;

    const escrow = await getEscrowInstance(escrowId);
    if (escrow.state !== 'DISPUTED') throw new ValidationError(`escrow is ${escrow.state}, not DISPUTED`);

    const resolved = await resolveDispute(escrowId, {
      outcome,
      resolutionMode: resolution_mode,
      note,
    });

    // Execute payout
    const payoutSats = escrow.amount_sats;
    if (outcome === 'release') {
      const addr = escrow.payout_ln_address;
      if (addr && addr.includes('@')) {
        try {
          await blink.payToLightningAddress({ lnAddress: addr, amountSats: payoutSats });
          await setPayoutSuccessful(escrowId);
        } catch (err) {
          return res.json({
            escrow_id:        resolved.escrow_id,
            state:            resolved.state,
            payout:           { status: 'pending_bolt11', reason: err.message },
            resolution_mode:  resolved.dispute_resolution_mode,
            resolved_at:      resolved.dispute_resolved_at,
          });
        }
      }
    } else if (outcome === 'refund') {
      const addr = escrow.refund_ln_address;
      if (addr && addr.includes('@')) {
        try {
          await blink.payToLightningAddress({ lnAddress: addr, amountSats: payoutSats });
          await setPayoutSuccessful(escrowId);
        } catch (err) {
          return res.json({
            escrow_id:        resolved.escrow_id,
            state:            resolved.state,
            refund:           { status: 'pending_bolt11', reason: err.message },
            resolution_mode:  resolved.dispute_resolution_mode,
            resolved_at:      resolved.dispute_resolved_at,
          });
        }
      }
    }

    res.json({
      escrow_id:        resolved.escrow_id,
      state:            resolved.state,
      resolution_mode:  resolved.dispute_resolution_mode,
      resolved_at:      resolved.dispute_resolved_at,
      payout_successful: resolved.payout_successful,
    });
  } catch (err) {
    handleError(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Descriptor management (operator only)
// ─────────────────────────────────────────────────────────────────────────────

// Get the current descriptor as served (with live endpoint/schema_url rewrites).
app.get(path.join(PREFIX, 'operator', 'descriptor'), (_req, res) => {
  const descriptorPath = path.join(__dirname, 'public', 'descriptor.json');
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  if (descriptor.service) {
    descriptor.service.endpoint          = config.SERVICE_ENDPOINT;
    descriptor.service.schema_url        = config.SCHEMA_URL;
    descriptor.service.transport         = ['https'];
    descriptor.service.interface         = config.SERVICE_INTERFACE;
    descriptor.service.operations        = ['create', 'funding_instructions', 'fund_status', 'release', 'refund', 'cancel'];
    descriptor.service.auth              = ['nostr_http_auth'];
    descriptor.service.funding_model     = config.ACCEPTED_FUNDING_MODELS;
    descriptor.service.default_funding_model = config.FUNDING_MODEL;
    descriptor.service.funding_threshold = config.FUNDING_THRESHOLD;
    descriptor.service.participant_count = config.PARTICIPANT_COUNT;
    descriptor.service.release_decisions = config.ACCEPTED_RELEASE_DECISIONS;
  }
  descriptor.updated_at = Math.floor(Date.now() / 1000);
  res.json(descriptor);
});

// Publish a signed kind 30361 descriptor event to Nostr relays. The operator
// signs the event client-side; this endpoint is a relay broadcast proxy.
app.post(path.join(PREFIX, 'operator', 'publish'), requireBackend, requireNostrAuth, requireOperator, async (req, res) => {
  try {
    const { event } = req.body;
    if (!event || !event.id || !event.sig || event.kind !== 30361) {
      return res.status(400).json({ error: 'body must contain a signed kind 30361 Nostr event as "event"' });
    }

    const results = [];

    // Broadcast via poc.pontmore.xyz API (HTTP proxy, faster)
    try {
      const pocRes = await fetch('https://poc.pontmore.xyz/api/escrows/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relays: NOSTR_RELAYS, event }),
      });
      const pocJson = await pocRes.json();
      if (Array.isArray(pocJson.results)) results.push(...pocJson.results);
      else results.push(...pocJson);
    } catch (err) {
      console.warn('[publish] poc.pontmore.xyz proxy failed:', err.message);
    }

    // Fallback: direct WebSocket broadcast for any relays not covered above
    const covered = new Set(results.map((r) => r.relay));
    for (const relay of NOSTR_RELAYS) {
      if (covered.has(relay)) continue;
      try {
        const ws = new WebSocket(relay);
        await new Promise((resolve) => {
          let result = null;
          ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
          ws.on('message', (data) => {
            try {
              const [type, , ok, msg] = JSON.parse(data.toString());
              if (type === 'OK') result = { relay, ok, message: msg || '' };
            } catch {}
          });
          ws.on('error', (err) => { result = { relay, ok: false, message: err.message }; resolve(); });
          ws.on('close', () => resolve());
          setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 8000);
        });
        results.push(result || { relay, ok: false, message: 'no response' });
      } catch (err) {
        results.push({ relay, ok: false, message: err.message });
      }
    }

    res.json({ event_id: event.id, results });
  } catch (err) {
    handleError(res, err);
  }
});

// Delete the escrow descriptor listing from Nostr relays.
// The operator signs a kind 5 deletion event referencing the kind 30361
// descriptor event id(s). Relays hide the referenced events upon seeing it.
app.post(path.join(PREFIX, 'operator', 'unpublish'), requireBackend, requireNostrAuth, requireOperator, async (req, res) => {
  try {
    const { event_ids } = req.body;
    if (!Array.isArray(event_ids) || event_ids.length === 0) {
      return res.status(400).json({ error: 'body must contain a non-empty "event_ids" array of kind 30361 event ids to delete' });
    }

    for (const id of event_ids) {
      if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) {
        return res.status(400).json({ error: `event_ids must be 32-byte hex (64 hex chars); got invalid value: "${id}"` });
      }
    }

    if (!config.OPERATOR_NSEC) {
      return res.status(503).json({ error: 'OPERATOR_NSEC is not configured; cannot sign deletion event' });
    }

    const privkey = decodeNsec(config.OPERATOR_NSEC);
    const pubkey  = Buffer.from(schnorr.getPublicKey(privkey)).toString('hex');

    const tags = event_ids.map(id => ['e', id]);
    tags.push(['k', '30361']);

    const delEvent = {
      kind: 5,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: 'Escrow service listing deleted by operator',
      pubkey,
    };

    const canonical = JSON.stringify([0, delEvent.pubkey, delEvent.created_at, delEvent.kind, delEvent.tags, delEvent.content]);
    delEvent.id  = Buffer.from(sha256(canonical)).toString('hex');
    delEvent.sig = Buffer.from(schnorr.sign(Buffer.from(delEvent.id, 'hex'), privkey)).toString('hex');

    const results = [];

    // Broadcast via poc.pontmore.xyz API
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const pocRes = await fetch('https://poc.pontmore.xyz/api/escrows/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relays: NOSTR_RELAYS, event: delEvent }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const pocJson = await pocRes.json();
      if (Array.isArray(pocJson.results)) results.push(...pocJson.results);
      else results.push(...pocJson);
    } catch (err) {
      console.warn('[unpublish] poc.pontmore.xyz proxy failed:', err.message);
    }

    // Fallback: direct WebSocket broadcast
    const covered = new Set(results.map((r) => r.relay));
    for (const relay of NOSTR_RELAYS) {
      if (covered.has(relay)) continue;
      try {
        const ws = new WebSocket(relay);
        await new Promise((resolve) => {
          let result = null;
          ws.on('open', () => ws.send(JSON.stringify(['EVENT', delEvent])));
          ws.on('message', (data) => {
            try {
              const [type, , ok, msg] = JSON.parse(data.toString());
              if (type === 'OK') result = { relay, ok, message: msg || '' };
            } catch {}
          });
          ws.on('error', (err) => { result = { relay, ok: false, message: err.message }; resolve(); });
          ws.on('close', () => resolve());
          setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 8000);
        });
        results.push(result || { relay, ok: false, message: 'no response' });
      } catch (err) {
        results.push({ relay, ok: false, message: err.message });
      }
    }

    res.json({ deletion_event_id: delEvent.id, deleted_event_ids: event_ids, results });
  } catch (err) {
    handleError(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test-only endpoints (available ONLY when BLINK_MODE=mock)
//
// These simulate Lightning invoice payments and payouts so the full escrow flow
// can be exercised end-to-end without real sats. They are never registered in
// real (production) mode. Still require NIP-98 auth so they are not anonymous.
// ─────────────────────────────────────────────────────────────────────────────

if (isMockMode()) {
  app.post(path.join(PREFIX, 'test', 'pay-invoice'), requireBackend, requireNostrAuth, async (req, res) => {
    try {
      const { payment_hash } = req.body;
      if (!payment_hash || !/^[0-9a-f]{64}$/i.test(payment_hash)) {
        return res.status(400).json({ error: 'payment_hash must be a 64-char hex string' });
      }
      if (typeof blink.markInvoicePaid !== 'function') {
        return res.status(503).json({ error: 'test endpoints require BLINK_MODE=mock' });
      }
      const ok = blink.markInvoicePaid(payment_hash);
      if (!ok) return res.status(404).json({ error: 'no mock invoice found for that payment_hash' });
      res.json({ payment_hash, status: 'PAID' });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post(path.join(PREFIX, 'test', 'pay-escrow'), requireBackend, requireNostrAuth, async (req, res) => {
    try {
      const { escrow_id } = req.body;
      if (!escrow_id) return res.status(400).json({ error: 'escrow_id is required' });
      if (typeof blink.markInvoicePaid !== 'function') {
        return res.status(503).json({ error: 'test endpoints require BLINK_MODE=mock' });
      }

      const inst = await getEscrowInstance(escrow_id);
      const paid = [];
      if (inst.blink_payment_hash) {
        blink.markInvoicePaid(inst.blink_payment_hash);
        paid.push(inst.blink_payment_hash);
      }
      const funders = await listFunders(escrow_id);
      for (const f of funders) {
        if (f.blink_payment_hash && !paid.includes(f.blink_payment_hash)) {
          blink.markInvoicePaid(f.blink_payment_hash);
          paid.push(f.blink_payment_hash);
        }
      }
      res.json({ escrow_id, paid_invoices: paid, count: paid.length });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get(path.join(PREFIX, 'test', 'mock-invoices'), requireBackend, requireNostrAuth, async (_req, res) => {
    if (typeof blink.listInvoices !== 'function') {
      return res.status(503).json({ error: 'test endpoints require BLINK_MODE=mock' });
    }
    res.json({ invoices: blink.listInvoices() });
  });

  console.warn('[startup] TEST ENDPOINTS ENABLED (BLINK_MODE=mock). Do NOT use in production.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────────

function handleError(res, err) {
  if (err instanceof NotFoundError)      return res.status(404).json({ error: err.message });
  if (err instanceof StateConflictError) return res.status(409).json({ error: err.message });
  if (err instanceof ValidationError)    return res.status(400).json({ error: err.message });
  console.error('[server] unhandled error:', err);
  return res.status(500).json({ error: 'internal server error' });
}

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// ─────────────────────────────────────────────────────────────────────────────
// Cron jobs (only when backend is configured)
// ─────────────────────────────────────────────────────────────────────────────

async function recoverPendingPayouts() {
  if (!hasBackend()) return;
  const { getSettledUnpaidEscrows, setPayoutSuccessful } = require('./services/supabase');
  const { payToLightningAddress, satsToFiat } = require('./services/blink');
  let pending;
  try { pending = await getSettledUnpaidEscrows(); }
  catch (err) { return console.error('[recovery] query failed:', err.message); }
  if (!pending.length) return console.log('[recovery] no pending payouts.');

  for (const row of pending) {
    const payoutSats = row.amount_sats;
    const addr = row.payout_ln_address;
    if (!addr) continue;
    try {
      await payToLightningAddress({ lnAddress: addr, amountSats: payoutSats });
      await setPayoutSuccessful(row.escrow_id);
      console.log(`[recovery] payout settled for ${row.escrow_id}`);
    } catch (err) {
      console.warn(`[recovery] payout failed for ${row.escrow_id}: ${err.message}`);
    }
  }
}

let isAutoReleasing = false;
async function processAutoReleases() {
  if (!hasBackend() || isAutoReleasing) return;
  isAutoReleasing = true;
  try {
    const { getExpiredFundedEscrows, transitionState, setPayoutSuccessful } = require('./services/supabase');
    const { payToLightningAddress } = require('./services/blink');
    let expired;
    try { expired = await getExpiredFundedEscrows(3); }
    catch (err) { return console.error('[cron] expired query failed:', err.message); }
    if (!expired.length) return;

    for (const row of expired) {
      try { await transitionState(row.escrow_id, 'FUNDED', 'SETTLED'); }
      catch (err) { continue; }
      const addr = row.payout_ln_address;
      if (addr) {
        try {
          await payToLightningAddress({ lnAddress: addr, amountSats: row.amount_sats });
          await setPayoutSuccessful(row.escrow_id);
        } catch (err) {
          console.warn(`[cron] auto-release payout failed for ${row.escrow_id}: ${err.message}`);
        }
      }
    }
  } finally {
    isAutoReleasing = false;
  }
}

async function cleanupZombieEscrows() {
  if (!hasBackend()) return;
  const { getExpiredPendingEscrows, transitionState } = require('./services/supabase');
  let dead;
  try { dead = await getExpiredPendingEscrows(24); }
  catch { return; }
  for (const row of dead) {
    try { await transitionState(row.escrow_id, 'PENDING_FUNDING', 'CANCELLED'); }
    catch { /* ignore collision */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

let _initStarted = false;
let _initDone = false;
async function init() {
  if (_initDone) return;
  if (_initStarted) return;
  _initStarted = true;
  console.log('[startup] Environment validated ✓');
  console.log(`[startup] Service interface: ${config.SERVICE_INTERFACE}`);
  console.log(`[startup] Funding model:    ${config.FUNDING_MODEL}`);
  console.log(`[startup] Accepted models:  ${config.ACCEPTED_FUNDING_MODELS.join(', ')}`);
  console.log(`[startup] Release decisions: ${config.ACCEPTED_RELEASE_DECISIONS.join(', ')}`);
  console.log(`[startup] Backend configured: ${hasBackend()}`);

  if (hasBackend()) {
    const { initBlink } = require('./services/blink');
    try {
      await initBlink();
      await recoverPendingPayouts();
    } catch (err) {
      console.warn(`[startup] Backend init failed: ${err.message}`);
    }

    cron.schedule('0 * * * *', processAutoReleases);
    cron.schedule('0 0 * * *', cleanupZombieEscrows);
    console.log('[startup] Cron jobs scheduled.');
  } else {
    console.log('[startup] Skipping backend init (credentials blank). Descriptor + schema are still served.');
  }
  _initDone = true;
}

module.exports = { app, init };

if (require.main === module) {
  init().then(() => {
    app.listen(config.PORT, () => {
      console.log(`[startup] Express listening on port ${config.PORT}`);
      console.log(`[startup] Descriptor:  ${config.SERVICE_ENDPOINT}/descriptor`);
      console.log('[startup] Service ready. ⚡');
    });
  }).catch((err) => {
    console.error('[startup] FATAL:', err.message);
    process.exit(1);
  });
}
