'use strict';

/**
 * services/supabase.js
 *
 * Persistence layer for PIP-01 escrow instances. Participants are identified by
 * Nostr pubkeys (hex), not platform account IDs.
 *
 * The SQL schema and atomic RPCs are documented in schema.sql next to this file.
 */

const { createClient } = require('@supabase/supabase-js');
const { config } = require('../config/env');

// ─────────────────────────────────────────────────────────────────────────────
// Client (singleton, lazily created so config can load without a backend)
// ─────────────────────────────────────────────────────────────────────────────

let _supabase = null;

function supabase() {
  if (_supabase) return _supabase;
  if (!config.SUPABASE_PROJECT_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('[supabase] Backend not configured: SUPABASE_PROJECT_URL / SUPABASE_SERVICE_ROLE_KEY are blank');
  }
  _supabase = createClient(config.SUPABASE_PROJECT_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabase;
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom error types
// ─────────────────────────────────────────────────────────────────────────────

class StateConflictError extends Error {
  constructor(escrowId, expectedState) {
    super(`Escrow ${escrowId} was not in state "${expectedState}" — possible concurrent modification.`);
    this.name = 'StateConflictError';
    this.escrowId = escrowId;
    this.expectedState = expectedState;
  }
}

class NotFoundError extends Error {
  constructor(resource, id) {
    super(`${resource} not found: ${id}`);
    this.name = 'NotFoundError';
    this.resource = resource;
    this.id = id;
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Valid state machine transitions (PIP-02 aligned)
// ─────────────────────────────────────────────────────────────────────────────

const VALID_TRANSITIONS = Object.freeze({
  CREATED:         ['PENDING_FUNDING', 'CANCELLED'],
  PENDING_FUNDING: ['PENDING_FUNDING', 'FUNDED', 'CANCELLED'],
  FUNDED:          ['SETTLED', 'DISPUTED', 'CANCELLED'],
  DISPUTED:        ['SETTLED', 'CANCELLED'],
  SETTLED:         [],
  CANCELLED:       [],
});

// ─────────────────────────────────────────────────────────────────────────────
// Escrow instance helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new escrow instance in state CREATED.
 * `creator_pubkey` is the authenticated Nostr pubkey of the participant who
 * called `create`. In single_funder mode the creator is the funder.
 */
async function createEscrowInstance({
  creatorPubkey,
  amountSats,
  platformFeeSats,
  description,
  fundingModel,
  refundLnAddress,
  idempotencyKey,
}) {
  const db = supabase();

  // Idempotency: if a matching idempotency key exists, return the existing row.
  if (idempotencyKey) {
    const { data: existing } = await db
      .from('escrow_instances')
      .select('*')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (existing) return existing;
  }

  const invitationToken = crypto.randomUUID().replace(/-/g, '');

  const { data, error } = await db
    .from('escrow_instances')
    .insert({
      creator_pubkey:    creatorPubkey,
      amount_sats:       amountSats,
      platform_fee_sats: platformFeeSats,
      description:       description ?? '',
      funding_model:     fundingModel,
      refund_ln_address: refundLnAddress ?? null,
      idempotency_key:   idempotencyKey ?? null,
      invitation_token:  invitationToken,
      state:             'CREATED',
    })
    .select()
    .single();

  if (error) throw new Error(`[supabase] createEscrowInstance failed: ${error.message}`);
  return data;
}

/**
 * Fetch an escrow instance by UUID.
 * @throws {NotFoundError}
 */
async function getEscrowInstance(escrowId) {
  const db = supabase();
  const { data, error } = await db
    .from('escrow_instances')
    .select('*')
    .eq('escrow_id', escrowId)
    .maybeSingle();

  if (error) throw new Error(`[supabase] getEscrowInstance failed: ${error.message}`);
  if (!data) throw new NotFoundError('Escrow instance', escrowId);
  return data;
}

/**
 * Counterparty joins an escrow instance using a service-issued invitation token.
 * Binds the counterparty pubkey and transitions CREATED -> PENDING_FUNDING.
 */
async function joinEscrowInstance(escrowId, invitationToken, counterpartyPubkey, payoutLnAddress) {
  const db = supabase();
  const { data: existing, error: fetchErr } = await db
    .from('escrow_instances')
    .select('*')
    .eq('escrow_id', escrowId)
    .maybeSingle();
  if (fetchErr) throw new Error(`[supabase] joinEscrowInstance fetch failed: ${fetchErr.message}`);
  if (!existing) throw new NotFoundError('Escrow instance', escrowId);

  if (existing.state !== 'CREATED') throw new StateConflictError(escrowId, 'CREATED');
  if (existing.counterparty_pubkey) throw new ValidationError('Escrow instance already has a counterparty.');
  if (existing.creator_pubkey === counterpartyPubkey) throw new ValidationError('Creator cannot be their own counterparty.');
  if (existing.invitation_token !== invitationToken) throw new ValidationError('Invalid invitation token.');

  const { data, error } = await db
    .from('escrow_instances')
    .update({
      counterparty_pubkey: counterpartyPubkey,
      payout_ln_address:   payoutLnAddress ?? null,
      state:               'PENDING_FUNDING',
      updated_at:          new Date().toISOString(),
    })
    .eq('escrow_id', escrowId)
    .eq('state', 'CREATED')
    .select()
    .single();

  if (error) throw new Error(`[supabase] joinEscrowInstance failed: ${error.message}`);
  if (!data) throw new StateConflictError(escrowId, 'CREATED');
  return data;
}

/**
 * Stamp the funding invoice (payment hash + request) onto a PENDING_FUNDING
 * instance. Uses a self-transition so it is safe to retry.
 */
async function setFundingInvoice(escrowId, paymentHash, paymentRequest) {
  return transitionState(escrowId, 'PENDING_FUNDING', 'PENDING_FUNDING', {
    blink_payment_hash: paymentHash,
    blink_payment_request: paymentRequest,
  });
}

/**
 * Atomic state transition via the transition_escrow_state RPC.
 * @throws {StateConflictError}
 */
async function transitionState(escrowId, expectedState, newState, extra = {}) {
  const allowed = VALID_TRANSITIONS[expectedState] ?? [];
  if (!allowed.includes(newState)) {
    throw new Error(`[supabase] Invalid state transition: ${expectedState} → ${newState}`);
  }

  const db = supabase();
  const { data, error } = await db.rpc('transition_escrow_state', {
    p_escrow_id: escrowId,
    p_expected_state: expectedState,
    p_new_state: newState,
    p_extra: extra,
  });

  if (error) throw new Error(`[supabase] transition_escrow_state RPC failed: ${error.message}`);
  if (!data || data.length === 0) throw new StateConflictError(escrowId, expectedState);
  return data[0];
}

/** Alias used by escrow.js for clarity. */
const transitionEscrowState = transitionState;

/**
 * Record a release decision that authorised a release or refund.
 */
async function setReleaseDecision(escrowId, decisionType, decisionPayload) {
  const db = supabase();
  const { data, error } = await db
    .from('escrow_instances')
    .update({
      release_decision_type:    decisionType,
      release_decision_payload: decisionPayload,
      updated_at:               new Date().toISOString(),
    })
    .eq('escrow_id', escrowId)
    .select()
    .single();

  if (error) throw new Error(`[supabase] setReleaseDecision failed: ${error.message}`);
  return data;
}

/**
 * Mark an escrow's payout as successful. Idempotent (boolean true).
 */
async function setPayoutSuccessful(escrowId) {
  const db = supabase();
  const { error } = await db
    .from('escrow_instances')
    .update({ payout_successful: true, updated_at: new Date().toISOString() })
    .eq('escrow_id', escrowId);
  if (error) console.error(`[supabase] setPayoutSuccessful failed for ${escrowId}: ${error.message}`);
}

/**
 * Fetch all SETTLED escrows whose payout has not been confirmed (recovery set).
 */
async function getSettledUnpaidEscrows() {
  const db = supabase();
  const { data, error } = await db
    .from('escrow_instances')
    .select('*')
    .eq('state', 'SETTLED')
    .eq('payout_successful', false);
  if (error) throw new Error(`[supabase] getSettledUnpaidEscrows failed: ${error.message}`);
  return data ?? [];
}

/**
 * Fetch all FUNDED escrows older than X days (auto-release candidates).
 */
async function getExpiredFundedEscrows(days = 3) {
  const db = supabase();
  const threshold = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();
  const { data, error } = await db
    .from('escrow_instances')
    .select('*')
    .eq('state', 'FUNDED')
    .lt('updated_at', threshold);
  if (error) throw new Error(`[supabase] getExpiredFundedEscrows failed: ${error.message}`);
  return data ?? [];
}

/**
 * Fetch all PENDING_FUNDING escrows older than X hours (zombie cleanup).
 */
async function getExpiredPendingEscrows(hours = 24) {
  const db = supabase();
  const threshold = new Date(Date.now() - (hours * 60 * 60 * 1000)).toISOString();
  const { data, error } = await db
    .from('escrow_instances')
    .select('*')
    .eq('state', 'PENDING_FUNDING')
    .lt('updated_at', threshold);
  if (error) throw new Error(`[supabase] getExpiredPendingEscrows failed: ${error.message}`);
  return data ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Operator-layer: list, file dispute, resolve dispute
// ─────────────────────────────────────────────────────────────────────────────

async function listEscrowInstances({ state, limit, offset } = {}) {
  const db = supabase();
  let q = db.from('escrow_instances').select('*');
  if (state) q = q.eq('state', state);
  q = q.order('created_at', { ascending: false });
  if (limit) q = q.limit(limit);
  if (offset) q = q.range(offset, offset + (limit || 50) - 1);
  const { data, error } = await q;
  if (error) throw new Error(`[supabase] listEscrowInstances failed: ${error.message}`);
  return data ?? [];
}

async function fileDispute(escrowId, { disputeClass, summary, openedBy }) {
  await transitionState(escrowId, 'FUNDED', 'DISPUTED', {
    dispute_class:   disputeClass,
    dispute_summary: summary ?? '',
    dispute_opened_by: openedBy,
  });
  return getEscrowInstance(escrowId);
}

async function resolveDispute(escrowId, { outcome, resolutionMode, note }) {
  if (outcome === 'release') {
    await transitionState(escrowId, 'DISPUTED', 'SETTLED', {
      dispute_resolution_mode: resolutionMode,
      dispute_resolution_note: note ?? '',
    });
  } else if (outcome === 'refund') {
    await transitionState(escrowId, 'DISPUTED', 'CANCELLED', {
      dispute_resolution_mode: resolutionMode,
      dispute_resolution_note: note ?? '',
    });
  } else {
    throw new ValidationError(`outcome must be "release" or "refund", got "${outcome}"`);
  }
  return getEscrowInstance(escrowId);
}

module.exports = {
  supabase,
  StateConflictError,
  NotFoundError,
  ValidationError,
  VALID_TRANSITIONS,
  createEscrowInstance,
  getEscrowInstance,
  joinEscrowInstance,
  setFundingInvoice,
  transitionState,
  transitionEscrowState,
  setReleaseDecision,
  setPayoutSuccessful,
  getSettledUnpaidEscrows,
  getExpiredFundedEscrows,
  getExpiredPendingEscrows,
  listEscrowInstances,
  fileDispute,
  resolveDispute,
};
