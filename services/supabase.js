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
  created:          ['created', 'partially_funded', 'active', 'canceled'],
  partially_funded: ['partially_funded', 'active', 'canceled'],
  active:           ['release_pending', 'released', 'refunded', 'disputed'],
  release_pending:  ['released', 'refunded', 'disputed'],
  disputed:         ['released', 'refunded'],
  released:         [],
  refunded:         [],
  canceled:         [],
});

// ─────────────────────────────────────────────────────────────────────────────
// Escrow instance helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new escrow instance in state created.
 * `creator_pubkey` is the authenticated Nostr pubkey of the participant who
 * called `create`. In single_funder mode the creator is the funder.
 * fundingThreshold and participantCount are stored for two_party / m_of_n.
 */
async function createEscrowInstance({
  creatorPubkey,
  amountSats,
  platformFeeSats,
  description,
  fundingModel,
  fundingThreshold,
  participantCount,
  refundLnAddress,
  idempotencyKey,
}) {
  const db = supabase();

  // Idempotency: return a matching non-terminal escrow. Terminal escrows
  // and escrows past their funding deadline do not block reuse of the key.
  if (idempotencyKey) {
    const { data: existing } = await db
      .from('escrow_instances')
      .select('*')
      .eq('idempotency_key', idempotencyKey)
      .eq('creator_pubkey', creatorPubkey)
      .not('state', 'in', '(released,refunded,canceled)')
      .gt('funding_deadline', new Date().toISOString())
      .maybeSingle();
    if (existing) return { ...existing, _idempotent: true };
  }

  const { data, error } = await db
    .from('escrow_instances')
    .insert({
      creator_pubkey:    creatorPubkey,
      amount_sats:       amountSats,
      platform_fee_sats: platformFeeSats,
      description:       description ?? '',
      funding_model:     fundingModel,
      funding_threshold: fundingThreshold ?? null,
      participant_count: participantCount ?? null,
      refund_ln_address: refundLnAddress ?? null,
      idempotency_key:   idempotencyKey ?? null,
      funding_deadline:  new Date(Date.now() + config.FUNDING_TIMEOUT_SECONDS * 1000).toISOString(),
      state:             'created',
    })
    .select()
    .single();

  if (error?.code === '23505' && idempotencyKey) {
    const { data: existing, error: fetchError } = await db.from('escrow_instances')
      .select('*')
      .eq('creator_pubkey', creatorPubkey)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (fetchError || !existing) {
      throw new Error(`[supabase] createEscrowInstance recovery failed: ${fetchError?.message || 'row unavailable'}`);
    }
    return { ...existing, _idempotent: true };
  }
  if (error) throw new Error(`[supabase] createEscrowInstance failed: ${error.message}`);
  return data;
}

async function createEnrollment(escrowId) {
  const token = crypto.randomUUID().replace(/-/g, '');
  const tokenHash = require('crypto').createHash('sha256').update(token).digest('hex');
  const { error } = await supabase().from('escrow_enrollments').insert({
    escrow_id: escrowId,
    token_hash: tokenHash,
    enrollment_token: token,
    participant_pubkey: null,
  });
  if (error) throw new Error(`[supabase] createEnrollment failed: ${error.message}`);
  return token;
}

async function listEnrollments(escrowId) {
  const { data, error } = await supabase().from('escrow_enrollments')
    .select('participant_pubkey,enrollment_token,redeemed_at').eq('escrow_id', escrowId);
  if (error) throw new Error(`[supabase] listEnrollments failed: ${error.message}`);
  return data ?? [];
}

async function claimEnrollment(token, participantPubkey) {
  const tokenHash = require('crypto').createHash('sha256').update(token).digest('hex');
  const db = supabase();
  const { data: enrollment, error: fetchError } = await db
    .from('escrow_enrollments')
    .select()
    .eq('token_hash', tokenHash)
    .is('redeemed_at', null)
    .maybeSingle();
  if (fetchError) throw new Error(`[supabase] claimEnrollment lookup failed: ${fetchError.message}`);
  if (!enrollment || (enrollment.participant_pubkey && enrollment.participant_pubkey !== participantPubkey)) {
    throw new ValidationError('invalid, already-used, or signer-mismatched enrollment token');
  }

  const wasPrebound = Boolean(enrollment.participant_pubkey);
  const redeemedAt = new Date().toISOString();
  let update = db.from('escrow_enrollments')
    .update({ participant_pubkey: participantPubkey, redeemed_at: redeemedAt })
    .eq('token_hash', tokenHash)
    .is('redeemed_at', null);
  update = wasPrebound
    ? update.eq('participant_pubkey', participantPubkey)
    : update.is('participant_pubkey', null);
  const { data, error } = await update.select().maybeSingle();
  if (error) throw new Error(`[supabase] claimEnrollment failed: ${error.message}`);
  if (!data) throw new ValidationError('invalid or already-used enrollment token');

  return { escrow: await getEscrowInstance(data.escrow_id), tokenHash, participantPubkey, redeemedAt, wasPrebound };
}

async function releaseEnrollmentClaim({ tokenHash, participantPubkey, redeemedAt, wasPrebound }) {
  const updates = wasPrebound
    ? { redeemed_at: null }
    : { participant_pubkey: null, redeemed_at: null };
  const { error } = await supabase().from('escrow_enrollments')
    .update(updates)
    .eq('token_hash', tokenHash)
    .eq('participant_pubkey', participantPubkey)
    .eq('redeemed_at', redeemedAt);
  if (error) throw new Error(`[supabase] releaseEnrollmentClaim failed: ${error.message}`);
}

async function consumeDecisionNonce(escrowId, nonce) {
  const { error } = await supabase().from('escrow_decision_nonces').insert({ escrow_id: escrowId, nonce });
  if (error && error.code === '23505') throw new ValidationError('release decision nonce has already been used');
  if (error) throw new Error(`[supabase] consumeDecisionNonce failed: ${error.message}`);
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
 * Counterparty joins an escrow instance after a signer-bound enrollment token
 * has been consumed by the caller.
 *
 * For single_funder: one counterparty joins.
 * For two_party: one counterparty joins (2 participants total).
 * For m_of_n: multiple participants may join until participant_count is reached.
 *             Each joiner is recorded as a funder row.
 */
async function joinEscrowInstance(escrowId, joinerPubkey, payoutLnAddress) {
  const db = supabase();
  const { data: existing, error: fetchErr } = await db
    .from('escrow_instances')
    .select('*')
    .eq('escrow_id', escrowId)
    .maybeSingle();
  if (fetchErr) throw new Error(`[supabase] joinEscrowInstance fetch failed: ${fetchErr.message}`);
  if (!existing) throw new NotFoundError('Escrow instance', escrowId);

  if (existing.state !== 'created') throw new StateConflictError(escrowId, 'created');
  if (existing.creator_pubkey === joinerPubkey) throw new ValidationError('Creator cannot join their own escrow as a counterparty.');

  const model = existing.funding_model;

  // single_funder & two_party: single counterparty slot.
  if (model === 'single_funder' || model === 'two_party') {
    if (existing.counterparty_pubkey) throw new ValidationError('Escrow instance already has a counterparty.');

    // Seed funder rows before the escrow update so a seeding failure
    // does not leave a half-joined escrow (counterparty set, no funder rows).
    if (model === 'two_party') {
      await seedFunderRow(db, escrowId, existing.creator_pubkey, 'creator',
        existing.amount_sats, existing.platform_fee_sats, existing.refund_ln_address, existing.payout_ln_address);
      await seedFunderRow(db, escrowId, joinerPubkey, 'counterparty',
        existing.amount_sats, existing.platform_fee_sats, null, payoutLnAddress ?? null);
    }

    const { data, error } = await db
      .from('escrow_instances')
      .update({
        counterparty_pubkey: joinerPubkey,
        payout_ln_address:   payoutLnAddress ?? null,
        state:               'created',
        updated_at:          new Date().toISOString(),
      })
      .eq('escrow_id', escrowId)
      .eq('state', 'created')
      .is('counterparty_pubkey', null)
      .select()
      .maybeSingle();

    if (error) throw new Error(`[supabase] joinEscrowInstance failed: ${error.message}`);
    if (!data) throw new StateConflictError(escrowId, 'created');

    return data;
  }

  // m_of_n: multiple participants. Counterparty field holds the last joiner,
  // but all participants are tracked in escrow_funders.
  if (model === 'm_of_n') {
    const maxParticipants = existing.participant_count || 0;

    // Seed creator funder row on first join if not yet present.
    await seedFunderRow(db, escrowId, existing.creator_pubkey, 'creator',
      existing.amount_sats, existing.platform_fee_sats, existing.refund_ln_address, existing.payout_ln_address);

    // Refresh funder snapshot after seeding so the count is accurate.
    const { data: existingFunders } = await db
      .from('escrow_funders')
      .select('funder_pubkey')
      .eq('escrow_id', escrowId);
    const funderList = existingFunders ?? [];
    const currentCount = funderList.length;

    if (currentCount >= maxParticipants) {
      throw new ValidationError(`Escrow instance already has ${maxParticipants} participants.`);
    }
    // Prevent duplicate joins (checked against fresh snapshot)
    if (funderList.some(f => f.funder_pubkey === joinerPubkey)) {
      throw new ValidationError('This pubkey has already joined this escrow instance.');
    }

    await seedFunderRow(db, escrowId, joinerPubkey, 'counterparty',
      existing.amount_sats, existing.platform_fee_sats, null, payoutLnAddress ?? null);

    const { data, error } = await db
      .from('escrow_instances')
      .update({
        counterparty_pubkey: joinerPubkey,
        payout_ln_address:   payoutLnAddress ?? null,
        state:              'created',
        updated_at:         new Date().toISOString(),
      })
      .eq('escrow_id', escrowId)
      .eq('state', 'created')
      .select()
      .maybeSingle();

    if (error) throw new Error(`[supabase] joinEscrowInstance (m_of_n) failed: ${error.message}`);
    if (!data) throw new StateConflictError(escrowId, 'created');
    return data;
  }

  throw new ValidationError(`Unknown funding model: ${model}`);
}

async function seedFunderRow(db, escrowId, funderPubkey, role, amountSats, platformFeeSats, refundLnAddress, payoutLnAddress) {
  const { error } = await db
    .from('escrow_funders')
    .insert({
      escrow_id:           escrowId,
      funder_pubkey:       funderPubkey,
      funder_role:         role,
      amount_sats:         amountSats,
      platform_fee_sats:   platformFeeSats,
      refund_ln_address:   refundLnAddress ?? null,
      payout_ln_address:   payoutLnAddress ?? null,
    });
  if (error) {
    // unique-constraint violation (code 23505) = already seeded; safe to ignore
    if (error.code !== '23505') {
      throw new Error(`[supabase] seedFunderRow failed: ${error.message}`);
    }
  }
}

/**
 * Stamp the funding invoice onto an instance in the funding phase.
 * instance. Uses a self-transition so it is safe to retry.
 * For single_funder the invoice is stamped directly on the escrow row.
 */
async function setFundingInvoice(escrowId, paymentHash, paymentRequest) {
  return transitionState(escrowId, 'created', 'created', {
    blink_payment_hash: paymentHash,
    blink_payment_request: paymentRequest,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Funder-level operations (two_party / m_of_n)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get or create a funder row for a specific participant.
 */
async function getFunderRow(escrowId, funderPubkey) {
  const db = supabase();
  const { data, error } = await db
    .from('escrow_funders')
    .select('*')
    .eq('escrow_id', escrowId)
    .eq('funder_pubkey', funderPubkey)
    .maybeSingle();
  if (error) throw new Error(`[supabase] getFunderRow failed: ${error.message}`);
  return data;
}

/**
 * Stamp a BOLT11 invoice onto a specific funder row. Idempotent.
 */
async function setFunderInvoice(escrowId, funderPubkey, paymentHash, paymentRequest) {
  const db = supabase();
  const { data, error } = await db
    .from('escrow_funders')
    .update({
      blink_payment_hash:    paymentHash,
      blink_payment_request: paymentRequest,
      updated_at:            new Date().toISOString(),
    })
    .eq('escrow_id', escrowId)
    .eq('funder_pubkey', funderPubkey)
    .select()
    .single();
  if (error) throw new Error(`[supabase] setFunderInvoice failed: ${error.message}`);
  return data;
}

/**
 * Mark a specific funder row as funded.
 */
async function setFunderFunded(escrowId, funderPubkey) {
  const db = supabase();
  const { data, error } = await db
    .from('escrow_funders')
    .update({
      funded:     true,
      funded_at:  new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('escrow_id', escrowId)
    .eq('funder_pubkey', funderPubkey)
    .eq('funded', false)
    .select()
    .maybeSingle();
  if (error) throw new Error(`[supabase] setFunderFunded failed: ${error.message}`);
  return data;
}

/**
 * List all funder rows for an escrow instance.
 */
async function listFunders(escrowId) {
  const db = supabase();
  const { data, error } = await db
    .from('escrow_funders')
    .select('*')
    .eq('escrow_id', escrowId);
  if (error) throw new Error(`[supabase] listFunders failed: ${error.message}`);
  return data ?? [];
}

/**
 * Count funded vs total funders for an escrow instance.
 */
async function getFunderStats(escrowId) {
  const funders = await listFunders(escrowId);
  const fundedCount = funders.filter(f => f.funded).length;
  const totalCount = funders.length;
  return { fundedCount, totalCount, funders };
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
 * Atomically claim an escrow payout before sending it.
 * Returns the updated row when the claim succeeds, or null when another process already owns the claim.
 */
async function claimPayoutAttempt(escrowId, leaseSeconds = 600) {
  const db = supabase();
  const { data, error } = await db.rpc('claim_payout_attempt', {
    p_escrow_id: escrowId,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw new Error(`[supabase] claimPayoutAttempt failed for ${escrowId}: ${error.message}`);
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

/**
 * Fetch all released escrows whose payout has not been confirmed (recovery set).
 */
async function getSettledUnpaidEscrows() {
  const db = supabase();
  const { data, error } = await db
    .from('escrow_instances')
    .select('*')
    .eq('state', 'released')
    .eq('payout_successful', false);
  if (error) throw new Error(`[supabase] getSettledUnpaidEscrows failed: ${error.message}`);
  return data ?? [];
}

/**
 * Fetch funding-phase escrows whose declared deadline has elapsed.
 */
async function getExpiredPendingEscrows() {
  const db = supabase();
  const { data, error } = await db
    .from('escrow_instances')
    .select('*')
    .in('state', ['created', 'partially_funded'])
    .lt('funding_deadline', new Date().toISOString());
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
  const escrow = await getEscrowInstance(escrowId);
  if (!['active', 'release_pending'].includes(escrow.state)) {
    throw new ValidationError(`disputes can only be filed on an active or release_pending escrow; escrow is ${escrow.state}`);
  }
  await transitionState(escrowId, escrow.state, 'disputed', {
    dispute_class:   disputeClass,
    dispute_summary: summary ?? '',
    dispute_opened_by: openedBy,
  });
  return getEscrowInstance(escrowId);
}

async function resolveDispute(escrowId, { outcome, resolutionMode, note }) {
  if (outcome === 'release') {
    await transitionState(escrowId, 'disputed', 'released', {
      dispute_resolution_mode: resolutionMode,
      dispute_resolution_note: note ?? '',
    });
  } else if (outcome === 'refund') {
    await transitionState(escrowId, 'disputed', 'refunded', {
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
  createEnrollment,
  listEnrollments,
  claimEnrollment,
  releaseEnrollmentClaim,
  consumeDecisionNonce,
  setFundingInvoice,
  transitionState,
  transitionEscrowState,
  setReleaseDecision,
  setPayoutSuccessful,
  claimPayoutAttempt,
  getSettledUnpaidEscrows,
  getExpiredPendingEscrows,
  listEscrowInstances,
  fileDispute,
  resolveDispute,
  // Funder-level operations (two_party / m_of_n)
  getFunderRow,
  setFunderInvoice,
  setFunderFunded,
  listFunders,
  getFunderStats,
};
