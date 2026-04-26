'use strict';

const { createClient } = require('@supabase/supabase-js');
const { config } = require('../config/env');

// ─────────────────────────────────────────────────────────────────────────────
// Client (singleton)
// ─────────────────────────────────────────────────────────────────────────────

const supabase = createClient(
  config.SUPABASE_PROJECT_URL,
  config.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// SQL: paste into Supabase SQL editor — run ONCE
// ─────────────────────────────────────────────────────────────────────────────
/*
  -- 1. Schema migration
  ALTER TABLE escrows
    ADD COLUMN IF NOT EXISTS payout_successful BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ DEFAULT NOW();

  -- 2. Atomic state-transition RPC
  CREATE OR REPLACE FUNCTION transition_escrow_state(
    p_escrow_id      UUID,
    p_expected_state TEXT,
    p_new_state      TEXT,
    p_extra          JSONB DEFAULT '{}'::JSONB
  )
  RETURNS SETOF escrows
  LANGUAGE plpgsql
  SECURITY DEFINER
  AS $$
  BEGIN
    RETURN QUERY
    UPDATE escrows
    SET
      state              = p_new_state,
      blink_payment_hash = COALESCE((p_extra->>'blink_payment_hash'), blink_payment_hash),
      updated_at         = NOW()
    WHERE
      escrow_id = p_escrow_id
      AND state = p_expected_state
    RETURNING *;
  END;
  $$;

  -- 3. Atomic counter increment (whitelisted columns only)
  CREATE OR REPLACE FUNCTION increment_user_counter(
    p_telegram_id TEXT,
    p_column      TEXT
  )
  RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  AS $$
  BEGIN
    IF p_column NOT IN ('completed_trades', 'disputed_trades') THEN
      RAISE EXCEPTION 'Invalid column name: %', p_column;
    END IF;
    EXECUTE format(
      'UPDATE users SET %I = %I + 1 WHERE telegram_id = $1',
      p_column, p_column
    ) USING p_telegram_id;
  END;
  $$;
*/

// ─────────────────────────────────────────────────────────────────────────────
// Custom error types
// ─────────────────────────────────────────────────────────────────────────────

class StateConflictError extends Error {
  constructor(escrowId, expectedState) {
    super(
      `Escrow ${escrowId} was not in state "${expectedState}" — possible concurrent modification.`
    );
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

// ─────────────────────────────────────────────────────────────────────────────
// Valid state machine transitions
// ─────────────────────────────────────────────────────────────────────────────

const VALID_TRANSITIONS = Object.freeze({
  CREATED:         ['PENDING_FUNDING', 'CANCELLED'],
  // PENDING_FUNDING → PENDING_FUNDING is a valid "self-transition" used
  // exclusively to stamp the blink_payment_hash after invoice creation.
  PENDING_FUNDING: ['PENDING_FUNDING', 'FUNDED', 'CANCELLED'],
  FUNDED:          ['SETTLED', 'DISPUTED', 'CANCELLED'],
  DISPUTED:        ['SETTLED', 'CANCELLED'],
  SETTLED:         [], // terminal
  CANCELLED:       [], // terminal
});

// ─────────────────────────────────────────────────────────────────────────────
// User helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upsert a user — called on every interaction to keep username fresh.
 * Does NOT overwrite completed_trades or disputed_trades.
 */
async function upsertUser(telegramId, username) {
  const { data, error } = await supabase
    .from('users')
    .upsert(
      { telegram_id: String(telegramId), username: username ?? null },
      { onConflict: 'telegram_id', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (error) throw new Error(`[supabase] upsertUser failed: ${error.message}`);
  return data;
}

/**
 * Fetch a user by Telegram ID.
 * @throws {NotFoundError}
 */
async function getUserByTelegramId(telegramId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', String(telegramId))
    .single();

  if (error?.code === 'PGRST116') throw new NotFoundError('User', telegramId);
  if (error) throw new Error(`[supabase] getUserByTelegramId failed: ${error.message}`);
  return data;
}

/** Save or update a user's default Lightning Address. */
async function setDefaultLnAddress(telegramId, lnAddress) {
  const { data, error } = await supabase
    .from('users')
    .update({ default_ln_address: lnAddress })
    .eq('telegram_id', String(telegramId))
    .select()
    .single();

  if (error) throw new Error(`[supabase] setDefaultLnAddress failed: ${error.message}`);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Escrow helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new escrow in state 'CREATED'.
 * `payout_successful` defaults to false at the DB level.
 */
async function createEscrow({
  creatorId,
  creatorRole,
  amountSats,
  platformFeeSats,
  tradeDescription,
}) {
  const { data, error } = await supabase
    .from('escrows')
    .insert({
      creator_id:        String(creatorId),
      creator_role:      creatorRole,
      amount_sats:       amountSats,
      platform_fee_sats: platformFeeSats,
      trade_description: tradeDescription,
      state:             'CREATED',
    })
    .select()
    .single();

  if (error) throw new Error(`[supabase] createEscrow failed: ${error.message}`);
  return data;
}

/**
 * Fetch an escrow by UUID, with joined user rows for creator and invitee.
 * @throws {NotFoundError}
 */
async function getEscrowById(escrowId) {
  const { data, error } = await supabase
    .from('escrows')
    .select('*, creator:users!creator_id(*), invitee:users!invitee_id(*)')
    .eq('escrow_id', escrowId)
    .single();

  if (error?.code === 'PGRST116') throw new NotFoundError('Escrow', escrowId);
  if (error) throw new Error(`[supabase] getEscrowById failed: ${error.message}`);
  return data;
}

/**
 * Update escrow amount and platform fee while escrow is still in CREATED state.
 * This prevents amount changes once a counterparty has joined or funds are in play.
 */
async function updateEscrowAmount(escrowId, amountSats, platformFeeSats) {
  const escrow = await getEscrowById(escrowId);
  if (escrow.state !== 'CREATED') {
    throw new StateConflictError(escrowId, 'CREATED');
  }

  const { data, error } = await supabase
    .from('escrows')
    .update({
      amount_sats: amountSats,
      platform_fee_sats: platformFeeSats,
      updated_at: new Date().toISOString(),
    })
    .eq('escrow_id', escrowId)
    .select('*, creator:users!creator_id(*), invitee:users!invitee_id(*)')
    .single();

  if (error) throw new Error(`[supabase] updateEscrowAmount failed: ${error.message}`);
  return data;
}

/**
 * Claim the invitee slot.  Validates CREATED state, no existing invitee,
 * and prevents self-invite — all before the UPDATE so the failure is
 * informative rather than a silent constraint violation.
 */
async function setEscrowInvitee(escrowId, inviteeTelegramId) {
  const escrow = await getEscrowById(escrowId);
  if (escrow.state !== 'CREATED')              throw new StateConflictError(escrowId, 'CREATED');
  if (escrow.invitee_id)                        throw new Error(`[supabase] Escrow ${escrowId} already has an invitee.`);
  if (escrow.creator_id === String(inviteeTelegramId)) throw new Error('[supabase] Creator cannot be their own counterparty.');

  const { data, error } = await supabase
    .from('escrows')
    .update({ invitee_id: String(inviteeTelegramId) })
    .eq('escrow_id', escrowId)
    .select()
    .single();

  if (error) throw new Error(`[supabase] setEscrowInvitee failed: ${error.message}`);
  return data;
}

/**
 * ATOMIC state transition via the `transition_escrow_state` Postgres RPC.
 *
 * The RPC runs UPDATE … WHERE state = p_expected_state RETURNING *.
 * An empty result means a race condition won — we throw StateConflictError.
 *
 * @param {string} escrowId
 * @param {string} expectedState - Escrow MUST be in this state right now.
 * @param {string} newState      - Target state.
 * @param {object} [extra={}]    - Optional extra fields (e.g. { blink_payment_hash }).
 * @throws {StateConflictError}
 */
async function transitionEscrowState(escrowId, expectedState, newState, extra = {}) {
  const allowed = VALID_TRANSITIONS[expectedState] ?? [];
  if (!allowed.includes(newState)) {
    throw new Error(`[supabase] Invalid state transition: ${expectedState} → ${newState}`);
  }

  const { data, error } = await supabase.rpc('transition_escrow_state', {
    p_escrow_id:      escrowId,
    p_expected_state: expectedState,
    p_new_state:      newState,
    p_extra:          extra,
  });

  if (error) throw new Error(`[supabase] transitionEscrowState RPC failed: ${error.message}`);
  if (!data || data.length === 0) throw new StateConflictError(escrowId, expectedState);

  return data[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Payout tracking (v2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark an escrow's payout as successful.
 * Called immediately after a confirmed Lightning payment to the seller.
 * This is a simple UPDATE — no state machine involved — so it is safe to call
 * multiple times (idempotent by nature of setting a boolean to true).
 *
 * @param {string} escrowId
 */
async function setPayoutSuccessful(escrowId) {
  const { error } = await supabase
    .from('escrows')
    .update({ payout_successful: true, updated_at: new Date().toISOString() })
    .eq('escrow_id', escrowId);

  if (error) {
    // Non-fatal log — the payment already happened; we must not throw here
    // in case the caller is mid-notification sequence.
    console.error(`[supabase] setPayoutSuccessful failed for ${escrowId}: ${error.message}`);
  }
}

/**
 * Fetch all escrows that are SETTLED but whose payout has not been confirmed.
 *
 * These rows indicate the bot crashed (or Blink timed out) after the state
 * transition but before the payment was confirmed.  The startup recovery
 * routine will iterate over them and re-attempt payouts.
 *
 * Includes joined creator/invitee user rows so the recovery routine has
 * access to saved Lightning Addresses without extra queries.
 *
 * @returns {Promise<object[]>}
 */
async function getSettledUnpaidEscrows() {
  const { data, error } = await supabase
    .from('escrows')
    .select('*, creator:users!creator_id(*), invitee:users!invitee_id(*)')
    .eq('state', 'SETTLED')
    .eq('payout_successful', false);

  if (error) throw new Error(`[supabase] getSettledUnpaidEscrows failed: ${error.message}`);
  return data ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade counter helpers
// ─────────────────────────────────────────────────────────────────────────────

async function incrementCompletedTrades(telegramId) {
  const { error } = await supabase.rpc('increment_user_counter', {
    p_telegram_id: String(telegramId),
    p_column:      'completed_trades',
  });
  if (error) console.error('[supabase] incrementCompletedTrades failed:', error.message);
}

async function incrementDisputedTrades(telegramId) {
  const { error } = await supabase.rpc('increment_user_counter', {
    p_telegram_id: String(telegramId),
    p_column:      'disputed_trades',
  });
  if (error) console.error('[supabase] incrementDisputedTrades failed:', error.message);
}
/**
 * Fetch all escrows in FUNDED state that are older than X days.
 */
async function getExpiredFundedEscrows(days = 3) {
  const thresholdDate = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();
  const { data, error } = await supabase
    .from('escrows')
    .select('*, creator:users!creator_id(*), invitee:users!invitee_id(*)')
    .eq('state', 'FUNDED')
    .lt('updated_at', thresholdDate);
  if (error) throw new Error(`[supabase] getExpiredFundedEscrows failed: ${error.message}`);
  return data ?? [];
}

/**
 * Fetch all unpaid escrows (PENDING_FUNDING) older than X hours.
 */
async function getExpiredPendingEscrows(hours = 24) {
  const thresholdDate = new Date(Date.now() - (hours * 60 * 60 * 1000)).toISOString();
  const { data, error } = await supabase
    .from('escrows')
    .select('*')
    .eq('state', 'PENDING_FUNDING')
    .lt('updated_at', thresholdDate);
  if (error) throw new Error(`[supabase] getExpiredPendingEscrows failed: ${error.message}`);
  return data ?? [];
}
// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  supabase,
  StateConflictError,
  NotFoundError,
  VALID_TRANSITIONS,
  // User
  upsertUser,
  getUserByTelegramId,
  setDefaultLnAddress,
  // Escrow
  createEscrow,
  getEscrowById,
  updateEscrowAmount,
  setEscrowInvitee,
  transitionEscrowState,
  // Payout tracking
  setPayoutSuccessful,
  getSettledUnpaidEscrows,
  // Counters
  incrementCompletedTrades,
  incrementDisputedTrades,
  // Expiry cleanup
  getExpiredFundedEscrows,
  getExpiredPendingEscrows,
};