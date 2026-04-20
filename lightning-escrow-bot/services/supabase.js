/**
 * services/supabase.js
 *
 * Supabase client initialisation plus all database access functions used by
 * the bot.  Nothing outside this file should import the raw `supabase` client
 * — all DB work goes through the typed helpers below.
 *
 * KEY DESIGN DECISIONS
 * ─────────────────────
 * 1. ATOMIC STATE TRANSITIONS
 *    Every state change uses a Postgres RPC function (`transition_escrow_state`)
 *    that runs an `UPDATE … WHERE state = expected_state RETURNING *` inside a
 *    single statement.  Because Postgres executes this atomically, two
 *    concurrent requests can never both "win" the same transition — only the
 *    first UPDATE will match the row; the second will see 0 rows returned and
 *    we throw a `StateConflictError`.
 *
 *    The SQL for the RPC is provided in a comment block below so you can paste
 *    it into the Supabase SQL editor once and never touch it again.
 *
 * 2. SERVICE ROLE KEY
 *    We use the service-role key (bypasses RLS) because the bot is the sole
 *    trusted actor.  Never expose this key to the frontend.
 *
 * 3. ERROR TYPES
 *    `StateConflictError`  — thrown when a concurrent request already moved
 *                            the escrow out of the expected state.
 *    `NotFoundError`       — thrown when a lookup returns no row.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const { config } = require('../config/env');

// ─────────────────────────────────────────────────────────────────────────────
// Supabase client (singleton)
// ─────────────────────────────────────────────────────────────────────────────

const supabase = createClient(
  config.SUPABASE_PROJECT_URL,
  config.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      // The service-role key doesn't need session management.
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// SQL you must run ONCE in the Supabase SQL editor
// ─────────────────────────────────────────────────────────────────────────────
/*
  -- Atomic escrow state transition function.
  -- Only updates the row when the current state matches `p_expected_state`.
  -- Returns the updated row or NULL if the state didn't match (race condition).

  CREATE OR REPLACE FUNCTION transition_escrow_state(
    p_escrow_id      UUID,
    p_expected_state TEXT,
    p_new_state      TEXT,
    p_extra          JSONB DEFAULT '{}'::JSONB
  )
  RETURNS SETOF escrows
  LANGUAGE plpgsql
  SECURITY DEFINER          -- runs as the function owner, not the caller
  AS $$
  BEGIN
    RETURN QUERY
    UPDATE escrows
    SET
      state                = p_new_state,
      blink_payment_hash   = COALESCE((p_extra->>'blink_payment_hash'), blink_payment_hash),
      updated_at           = NOW()
    WHERE
      escrow_id = p_escrow_id
      AND state = p_expected_state
    RETURNING *;
  END;
  $$;

  -- Make sure your escrows table also has an `updated_at` column:
  -- ALTER TABLE escrows ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
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
// Valid state machine transitions (for documentation / assertion use)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All legal (fromState → toState) transitions.
 * The bot code must only call transitionEscrowState() with these pairs.
 */
const VALID_TRANSITIONS = Object.freeze({
  CREATED:         ['PENDING_FUNDING', 'CANCELLED'],
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
 * Upsert a user record.  Called on every /start to keep username fresh.
 *
 * @param {string} telegramId   - Telegram numeric user ID (stored as string).
 * @param {string} username     - Telegram @username (may be undefined).
 * @returns {Promise<object>}   - The upserted user row.
 */
async function upsertUser(telegramId, username) {
  const { data, error } = await supabase
    .from('users')
    .upsert(
      {
        telegram_id: String(telegramId),
        username: username ?? null,
        // completed_trades and disputed_trades have DB defaults (0).
        // created_at has a DB default (NOW()).
      },
      {
        onConflict: 'telegram_id',
        // Only refresh username on conflict — don't clobber trade counters.
        ignoreDuplicates: false,
      }
    )
    .select()
    .single();

  if (error) throw new Error(`[supabase] upsertUser failed: ${error.message}`);
  return data;
}

/**
 * Fetch a single user by Telegram ID.
 *
 * @param {string} telegramId
 * @returns {Promise<object>}
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

/**
 * Save (or update) a user's default Lightning Address.
 *
 * @param {string} telegramId
 * @param {string} lnAddress  - e.g. alice@blink.sv
 * @returns {Promise<object>}
 */
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
 * Create a new escrow record in state 'CREATED'.
 *
 * @param {{
 *   creatorId:        string,
 *   creatorRole:      'Buyer' | 'Seller',
 *   amountSats:       number,
 *   platformFeeSats:  number,
 *   tradeDescription: string,
 * }} params
 * @returns {Promise<object>} - The newly created escrow row (includes escrow_id UUID).
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
      // escrow_id is a UUID generated by Postgres (gen_random_uuid() default).
      creator_id:        String(creatorId),
      creator_role:      creatorRole,
      amount_sats:       amountSats,
      platform_fee_sats: platformFeeSats,
      trade_description: tradeDescription,
      state:             'CREATED',
      // invitee_id and blink_payment_hash are NULL until the counterparty joins
      // and the invoice is generated.
    })
    .select()
    .single();

  if (error) throw new Error(`[supabase] createEscrow failed: ${error.message}`);
  return data;
}

/**
 * Fetch a single escrow by its UUID primary key.
 *
 * @param {string} escrowId - UUID
 * @returns {Promise<object>}
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
 * Set the invitee once the counterparty accepts the invite link.
 * Only valid when escrow is in state 'CREATED'.
 *
 * @param {string} escrowId
 * @param {string} inviteeTelegramId
 * @returns {Promise<object>} - Updated escrow row.
 */
async function setEscrowInvitee(escrowId, inviteeTelegramId) {
  // First confirm the escrow is still CREATED (not already claimed / cancelled).
  const escrow = await getEscrowById(escrowId);
  if (escrow.state !== 'CREATED') {
    throw new StateConflictError(escrowId, 'CREATED');
  }
  if (escrow.invitee_id) {
    throw new Error(`[supabase] Escrow ${escrowId} already has an invitee.`);
  }
  if (escrow.creator_id === String(inviteeTelegramId)) {
    throw new Error('[supabase] Creator cannot be their own counterparty.');
  }

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
 * ATOMIC state transition via the Postgres RPC function.
 *
 * This is the ONLY function that may change escrow.state.  It calls the
 * `transition_escrow_state` RPC which does an atomic
 * `UPDATE … WHERE state = p_expected_state RETURNING *`.
 *
 * If the row is not in expectedState (race condition), the RPC returns 0 rows
 * and we throw StateConflictError to the caller.
 *
 * @param {string}  escrowId        - UUID of the escrow to update.
 * @param {string}  expectedState   - The state the escrow MUST be in right now.
 * @param {string}  newState        - The state to transition to.
 * @param {object}  [extra={}]      - Optional extra fields to update simultaneously
 *                                    (e.g. { blink_payment_hash: '...' }).
 * @returns {Promise<object>}       - The updated escrow row.
 * @throws {StateConflictError}     - If the escrow was not in expectedState.
 */
async function transitionEscrowState(escrowId, expectedState, newState, extra = {}) {
  // Guard: developer-time assertion so we catch invalid transitions in testing.
  const allowed = VALID_TRANSITIONS[expectedState] ?? [];
  if (!allowed.includes(newState)) {
    throw new Error(
      `[supabase] Invalid state transition: ${expectedState} → ${newState}`
    );
  }

  const { data, error } = await supabase.rpc('transition_escrow_state', {
    p_escrow_id:      escrowId,
    p_expected_state: expectedState,
    p_new_state:      newState,
    p_extra:          extra,
  });

  if (error) throw new Error(`[supabase] transitionEscrowState RPC failed: ${error.message}`);

  // The RPC returns an array via SETOF.  Empty array = state didn't match.
  if (!data || data.length === 0) {
    throw new StateConflictError(escrowId, expectedState);
  }

  return data[0];
}

/**
 * Increment the completed_trades counter for a user atomically.
 * Called after a successful SETTLED transition.
 *
 * @param {string} telegramId
 */
async function incrementCompletedTrades(telegramId) {
  // Supabase doesn't expose `col + 1` directly in JS, so we use rpc or raw SQL.
  // Here we use a simple approach: fetch then update (acceptable since this is
  // a post-settlement non-critical stat update).
  const { error } = await supabase.rpc('increment_user_counter', {
    p_telegram_id: String(telegramId),
    p_column:      'completed_trades',
  });
  // Non-fatal: log but don't throw — the settlement already succeeded.
  if (error) console.error('[supabase] incrementCompletedTrades failed:', error.message);
}

/**
 * Increment the disputed_trades counter for a user atomically.
 * Called when an escrow enters DISPUTED state.
 *
 * @param {string} telegramId
 */
async function incrementDisputedTrades(telegramId) {
  const { error } = await supabase.rpc('increment_user_counter', {
    p_telegram_id: String(telegramId),
    p_column:      'disputed_trades',
  });
  if (error) console.error('[supabase] incrementDisputedTrades failed:', error.message);
}

/*
  ── SQL for increment_user_counter RPC ──────────────────────────────────────
  Paste into the Supabase SQL editor:

  CREATE OR REPLACE FUNCTION increment_user_counter(
    p_telegram_id TEXT,
    p_column      TEXT
  )
  RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  AS $$
  BEGIN
    -- Whitelist allowed column names to prevent SQL injection.
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
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  supabase,              // raw client, available for one-off queries in handlers
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
  setEscrowInvitee,
  transitionEscrowState,
  incrementCompletedTrades,
  incrementDisputedTrades,
};